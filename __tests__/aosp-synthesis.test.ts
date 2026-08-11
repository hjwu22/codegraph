import { describe, expect, it } from 'vitest';
import type { Language, Node, NodeKind } from '../src/types';
import type { ResolutionContext } from '../src/resolution/types';
import {
  aidlBinderSynthesizer,
  deviceTreeDriverSynthesizer,
  deviceTreeBindingSynthesizer,
  initServiceSynthesizer,
  jniSynthesizer,
  halVintfSynthesizer,
  selinuxBindingSynthesizer,
} from '../src/resolution/aosp-synthesizer';

function node(id: string, kind: NodeKind, name: string, qualifiedName: string, filePath: string, language: Language, signature?: string): Node {
  return {
    id, kind, name, qualifiedName, filePath, language,
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 1,
    signature, updatedAt: 1,
  };
}

function context(nodes: Node[], files: Record<string, string>): ResolutionContext {
  return {
    getNodesInFile: (file) => nodes.filter((n) => n.filePath === file),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (name) => nodes.filter((n) => n.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    iterateNodesByKind: function* (kind) { yield* nodes.filter((n) => n.kind === kind); },
    fileExists: (file) => file in files,
    readFile: (file) => files[file] ?? null,
    getFileLines: (file) => files[file]?.split(/\r?\n/) ?? null,
    getProjectRoot: () => '/repo',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (name) => nodes.filter((n) => n.name.toLowerCase() === name),
    getImportMappings: () => [],
  } as ResolutionContext;
}

describe('AOSP cross-language synthesis', () => {
  it('links a Java native method to its exact static JNI symbol', () => {
    const java = node('j', 'method', 'nativePing', 'com.acme.Demo::nativePing', 'Demo.java', 'java', 'private static native void nativePing()');
    const cpp = node('c', 'function', 'Java_com_acme_Demo_nativePing', 'Java_com_acme_Demo_nativePing', 'demo.cpp', 'cpp');
    const edges = jniSynthesizer.synthesize(context([java, cpp], {
      'Demo.java': 'private static native void nativePing();',
      'demo.cpp': 'JNIEXPORT void Java_com_acme_Demo_nativePing(JNIEnv*, jclass) {}',
    }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'j', target: 'c', kind: 'calls' }));
    expect(edges[0]?.metadata).toMatchObject({ synthesizedBy: 'aosp-jni', confidence: 'exact' });
  });

  it('uses long-name JNI descriptors to disambiguate overloads and refuses the short ambiguous form', () => {
    const intMethod = node('j-int', 'method', 'ping', 'com.acme.Demo::ping', 'Demo.java', 'java', 'private native void ping(int value)');
    const stringMethod = node('j-string', 'method', 'ping', 'com.acme.Demo::ping', 'Demo.java', 'java', 'private native void ping(String value)');
    const exactNative = node('c-exact', 'function', 'Java_com_acme_Demo_ping__I', 'Java_com_acme_Demo_ping__I', 'demo.cpp', 'cpp');
    const ambiguousNative = node('c-short', 'function', 'Java_com_acme_Demo_ping', 'Java_com_acme_Demo_ping', 'demo.cpp', 'cpp');
    const edges = jniSynthesizer.synthesize(context([intMethod, stringMethod, exactNative, ambiguousNative], {
      'Demo.java': 'private native void ping(int value);\nprivate native void ping(String value);',
      'demo.cpp': 'void Java_com_acme_Demo_ping__I() {}\nvoid Java_com_acme_Demo_ping() {}',
    }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'j-int', target: 'c-exact', kind: 'calls' }));
    expect(edges).not.toContainEqual(expect.objectContaining({ target: 'c-short' }));
    expect(edges).not.toContainEqual(expect.objectContaining({ source: 'j-string', target: 'c-exact' }));
  });

  it('links RegisterNatives entries using class, method, and function evidence', () => {
    const java = node('j', 'method', 'ping', 'com.acme.Demo::ping', 'Demo.java', 'java', 'native void ping(int value)');
    const cpp = node('c', 'function', 'native_ping', 'native_ping', 'demo.cpp', 'cpp');
    const edges = jniSynthesizer.synthesize(context([java, cpp], {
      'Demo.java': 'native void ping(int value);',
      'demo.cpp': `
        static void native_ping(JNIEnv*, jobject, jint) {}
        static const JNINativeMethod methods[] = { { "ping", "(I)V", (void*) native_ping } };
        RegisterMethodsOrDie(env, "com/acme/Demo", methods, 1);
      `,
    }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'j', target: 'c', kind: 'calls' }));
  });

  it('links a native JNI callback to Java only with class, method, and invocation evidence', () => {
    const java = node('j', 'method', 'onReady', 'com.acme.Listener::onReady', 'Listener.java', 'java', 'void onReady(int value)');
    const cpp = { ...node('c', 'function', 'notify_ready', 'notify_ready', 'demo.cpp', 'cpp'), endLine: 5 };
    const edges = jniSynthesizer.synthesize(context([java, cpp], {
      'Listener.java': 'void onReady(int value) {}',
      'demo.cpp': `void notify_ready(JNIEnv* env, jobject obj) {
        jclass cls = env->FindClass("com/acme/Listener");
        jmethodID method = env->GetMethodID(cls, "onReady", "(I)V");
        env->CallVoidMethod(obj, method, 1);
      }`,
    }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'c', target: 'j', kind: 'calls' }));
  });

  it('does not invent a reverse JNI callback when Call*Method evidence is missing', () => {
    const java = node('j', 'method', 'onReady', 'com.acme.Listener::onReady', 'Listener.java', 'java', 'void onReady(int value)');
    const cpp = { ...node('c', 'function', 'lookup_only', 'lookup_only', 'demo.cpp', 'cpp'), endLine: 4 };
    const edges = jniSynthesizer.synthesize(context([java, cpp], {
      'Listener.java': 'void onReady(int value) {}',
      'demo.cpp': `void lookup_only(JNIEnv* env) {
        jclass cls = env->FindClass("com/acme/Listener");
        env->GetMethodID(cls, "onReady", "(I)V");
      }`,
    }));
    expect(edges).toEqual([]);
  });

  it('links AIDL interfaces and methods to generated/implementation types', () => {
    const iface = node('a-i', 'interface', 'IFoo', 'android.foo.IFoo', 'IFoo.aidl', 'aidl');
    const aidlMethod = node('a-m', 'method', 'ping', 'android.foo.IFoo::ping', 'IFoo.aidl', 'aidl', 'void ping()');
    const stub = node('stub', 'class', 'BnFoo', 'android::foo::BnFoo', 'Foo.cpp', 'cpp');
    const impl = node('impl', 'method', 'ping', 'android::foo::BnFoo::ping', 'Foo.cpp', 'cpp', 'void ping()');
    const edges = aidlBinderSynthesizer.synthesize(context([iface, aidlMethod, stub, impl], { 'IFoo.aidl': '', 'Foo.cpp': '' }));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'a-i', target: 'stub', kind: 'binds' }),
      expect.objectContaining({ source: 'a-m', target: 'impl', kind: 'binds' }),
    ]));
  });

  it('links Device Tree compatible values to driver probe functions', () => {
    const device = node('dt', 'device', 'uart0', 'board.dts::uart0', 'board.dts', 'devicetree', 'compatible=acme,uart-v2');
    const probe = node('probe', 'function', 'acme_uart_probe', 'acme_uart_probe', 'drivers/uart.c', 'c');
    const edges = deviceTreeDriverSynthesizer.synthesize(context([device, probe], {
      'board.dts': 'compatible = "acme,uart-v2";',
      'drivers/uart.c': 'static const struct of_device_id ids[] = { { .compatible = "acme,uart-v2" } };\nint acme_uart_probe(void) {}',
    }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'dt', target: 'probe', kind: 'binds' }));
  });

  it('links a Device Tree node to its exact binding schema', () => {
    const device = node('dt', 'device', 'uart0', 'board.dts::uart0', 'board.dts', 'devicetree', 'compatible=acme,uart-v2');
    const schema = node('schema', 'resource', 'Acme UART', 'http://schemas/acme,uart.yaml#', 'Documentation/devicetree/bindings/acme,uart.yaml', 'yaml', 'Devicetree binding compatible=acme,uart-v1|acme,uart-v2');
    const edges = deviceTreeBindingSynthesizer.synthesize(context([device, schema], { 'board.dts': '', [schema.filePath]: '' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'dt', target: 'schema', kind: 'configures' }));
  });

  it('links init services to a uniquely named build target', () => {
    const service = node('svc', 'service', 'demod', 'init:demod', 'init.rc', 'initrc', '/system/bin/demod --foreground');
    const target = node('target', 'build_target', 'demod', 'demod', 'Android.bp', 'blueprint', 'cc_binary');
    const edges = initServiceSynthesizer.synthesize(context([service, target], { 'init.rc': '', 'Android.bp': '' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'svc', target: 'target', kind: 'binds' }));
  });

  it('links a VINTF instance to its AIDL HAL interface', () => {
    const instance = node('v', 'service', 'default', 'android.hardware.foo::IFoo/default', 'manifest.xml', 'xml', 'VINTF aidl instance');
    const iface = node('a', 'interface', 'IFoo', 'android.hardware.foo.IFoo', 'IFoo.aidl', 'aidl');
    const edges = halVintfSynthesizer.synthesize(context([instance, iface], { 'manifest.xml': '', 'IFoo.aidl': '' }));
    expect(edges).toContainEqual(expect.objectContaining({ source: 'v', target: 'a', kind: 'binds' }));
  });

  it('links SELinux service/property contexts to runtime declarations', () => {
    const serviceContext = node('sc', 'resource', 'android.hardware.foo.IFoo/default', 'android.hardware.foo.IFoo/default', 'service_contexts', 'selinux', 'u:object_r:foo_service:s0');
    const service = node('svc', 'service', 'android.hardware.foo.IFoo/default', 'android.hardware.foo.IFoo/default', 'manifest.xml', 'xml', 'VINTF aidl instance');
    const propertyContext = node('pc', 'resource', 'persist.demo.enabled', 'persist.demo.enabled', 'property_contexts', 'selinux', 'u:object_r:demo_prop:s0');
    const property = node('p', 'property', 'enabled', 'persist.demo.enabled', 'demo.sysprop', 'sysprop');
    const edges = selinuxBindingSynthesizer.synthesize(context([serviceContext, service, propertyContext, property], {
      service_contexts: '', property_contexts: '', 'manifest.xml': '', 'demo.sysprop': '',
    }));
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'sc', target: 'svc', kind: 'configures' }),
      expect.objectContaining({ source: 'pc', target: 'p', kind: 'configures' }),
    ]));
  });
});
