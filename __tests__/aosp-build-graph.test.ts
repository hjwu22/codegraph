import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction/tree-sitter';
import {
  AospBuildGraph,
  BazelQueryBuildGraphProvider,
  KernelConfigProvider,
  ModuleInfoBuildGraphProvider,
  StaticExtractionBuildGraphProvider,
  mergeBuildTargets,
} from '../src/aosp/build-graph';
import { clearProjectConfigCache, loadAospProjectConfig } from '../src/project-config';
import CodeGraph from '../src/index';

const temporary: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-build-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  clearProjectConfigCache();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('AOSP build graph', () => {
  it('converts extracted Soong/Make/Bazel targets into one model', () => {
    const records = [
      { filePath: 'system/demo/Android.bp', result: extractFromSource('system/demo/Android.bp', `
        cc_library { name: "libdemo", srcs: ["demo.cpp"], shared_libs: ["libbase"] }
      `) },
      { filePath: 'legacy/Android.mk', result: extractFromSource('legacy/Android.mk', `
        include $(CLEAR_VARS)
        LOCAL_MODULE := liblegacy
        LOCAL_SRC_FILES := legacy.cpp
        LOCAL_SHARED_LIBRARIES := libdemo
        include $(BUILD_SHARED_LIBRARY)
      `) },
      { filePath: 'kernel/BUILD.bazel', result: extractFromSource('kernel/BUILD.bazel', `
        kernel_build(name = "kernel", srcs = ["Kconfig"], deps = [":headers"])
      `) },
    ];
    const targets = new StaticExtractionBuildGraphProvider(records).discover();
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ system: 'soong', name: 'libdemo', dependencies: ['libbase'], sources: [{ path: 'demo.cpp' }] }),
      expect.objectContaining({ system: 'make', name: 'liblegacy', dependencies: ['libdemo'] }),
      expect.objectContaining({ system: 'kleaf', name: 'kernel' }),
    ]));
  });

  it('imports module-info without executing a build', () => {
    const root = tempDir();
    const file = path.join(root, 'module-info.json');
    fs.writeFileSync(file, JSON.stringify({
      libdemo: {
        module_name: 'libdemo', path: ['system/demo'], dependencies: ['libbase'],
        installed: ['out/target/product/acme/system/lib64/libdemo.so'],
        class: ['SHARED_LIBRARIES'], test_config: ['system/demo/AndroidTest.xml'],
      },
    }));
    const targets = new ModuleInfoBuildGraphProvider(file, 'aosp_acme-userdebug').discover();
    expect(targets).toContainEqual(expect.objectContaining({
      name: 'libdemo', packagePath: 'system/demo', dependencies: ['libbase'],
      variants: [{ expression: 'aosp_acme-userdebug', source: 'authoritative' }],
    }));
  });

  it('imports captured Bazel query JSON without invoking Bazel', () => {
    const root = tempDir();
    const file = path.join(root, 'cquery.json');
    fs.writeFileSync(file, JSON.stringify({ targets: [{
      label: '//build/kernel:kernel_aarch64', ruleClass: 'kernel_build',
      srcs: ['build/kernel/Kconfig'], deps: ['//common:headers'], outputs: ['out/kernel/Image'],
      configuration: 'aarch64',
    }] }));
    expect(new BazelQueryBuildGraphProvider(file).discover()).toContainEqual(expect.objectContaining({
      system: 'kleaf', name: 'kernel_aarch64', packagePath: 'build/kernel',
      dependencies: ['//common:headers'], variants: [{ expression: 'aarch64', source: 'authoritative' }],
    }));
  });

  it('imports Bazel query --output=jsonproto envelopes', () => {
    const root = tempDir();
    const file = path.join(root, 'query.json');
    fs.writeFileSync(file, JSON.stringify({ target: [{ type: 'RULE', rule: {
      name: '//build/kernel:kernel_aarch64', ruleClass: 'kernel_build',
      attribute: [
        { name: 'srcs', type: 'LABEL_LIST', stringListValue: ['//build/kernel:Kconfig', '//build/kernel:kernel.c'] },
        { name: 'deps', type: 'LABEL_LIST', stringListValue: [':headers', '//common:base'] },
      ],
      ruleInput: ['//build/kernel:Kconfig', '//build/kernel:kernel.c', '//build/kernel:headers', '//common:base'],
      ruleOutput: ['//build/kernel:Image'],
    } }] }));
    expect(new BazelQueryBuildGraphProvider(file).discover()).toContainEqual(expect.objectContaining({
      name: 'kernel_aarch64', sources: [{ path: 'build/kernel/Kconfig' }, { path: 'build/kernel/kernel.c' }],
      dependencies: ['//build/kernel:headers', '//common:base'],
      generatedOutputs: [{ path: 'build/kernel/Image', generated: true }],
    }));
  });

  it('imports configured Bazel cquery jsonproto results and configurations', () => {
    const root = tempDir();
    const file = path.join(root, 'cquery.json');
    fs.writeFileSync(file, JSON.stringify({
      results: [{ configurationId: 7, target: { rule: {
        name: '//app:demo', ruleClass: 'android_binary',
        attribute: [{ name: 'srcs', stringListValue: ['//app:Main.java'] }],
        configuredRuleInput: [{ label: '//libs:base', configurationChecksum: 'abc' }],
      } } }],
      configurations: [{ id: 7, mnemonic: 'android_arm64' }],
    }));
    expect(new BazelQueryBuildGraphProvider(file).discover()).toContainEqual(expect.objectContaining({
      name: 'demo', sources: [{ path: 'app/Main.java' }], dependencies: ['//libs:base'],
      variants: [{ expression: 'android_arm64', source: 'authoritative' }],
    }));
  });

  it('imports a selected kernel config without running Kconfig', () => {
    const root = tempDir();
    const file = path.join(root, '.config');
    fs.writeFileSync(file, 'CONFIG_OF=y\nCONFIG_ACME=m\n# CONFIG_DEBUG_INFO is not set\nCONFIG_CMDLINE="console=ttyS0"\n');
    expect(new KernelConfigProvider(file).discover()).toEqual([
      { symbol: 'CONFIG_OF', value: 'y', enabled: true },
      { symbol: 'CONFIG_ACME', value: 'm', enabled: true },
      { symbol: 'CONFIG_DEBUG_INFO', value: 'n', enabled: false },
      { symbol: 'CONFIG_CMDLINE', value: '"console=ttyS0"', enabled: true },
    ]);
  });

  it('retains static sources while authoritative dependencies and variants win', () => {
    const staticTarget = {
      id: 'soong:libdemo', system: 'soong' as const, name: 'libdemo', packagePath: 'system/demo', targetType: 'cc_library',
      sources: [{ path: 'demo.cpp' }], generatedOutputs: [], dependencies: ['maybe_dep'], variants: [], metadata: { sourceFile: 'Android.bp' },
    };
    const authoritative = {
      ...staticTarget, id: 'module-info:libdemo', sources: [], dependencies: ['libbase'],
      variants: [{ expression: 'aosp_acme', source: 'authoritative' as const }], metadata: { authoritative: true },
    };
    expect(mergeBuildTargets([staticTarget], [authoritative])).toContainEqual(expect.objectContaining({
      id: 'module-info:libdemo', sources: [{ path: 'demo.cpp' }], dependencies: ['libbase'],
      variants: [{ expression: 'aosp_acme', source: 'authoritative' }],
    }));
  });

  it('answers source ownership and transitive dependency closure', () => {
    const graph = new AospBuildGraph([
      { id: 'a', system: 'soong', name: 'app', packagePath: 'apps/demo', targetType: 'android_app', sources: [{ path: 'apps/demo/Main.java' }], generatedOutputs: [], dependencies: ['lib'], variants: [], metadata: {} },
      { id: 'b', system: 'soong', name: 'lib', packagePath: 'libs/demo', targetType: 'java_library', sources: [], generatedOutputs: [], dependencies: ['base'], variants: [], metadata: {} },
      { id: 'c', system: 'soong', name: 'base', packagePath: 'libs/base', targetType: 'java_library', sources: [], generatedOutputs: [], dependencies: [], variants: [], metadata: {} },
    ]);
    expect(graph.owningTargets('apps/demo/Main.java').map((t) => t.id)).toEqual(['a']);
    expect(graph.dependencyClosure('a').map((t) => t.name)).toEqual(['lib', 'base']);
  });

  it('finds tests affected through reverse build dependencies', () => {
    const graph = new AospBuildGraph([
      { id: 'lib', system: 'soong', name: 'libdemo', packagePath: 'system/demo', targetType: 'cc_library', sources: [{ path: 'demo.cpp' }], generatedOutputs: [], dependencies: [], variants: [], metadata: {} },
      { id: 'test', system: 'soong', name: 'DemoTests', packagePath: 'system/demo/tests', targetType: 'NATIVE_TESTS', sources: [], generatedOutputs: [], dependencies: ['libdemo'], variants: [], metadata: { testConfig: ['AndroidTest.xml'] } },
    ]);
    expect(graph.owningTargets('system/demo/demo.cpp').map((target) => target.name)).toEqual(['libdemo']);
    expect(graph.impactedTests(['system/demo/demo.cpp']).map((target) => target.name)).toEqual(['DemoTests']);
  });

  it('enriches an existing graph from module-info without running a build', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'system/demo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'system/demo/Android.bp'), 'cc_library { name: "libdemo", srcs: ["demo.cpp"] }');
    fs.writeFileSync(path.join(root, 'system/demo/demo.cpp'), 'void demo() {}');
    fs.writeFileSync(path.join(root, 'system/demo/AndroidTest.xml'), '<configuration description="Demo"><test class="com.android.tradefed.testtype.AndroidJUnitTest" /></configuration>');
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out/module-info.json'), JSON.stringify({
      libdemo: { path: ['system/demo'], dependencies: ['libbase'], installed: ['out/system/lib64/libdemo.so'], test_config: ['system/demo/AndroidTest.xml'] },
      libbase: { path: ['system/libbase'], dependencies: [] },
    }));
    const graph = CodeGraph.initSync(root);
    try {
      await graph.indexAll();
      const result = graph.enrichAosp({ product: 'aosp_demo' });
      expect(result).toMatchObject({ targetsImported: 2, product: 'aosp_demo' });
      const demo = graph.getNodesByName('libdemo').find((n) => n.kind === 'build_target');
      expect(demo).toBeDefined();
      expect(graph.getOutgoingEdges(demo!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'depends_on', metadata: expect.objectContaining({ synthesizedBy: 'aosp-module-info' }) }),
        expect.objectContaining({ kind: 'generates', metadata: expect.objectContaining({ synthesizedBy: 'aosp-module-info' }) }),
        expect.objectContaining({ kind: 'configures', metadata: expect.objectContaining({ synthesizedBy: 'aosp-module-info' }) }),
      ]));
      const config = graph.getNodesInFile('system/demo/AndroidTest.xml').find((n) => n.kind === 'build_target');
      expect(graph.getOutgoingEdges(config!.id)).toContainEqual(expect.objectContaining({
        target: demo!.id, kind: 'depends_on', metadata: expect.objectContaining({ synthesizedBy: 'aosp-module-info-test-impact' }),
      }));
    } finally {
      graph.destroy();
    }
  });

  it('enriches exact Bazel labels without requiring module-info', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out/cquery.json'), JSON.stringify({ targets: [
      { label: '//common:headers', ruleClass: 'cc_library' },
      { label: '//build/kernel:kernel', ruleClass: 'kernel_build', deps: ['//common:headers'], outputs: ['out/Image'] },
    ] }));
    const graph = CodeGraph.initSync(root);
    try {
      const result = graph.enrichAosp({ bazelQuery: 'out/cquery.json' });
      expect(result).toMatchObject({ moduleInfoPath: null, targetsImported: 2 });
      const kernel = graph.getNodesByName('kernel').find((node) => node.kind === 'build_target');
      expect(graph.getOutgoingEdges(kernel!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'depends_on', metadata: expect.objectContaining({ synthesizedBy: 'aosp-bazel-query' }) }),
        expect.objectContaining({ kind: 'generates', metadata: expect.objectContaining({ synthesizedBy: 'aosp-bazel-query' }) }),
      ]));
    } finally {
      graph.destroy();
    }
  });

  it('persists selected kernel config values and links exact Kconfig declarations', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'Kconfig'), 'config OF\n  bool "Device Tree support"\n');
    fs.writeFileSync(path.join(root, '.config'), 'CONFIG_OF=y\n# CONFIG_UNUSED is not set\n');
    const graph = CodeGraph.initSync(root);
    try {
      await graph.indexAll();
      const declaration = graph.getNodesByName('OF').find((node) => node.qualifiedName === 'CONFIG_OF');
      expect(declaration).toBeDefined();

      const result = graph.enrichAosp({ kernelConfig: '.config' });
      expect(result).toMatchObject({
        moduleInfoPath: null,
        bazelQueryPath: null,
        configsImported: 2,
        targetsImported: 0,
      });
      const selected = graph.getNodesByName('CONFIG_OF').find((node) => node.qualifiedName === 'selected:CONFIG_OF');
      expect(selected).toMatchObject({ filePath: '.config', signature: 'CONFIG_OF=y' });
      expect(graph.getOutgoingEdges(selected!.id)).toContainEqual(expect.objectContaining({
        target: declaration!.id,
        kind: 'configures',
        metadata: expect.objectContaining({ synthesizedBy: 'aosp-kernel-config', confidence: 'exact', enabled: true }),
      }));
    } finally {
      graph.destroy();
    }
  });

  it('keeps authoritative metadata nodes separate from static build declarations', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'demo/Android.bp'), 'cc_library { name: "libdemo", srcs: ["demo.cpp"] }');
    fs.writeFileSync(path.join(root, 'demo/demo.cpp'), 'void demo() {}');
    fs.writeFileSync(path.join(root, 'out/module-info.json'), JSON.stringify({ libdemo: { path: ['demo'] } }));
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ aosp: { enabled: true, buildGraph: 'authoritative' } }));
    clearProjectConfigCache();
    const graph = CodeGraph.initSync(root);
    try {
      await graph.indexAll();
      expect(graph.getNodesByName('libdemo').filter((node) => node.kind === 'build_target')).toHaveLength(1);
      graph.enrichAosp();
      const targets = graph.getNodesByName('libdemo').filter((node) => node.kind === 'build_target');
      expect(targets).toHaveLength(2);
      expect(targets.map((node) => node.filePath)).toEqual(expect.arrayContaining(['demo/Android.bp', 'out/module-info.json']));
    } finally {
      graph.destroy();
    }
  });
});

describe('AOSP project config', () => {
  it('uses hybrid zero-config defaults', () => {
    expect(loadAospProjectConfig(tempDir())).toEqual({
      enabled: 'auto', buildGraph: 'hybrid', product: null, outDir: 'out',
      moduleInfo: null, compileCommands: null, bazelQuery: null, kernelConfig: null,
      indexAndroidResources: true,
    });
  });

  it('enforces enabled=false and static build-graph modes at enrichment time', () => {
    for (const aosp of [{ enabled: false }, { buildGraph: 'static' }]) {
      const root = tempDir();
      fs.mkdirSync(path.join(root, 'out'), { recursive: true });
      fs.writeFileSync(path.join(root, 'out/module-info.json'), JSON.stringify({ demo: { path: ['demo'] } }));
      fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ aosp }));
      clearProjectConfigCache();
      const graph = CodeGraph.initSync(root);
      try {
        expect(() => graph.enrichAosp()).toThrow(aosp.enabled === false ? /disabled/ : /buildGraph="static"/);
      } finally {
        graph.destroy();
      }
    }
  });

  it('validates and loads explicit authoritative inputs', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({
      aosp: {
        enabled: true, buildGraph: 'authoritative', product: 'aosp_cf_x86_64_phone',
        outDir: 'out-custom', moduleInfo: 'out-custom/module-info.json',
        compileCommands: 'out-custom/compile_commands.json', bazelQuery: 'out-custom/cquery.json',
        kernelConfig: 'out-custom/kernel.config',
        indexAndroidResources: false,
      },
    }));
    expect(loadAospProjectConfig(root)).toMatchObject({
      enabled: true, buildGraph: 'authoritative', product: 'aosp_cf_x86_64_phone',
      outDir: 'out-custom', kernelConfig: 'out-custom/kernel.config', indexAndroidResources: false,
    });
  });
});
