import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';

describe('AOSP end-to-end indexing', () => {
  let dir: string;
  let graph: CodeGraph;

  const write = (relative: string, source: string): void => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-e2e-'));
    write('.repo/manifest.xml', '<manifest/>');
    write('system/demo/Android.bp', `
      cc_binary { name: "demod", srcs: ["demo.cpp"], shared_libs: ["libbase"] }
      aidl_interface { name: "android.foo", srcs: ["IFoo.aidl"] }
    `);
    write('build/soong/demo/Android.bp', 'bootstrap_go_package { name: "soong-demo", pkgPath: "android/soong/demo" }');
    write('vendor/acme/Android.mk', `
      include $(CLEAR_VARS)
      LOCAL_MODULE := libvendor_demo
      LOCAL_SRC_FILES := vendor_demo.cpp
      include $(BUILD_SHARED_LIBRARY)
    `);
    write('system/demo/IFoo.aidl', `package android.foo; interface IFoo { void ping(); }`);
    write('system/demo/Demo.java', `
      package com.acme;
      public final class Demo { private static native void nativePing(); }
    `);
    write('system/demo/demo.cpp', `
      extern "C" void Java_com_acme_Demo_nativePing(void*, void*) {}
    `);
    write('system/demo/init.demo.rc', `
      service demod /system/bin/demod
          class core
    `);
    write('frameworks/base/core/res/res/values/demo.xml', `
      <resources><string name="demo_name">Demo</string></resources>
    `);
    write('system/demo/AndroidTest.xml', `
      <configuration description="Demo tests">
        <test class="com.android.tradefed.testtype.AndroidJUnitTest" />
        <option name="module" value="demod" />
      </configuration>
    `);
    write('out/module-info.json', JSON.stringify({
      demod: { path: ['system/demo'], dependencies: [], test_config: ['system/demo/AndroidTest.xml'] },
    }));
  });

  afterEach(() => {
    graph?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes AOSP DSLs/resources and persists source/runtime/JNI bridges', async () => {
    graph = CodeGraph.initSync(dir);
    const result = await graph.indexAll();
    expect(result.success).toBe(true);

    const files = new Set(graph.getFiles().map((f) => f.path));
    expect(files.has('.repo/manifest.xml')).toBe(false);
    expect(files.has('system/demo/Android.bp')).toBe(true);
    expect(files.has('system/demo/IFoo.aidl')).toBe(true);
    expect(files.has('system/demo/init.demo.rc')).toBe(true);
    expect(files.has('frameworks/base/core/res/res/values/demo.xml')).toBe(true);
    expect(files.has('build/soong/demo/Android.bp')).toBe(true);
    expect(files.has('vendor/acme/Android.mk')).toBe(true);

    expect(graph.getNodesByKind('build_target')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demod', language: 'blueprint' }),
      expect.objectContaining({ name: 'soong-demo', language: 'blueprint' }),
      expect.objectContaining({ name: 'libvendor_demo', language: 'make' }),
    ]));
    expect(graph.getNodesByKind('interface')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'IFoo', language: 'aidl' }),
    ]));
    expect(graph.getNodesByKind('resource')).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: '@string/demo_name' }),
    ]));

    const nativeMethod = graph.getNodesByName('nativePing').find((n) => n.language === 'java');
    expect(nativeMethod).toBeDefined();
    expect(graph.getOutgoingEdges(nativeMethod!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'calls', metadata: expect.objectContaining({ synthesizedBy: 'aosp-jni' }) }),
    ]));

    const service = graph.getNodesByName('demod').find((n) => n.kind === 'service');
    expect(service).toBeDefined();
    expect(graph.getOutgoingEdges(service!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'binds', metadata: expect.objectContaining({ synthesizedBy: 'aosp-init-service' }) }),
    ]));

    const target = graph.getNodesByName('demod').find((n) => n.kind === 'build_target');
    expect(target).toBeDefined();
    expect(graph.getOutgoingEdges(target!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'references' }),
    ]));

    const enriched = graph.enrichAosp();
    expect(enriched.targetsImported).toBe(1);
    expect(graph.getFileDependents('system/demo/demo.cpp')).toContain('system/demo/Android.bp');
    expect(graph.getFileDependents('system/demo/Android.bp')).toContain('system/demo/AndroidTest.xml');

    const affected = execFileSync(process.execPath, [
      path.resolve(__dirname, '../dist/bin/codegraph.js'),
      'affected', 'system/demo/demo.cpp', '--quiet', '-p', dir,
    ], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CODEGRAPH_NO_DAEMON: '1' } });
    expect(affected.trim().split(/\r?\n/)).toContain('system/demo/AndroidTest.xml');
  }, 30_000);
});
