import { describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';

describe('AOSP artifact extraction', () => {
  it('extracts Android.bp modules, dependencies, sources, and outputs', () => {
    const result = extractFromSource('system/demo/Android.bp', `
      cc_library_shared {
        name: "libdemo",
        srcs: ["demo.cpp", ":generated_srcs"],
        exclude_srcs: ["disabled.cpp"],
        shared_libs: ["libbase"],
        whole_static_libs: ["libwhole"],
        defaults: ["demo_defaults"],
        out: ["demo.generated.h"],
      }
    `);
    const target = result.nodes.find((n) => n.kind === 'build_target' && n.name === 'libdemo');
    expect(target?.signature).toBe('cc_library_shared');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: target?.id, referenceName: 'libbase', referenceKind: 'depends_on' }),
      expect.objectContaining({ fromNodeId: target?.id, referenceName: 'libwhole', referenceKind: 'depends_on' }),
      expect.objectContaining({ fromNodeId: target?.id, referenceName: 'generated_srcs', referenceKind: 'depends_on' }),
      expect.objectContaining({ fromNodeId: target?.id, referenceName: 'demo.cpp', referenceKind: 'references' }),
    ]));
    expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({ referenceName: 'disabled.cpp' }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: 'resource', name: 'demo.generated.h' }));
    expect(result.edges).toContainEqual(expect.objectContaining({ source: target?.id, kind: 'generates' }));
  });

  it('models stable AIDL interface versions, imports, and generated backends', () => {
    const result = extractFromSource('hardware/interfaces/foo/aidl/Android.bp', `
      aidl_interface {
        name: "android.hardware.foo",
        stability: "vintf",
        frozen: true,
        versions: ["1", "2"],
        imports: ["android.hardware.common-V2"],
        backend: { java: { enabled: false }, cpp: { enabled: true }, ndk: { enabled: true } },
      }
    `);
    const target = result.nodes.find((n) => n.name === 'android.hardware.foo' && n.kind === 'build_target');
    expect(target?.signature).toContain('stability=vintf');
    expect(target?.signature).toContain('versions=1|2');
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: target?.id, referenceName: 'android.hardware.common-V2', referenceKind: 'depends_on' }));
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: 'android.hardware.foo:backend:cpp' }),
      expect.objectContaining({ qualifiedName: 'android.hardware.foo:backend:ndk' }),
    ]));
    expect(result.nodes).not.toContainEqual(expect.objectContaining({ qualifiedName: 'android.hardware.foo:backend:java' }));
  });

  it('keeps default AIDL backends enabled when backend only opts into Rust', () => {
    const result = extractFromSource('hardware/interfaces/foo/aidl/Android.bp', `
      aidl_interface {
        name: "android.hardware.foo",
        backend: {
          rust: { enabled: true, additional_rustlibs: ["libnested"] },
        },
      }
    `);
    for (const backend of ['java', 'cpp', 'ndk', 'rust']) {
      expect(result.nodes).toContainEqual(expect.objectContaining({
        qualifiedName: `android.hardware.foo:backend:${backend}`,
      }));
    }
  });

  it('does not let apostrophes in Blueprint comments swallow later modules', () => {
    const result = extractFromSource('system/demo/Android.bp', `
      cc_library {
        name: "first",
        // Don't expose this target directly.
        // shared_libs: ["comment_only_dep"],
        srcs: ["first.cpp"],
      }
      cc_library {
        name: "second",
        srcs: ["second.cpp"],
      }
    `);
    expect(result.nodes.filter((node) => node.kind === 'build_target').map((node) => node.name)).toEqual(['first', 'second']);
    expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({ referenceName: 'comment_only_dep' }));
  });

  it('extracts TEST_MAPPING groups, imports, test modules, and filters', () => {
    const result = extractFromSource('system/demo/TEST_MAPPING', JSON.stringify({
      imports: [{ path: 'system/common' }],
      presubmit: [{ name: 'DemoTests', options: [{ 'include-filter': 'DemoClass#works' }] }],
    }, null, 2));
    const target = result.nodes.find((n) => n.kind === 'build_target' && n.name === 'DemoTests');
    expect(target?.signature).toContain('presubmit');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'system/common', referenceKind: 'imports' }),
      expect.objectContaining({ fromNodeId: target?.id, referenceName: 'DemoTests', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'DemoClass#works', referenceKind: 'configures' }),
    ]));
  });

  it('extracts Devicetree binding compatible values and schema references', () => {
    const result = extractFromSource('Documentation/devicetree/bindings/serial/acme,uart.yaml', `
      $id: http://devicetree.org/schemas/serial/acme,uart.yaml#
      $schema: http://devicetree.org/meta-schemas/core.yaml#
      title: Acme UART controller
      allOf:
        - $ref: /schemas/serial/serial.yaml#
      properties:
        compatible:
          enum: ["acme,uart-v1", "acme,uart-v2"]
    `);
    expect(result.nodes).toContainEqual(expect.objectContaining({ kind: 'resource', signature: expect.stringContaining('compatible=acme,uart-v1|acme,uart-v2') }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: '/schemas/serial/serial.yaml#', referenceKind: 'imports' }));
  });

  it('extracts Android.mk modules and product dependencies', () => {
    const result = extractFromSource('device/acme/Android.mk', `
      include $(CLEAR_VARS)
      LOCAL_MODULE := liblegacy
      LOCAL_SRC_FILES := legacy.cpp helper.cpp
      LOCAL_SHARED_LIBRARIES := libbase liblog
      LOCAL_AIDL_INCLUDES := frameworks/base/core/java
      include $(BUILD_SHARED_LIBRARY)

      PRODUCT_PACKAGES += liblegacy init.acme.rc
      $(call inherit-product, device/acme/base.mk)
    `);
    const module = result.nodes.find((n) => n.kind === 'build_target' && n.name === 'liblegacy');
    expect(module?.signature).toBe('BUILD_SHARED_LIBRARY');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: module?.id, referenceName: 'libbase', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'legacy.cpp', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: 'device/acme/base.mk', referenceKind: 'imports' }),
      expect.objectContaining({ referenceName: 'liblegacy', referenceKind: 'depends_on' }),
    ]));
  });

  it('uses the matched Make operator rather than += text inside the value', () => {
    const result = extractFromSource('device/acme/Android.mk', `
      include $(CLEAR_VARS)
      LOCAL_MODULE := demo
      LOCAL_SRC_FILES := stale.cpp
      LOCAL_SRC_FILES := actual+=name.cpp
      include $(BUILD_SHARED_LIBRARY)
    `);
    const target = result.nodes.find((node) => node.kind === 'build_target' && node.name === 'demo');
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: target!.id, referenceName: 'actual+=name.cpp', referenceKind: 'references',
    }));
    expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({
      fromNodeId: target!.id, referenceName: 'stale.cpp',
    }));
  });

  it('extracts Bazel targets, loads, glob patterns, and every literal select branch', () => {
    const result = extractFromSource('build/kernel/BUILD.bazel', `
      load("//build/kernel/kleaf:kernel.bzl", "kernel_build")
      kernel_build(
        name = "kernel_aarch64",
        srcs = ["Kconfig"] + glob(["*.c"], exclude = ["*_test.c"]),
        hdrs = glob(["*.h"]),
        deps = [":headers"] + select({
          "//build/kernel:arm64": ["//common:arm64_base"],
          "//conditions:default": ["//common:base"],
        }),
        outs = ["Image"],
      )
    `);
    const target = result.nodes.find((n) => n.kind === 'build_target');
    expect(target).toMatchObject({ name: 'kernel_aarch64', qualifiedName: '//build/kernel:kernel_aarch64', signature: 'kernel_build' });
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: '//build/kernel/kleaf:kernel.bzl', referenceKind: 'imports' }),
      expect.objectContaining({ referenceName: '//build/kernel:headers', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'Kconfig', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: '*.c', referenceKind: 'references', metadata: expect.objectContaining({ glob: true }) }),
      expect.objectContaining({ referenceName: '*.h', referenceKind: 'references', metadata: expect.objectContaining({ glob: true }) }),
      expect.objectContaining({ referenceName: '//common:arm64_base', referenceKind: 'depends_on', metadata: expect.objectContaining({ variant: ['//build/kernel:arm64'] }) }),
      expect.objectContaining({ referenceName: '//common:base', referenceKind: 'depends_on', metadata: expect.objectContaining({ variant: ['//conditions:default'] }) }),
    ]));
    expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({ referenceName: '*_test.c' }));
    const output = result.nodes.find((node) => node.kind === 'resource' && node.name === 'Image');
    expect(output).toBeDefined();
    expect(result.edges).toContainEqual(expect.objectContaining({ source: target!.id, target: output!.id, kind: 'generates' }));
  });

  it('does not let apostrophes in Starlark comments swallow later targets', () => {
    const result = extractFromSource('build/demo/BUILD.bazel', `
      cc_library(
        name = "first",
        # Don't expose this target directly.
        # deps = ["//comment:only"],
        srcs = ["first.cpp"],
      )
      cc_library(
        name = "second",
        srcs = ["second.cpp"],
      )
    `);
    expect(result.nodes.filter((node) => node.kind === 'build_target').map((node) => node.name)).toEqual(['first', 'second']);
    expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({ referenceName: '//comment:only' }));
  });

  it('extracts AIDL interfaces and methods', () => {
    const result = extractFromSource('android/os/IFoo.aidl', `
      package android.os;
      import android.os.ParcelThing;
      parcelable Request;
      union Result { int code; String message; }
      enum Mode { FAST, SAFE }
      @VintfStability interface IFoo extends android.os.IBase {
        oneway void notify(in ParcelThing value);
        Result fetch(in Request request);
        int calculate(int left, int right);
      }
    `);
    const iface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'IFoo');
    expect(iface?.qualifiedName).toBe('android.os.IFoo');
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', qualifiedName: 'android.os.Request', startLine: 4, endLine: 4 }),
      expect.objectContaining({ kind: 'union', qualifiedName: 'android.os.Result' }),
      expect.objectContaining({ kind: 'enum', qualifiedName: 'android.os.Mode' }),
      expect.objectContaining({ kind: 'method', name: 'notify' }),
      expect.objectContaining({ kind: 'method', name: 'fetch' }),
      expect.objectContaining({ kind: 'method', name: 'calculate' }),
    ]));
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: iface?.id, referenceName: 'android.os.IBase', referenceKind: 'extends' }),
      expect.objectContaining({ referenceName: 'android.os.ParcelThing', referenceKind: 'imports' }),
      expect.objectContaining({ referenceName: 'Request', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: 'Result', referenceKind: 'returns' }),
    ]));
  });

  it('anchors startLine on the declaration, not on preceding blank/comment lines', () => {
    // `(^|\n)\s*` in the module/rule/node regexes eats every blank line before a
    // declaration, and once maskComments blanks comment lines it eats those too,
    // so the match offset lands on the PREVIOUS declaration's closing line.
    // generateNodeId hashes startLine and every ref carries it, so this is not
    // cosmetic. Lines are 1-based; the template's first line is empty.
    const bp = extractFromSource('x/Android.bp', [
      /* 1 */ '',
      /* 2 */ 'cc_library {',
      /* 3 */ '    name: "libfoo",',
      /* 4 */ '}',
      /* 5 */ '',
      /* 6 */ '// a comment block',
      /* 7 */ '// second line',
      /* 8 */ '',
      /* 9 */ 'cc_binary {',
      /* 10 */ '    name: "foo",',
      /* 11 */ '}',
    ].join('\n'));
    expect(bp.nodes.filter((n) => n.kind === 'build_target').map((n) => [n.name, n.startLine]))
      .toEqual([['libfoo', 2], ['foo', 9]]);

    const bzl = extractFromSource('x/BUILD.bazel', [
      /* 1 */ '',
      /* 2 */ 'cc_lib(',
      /* 3 */ '    name = "core",',
      /* 4 */ ')',
      /* 5 */ '',
      /* 6 */ '# a comment',
      /* 7 */ '',
      /* 8 */ 'cc_lib(',
      /* 9 */ '    name = "tool",',
      /* 10 */ ')',
    ].join('\n'));
    expect(bzl.nodes.filter((n) => n.kind === 'build_target').map((n) => [n.name, n.startLine]))
      .toEqual([['core', 2], ['tool', 8]]);

    const dts = extractFromSource('x/board.dts', [
      /* 1 */ '/ {',
      /* 2 */ '    soc {',
      /* 3 */ '        uart0: serial@1000 {',
      /* 4 */ '            compatible = "acme,uart";',
      /* 5 */ '        };',
      /* 6 */ '',
      /* 7 */ '        // a comment',
      /* 8 */ '        i2c@2000 {',
      /* 9 */ '            compatible = "acme,i2c";',
      /* 10 */ '        };',
      /* 11 */ '    };',
      /* 12 */ '};',
    ].join('\n'));
    expect(dts.nodes.filter((n) => n.kind === 'device').map((n) => [n.name, n.startLine]))
      .toEqual([['soc', 2], ['uart0', 3], ['i2c@2000', 8]]);
  });

  it('does not treat a commented-out &label overlay as a device node', () => {
    const result = extractFromSource('x/overlay.dts', [
      '// &disabled_uart {',
      '//     status = "okay";',
      '// };',
      '&uart0 {',
      '    status = "okay";',
      '};',
    ].join('\n'));
    const overlays = result.nodes.filter((n) => n.signature === 'Device Tree label overlay');
    expect(overlays.map((n) => [n.name, n.startLine])).toEqual([['&uart0', 4]]);
  });

  it('does not extract AIDL declarations out of comments', () => {
    // Real AOSP shape: the `aidl_api/` frozen-snapshot header and ordinary doc
    // comments both contain the word `interface`. AIDL declarations may end in
    // `;` rather than `{`, so nothing else stops a comment from matching.
    const result = extractFromSource('android/media/IEco.aidl', `
      // This file is a snapshot of an AIDL file. Do not edit it manually.
      // You must not make a backward incompatible change to any AIDL file
      // built with the aidl_interface module type with versions property set.
      package android.media;

      /**
       * Binder interface for ECO (Encoder Camera Optimization) service.
       * The interface is stable; the parcelable Config below is not.
       */
      interface IEco {
        /* enum Mode is documented elsewhere */
        void start();
      }
    `);
    const declared = result.nodes.filter((n) => ['interface', 'struct', 'union', 'enum'].includes(n.kind));
    expect(declared.map((n) => n.name)).toEqual(['IEco']);
    expect(result.nodes.filter((n) => n.kind === 'method').map((n) => n.name)).toEqual(['start']);
  });

  it('extracts Device Tree nodes, includes, phandles, compatibles, and overlays', () => {
    const result = extractFromSource('arch/arm64/boot/dts/acme.dts', `
      #include "base.dtsi"
      uart0: serial@1000 {
        compatible = "acme,uart-v2", "ns16550a";
        clocks = <&clk0>;
      };
      fragment@0 { target = <&uart0>; __overlay__ { status = "okay"; }; };
    `);
    const device = result.nodes.find((n) => n.kind === 'device' && n.name === 'uart0');
    expect(device?.signature).toContain('acme,uart-v2');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'base.dtsi', referenceKind: 'imports' }),
      expect.objectContaining({ fromNodeId: device?.id, referenceName: 'clk0', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: 'uart0', referenceKind: 'overlays' }),
    ]));
  });

  it('extracts deeply nested Device Tree children without leaking child properties to parents', () => {
    const result = extractFromSource('arch/arm64/boot/dts/nested.dts', `
      / {
        soc {
          uart0: serial@1000 {
            compatible = "acme,uart-v2";
            clocks = <&clk0>;
          };
          i2c@2000 {
            compatible = "acme,i2c";
          };
        };
      };
    `);
    const devices = result.nodes.filter((node) => node.kind === 'device');
    expect(devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'soc', signature: 'device node' }),
      expect.objectContaining({ name: 'uart0', signature: 'compatible=acme,uart-v2' }),
      expect.objectContaining({ name: 'i2c@2000', signature: 'compatible=acme,i2c' }),
    ]));
    expect(devices.find((node) => node.name === 'soc')?.signature).not.toContain('compatible=');
  });

  it('extracts Device Tree &label overlay sugar', () => {
    const result = extractFromSource('arch/arm64/boot/dts/acme-overlay.dts', '&uart0 { status = "okay"; };');
    const overlay = result.nodes.find((node) => node.signature === 'Device Tree label overlay');
    expect(overlay).toBeDefined();
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: overlay!.id, referenceName: 'uart0', referenceKind: 'overlays',
    }));
  });

  it('extracts HIDL interfaces and methods', () => {
    const result = extractFromSource('hardware/interfaces/foo/1.0/IFoo.hal', `
      package android.hardware.foo@1.0;
      import android.hidl.base@1.0::IBase;
      interface IFoo extends IBase {
        ping(uint32_t value) generates (Status status);
      };
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'interface', qualifiedName: 'android.hardware.foo@1.0::IFoo' }),
      expect.objectContaining({ kind: 'method', name: 'ping' }),
    ]));
  });

  it('extracts proto messages, services, RPCs, and imports', () => {
    const result = extractFromSource('frameworks/base/core/proto/foo.proto', `
      syntax = "proto3";
      package android.foo;
      import "common.proto";
      message Request { string name = 1; }
      message Reply { bool ok = 1; }
      service FooService { rpc Get(Request) returns (Reply); }
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', qualifiedName: 'android.foo.Request' }),
      expect.objectContaining({ kind: 'interface', qualifiedName: 'android.foo.FooService' }),
      expect.objectContaining({ kind: 'method', name: 'Get' }),
    ]));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'common.proto', referenceKind: 'imports' }));
  });

  it('extracts init services, actions, property writes, and service starts', () => {
    const result = extractFromSource('system/core/rootdir/init.demo.rc', `
      import /vendor/etc/init/vendor.rc
      service demo /system/bin/demod --foreground
          class core
      on property:sys.boot_completed=1
          setprop demo.ready 1
          start demo
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'service', name: 'demo' }),
      expect.objectContaining({ kind: 'function', name: 'property:sys.boot_completed=1' }),
    ]));
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: '/system/bin/demod', referenceKind: 'binds' }),
      expect.objectContaining({ referenceName: 'demo.ready', referenceKind: 'configures' }),
      expect.objectContaining({ referenceName: 'init:demo', referenceKind: 'calls' }),
    ]));
  });

  it('extracts SELinux types, allow rules, and context mappings', () => {
    const policy = extractFromSource('system/sepolicy/private/demo.te', `
      type demo, domain;
      type demo_exec, exec_type, file_type;
      allow demo servicemanager:binder call;
    `);
    expect(policy.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_alias', name: 'demo' }),
      expect.objectContaining({ kind: 'function', name: 'allow:demo:servicemanager' }),
    ]));
    const contexts = extractFromSource('system/sepolicy/private/service_contexts', `
      android.foo.IFoo u:object_r:foo_service:s0
    `);
    expect(contexts.nodes).toContainEqual(expect.objectContaining({ kind: 'resource', name: 'android.foo.IFoo' }));

    const fileContexts = extractFromSource('vendor/acme/sepolicy/vendor.fc', `
      /vendor/bin/demo    u:object_r:demo_exec:s0
    `);
    expect(fileContexts.nodes).toContainEqual(expect.objectContaining({
      kind: 'resource', name: '/vendor/bin/demo', signature: 'u:object_r:demo_exec:s0',
    }));

    const cil = extractFromSource('system/sepolicy/prebuilts/demo.cil', `
      (type demo_service)
      (typeattribute service_domain)
      (allow demo_service servicemanager (binder (call)))
    `);
    expect(cil.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type_alias', name: 'demo_service' }),
      expect.objectContaining({ kind: 'trait', name: 'service_domain' }),
      expect.objectContaining({ kind: 'function', name: 'allow:demo_service:servicemanager' }),
    ]));
  });

  it('extracts Kconfig dependencies and Kbuild object conditions', () => {
    const kconfig = extractFromSource('drivers/foo/Kconfig', `
      config FOO_DRIVER
        tristate "Foo driver"
        depends on I2C && OF
        select REGMAP
      source "drivers/foo/advanced/Kconfig"
    `);
    const config = kconfig.nodes.find((n) => n.qualifiedName === 'CONFIG_FOO_DRIVER');
    expect(kconfig.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: config?.id, referenceName: 'CONFIG_I2C', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'CONFIG_REGMAP', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'drivers/foo/advanced/Kconfig', referenceKind: 'imports' }),
    ]));
    const kbuild = extractFromSource('drivers/foo/Kbuild', 'obj-$(CONFIG_FOO_DRIVER) += foo.o');
    expect(kbuild.nodes).toContainEqual(expect.objectContaining({ kind: 'build_target', name: 'foo.o' }));
  });

  it('extracts sysprop declarations', () => {
    const result = extractFromSource('system/libsysprop/demo.sysprop', `
      owner: Platform
      module: "android.foo"
      prop { api_name: "enabled" type: Boolean prop_name: "persist.demo.enabled" }
    `);
    expect(result.nodes).toContainEqual(expect.objectContaining({
      kind: 'property', name: 'enabled', qualifiedName: 'persist.demo.enabled', signature: 'owner=Platform',
    }));
  });
});
