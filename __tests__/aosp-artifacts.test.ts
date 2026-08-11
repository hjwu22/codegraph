import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectLanguage, getSupportedLanguages, initGrammars, isGrammarLoaded, isLanguageSupported, isSourceFile, loadGrammarsForLanguages, readGrammarWasmBytes } from '../src/extraction/grammars';
import { isAospWorkspace } from '../src/extraction/aosp-artifacts';
import { EDGE_KINDS, NODE_KINDS } from '../src/types';
import { isTestFile } from '../src/search/query-utils';

describe('AOSP artifact discovery', () => {
  const cases: Array<[string, string]> = [
    ['Android.bp', 'blueprint'],
    ['frameworks/base/Android.mk', 'make'],
    ['device/acme/BoardConfig.mk', 'make'],
    ['kernel/common/BUILD.bazel', 'starlark'],
    ['kernel/common/BUILD', 'starlark'],
    ['kernel/common/MODULE.bazel', 'starlark'],
    ['kernel/common/Kconfig', 'kconfig'],
    ['kernel/common/Kbuild', 'kconfig'],
    ['system/core/TEST_MAPPING', 'yaml'],
    ['system/sepolicy/private/service_contexts', 'selinux'],
    ['system/sepolicy/vendor/vendor_service_contexts', 'selinux'],
    ['system/sepolicy/private/genfs_contexts', 'selinux'],
    ['hardware/interfaces/foo/IFoo.aidl', 'aidl'],
    ['kernel/common/arch/arm64/boot/dts/acme.dtsi', 'devicetree'],
    ['build/bazel/rules/foo.bzl', 'starlark'],
    ['hardware/interfaces/foo/1.0/IFoo.hal', 'hidl'],
    ['system/core/init/init.rc', 'initrc'],
    ['system/sepolicy/private/domain.te', 'selinux'],
    ['frameworks/base/core/proto/foo.proto', 'protobuf'],
    ['system/libsysprop/example.sysprop', 'sysprop'],
  ];

  it.each(cases)('recognizes %s as %s', (file, language) => {
    expect(isSourceFile(file)).toBe(true);
    expect(detectLanguage(file)).toBe(language);
    expect(isLanguageSupported(language as never)).toBe(true);
  });

  it('does not treat arbitrary extensionless files as source', () => {
    expect(isSourceFile('notes/README')).toBe(false);
    expect(detectLanguage('notes/README')).toBe('unknown');
  });

  it('keeps health-check WASMs out of production worker grammar loading', async () => {
    await initGrammars();
    expect(await readGrammarWasmBytes(['starlark', 'devicetree'])).toEqual({});
    await loadGrammarsForLanguages(['starlark', 'devicetree']);
    // Custom-extractor readiness remains true without instantiating an unused
    // parser in every worker.
    expect(isGrammarLoaded('starlark')).toBe(true);
    expect(isGrammarLoaded('devicetree')).toBe(true);
  });

  it('reports every supported language once', () => {
    const languages = getSupportedLanguages();
    expect(new Set(languages).size).toBe(languages.length);
    expect(languages).toEqual(expect.arrayContaining(['aidl', 'starlark', 'devicetree', 'make', 'kconfig']));
  });
});

describe('AOSP workspace profile', () => {
  it('detects a repo-manifest checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-'));
    fs.mkdirSync(path.join(root, '.repo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.repo', 'manifest.xml'), '<manifest/>');
    expect(isAospWorkspace(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not classify a normal Android app with only Android.bp as AOSP', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-app-'));
    fs.writeFileSync(path.join(root, 'Android.bp'), 'android_app { name: "demo" }');
    expect(isAospWorkspace(root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('AOSP graph wire contract additions', () => {
  it('appends generic AOSP/build node and edge kinds', () => {
    expect(NODE_KINDS.slice(-4)).toEqual(['build_target', 'service', 'resource', 'device']);
    expect(EDGE_KINDS.slice(-5)).toEqual([
      'depends_on', 'generates', 'binds', 'configures', 'overlays',
    ]);
    const rustContract = fs.readFileSync(path.join(process.cwd(), 'codegraph-kernel/src/buffers.rs'), 'utf8');
    for (const kind of [...NODE_KINDS, ...EDGE_KINDS]) expect(rustContract).toContain(`"${kind}"`);
    expect(rustContract).toContain(`NODE_KINDS: [&str; ${NODE_KINDS.length}]`);
    expect(rustContract).toContain(`EDGE_KINDS: [&str; ${EDGE_KINDS.length}]`);
  });
});

describe('AOSP test classification', () => {
  it('recognizes TEST_MAPPING and Tradefed AndroidTest XML as test inputs', () => {
    expect(isTestFile('system/demo/TEST_MAPPING')).toBe(true);
    expect(isTestFile('system/demo/AndroidTest.xml')).toBe(true);
    expect(isTestFile('system/demo/AndroidTestTemplate.xml')).toBe(true);
  });
});
