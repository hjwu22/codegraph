import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { buildDefaultIgnore, buildScopeIgnore } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-xml-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  clearProjectConfigCache();
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('Android semantic XML extraction', () => {
  it('extracts Tradefed tests, preparers, filters, and module dependencies', () => {
    const result = extractFromSource('system/demo/AndroidTest.xml', `
      <configuration description="Demo device test">
        <target_preparer class="com.android.tradefed.targetprep.RootTargetPreparer" />
        <test class="com.android.tradefed.testtype.AndroidJUnitTest" />
        <option name="module" value="DemoTests" />
        <option name="include-filter" value="DemoClass#works" />
      </configuration>
    `);
    const config = result.nodes.find((n) => n.kind === 'build_target');
    expect(config?.signature).toBe('Tradefed test configuration');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromNodeId: config?.id, referenceName: 'com.android.tradefed.testtype.AndroidJUnitTest', referenceKind: 'calls' }),
      expect.objectContaining({ referenceName: 'DemoTests', referenceKind: 'depends_on' }),
      expect.objectContaining({ referenceName: 'DemoClass#works', referenceKind: 'configures' }),
    ]));
  });
  it('extracts manifest components, class references, permissions, and RRO target', () => {
    const result = extractFromSource('packages/apps/Demo/AndroidManifest.xml', `
      <manifest package="com.acme.demo" xmlns:android="http://schemas.android.com/apk/res/android">
        <uses-permission android:name="android.permission.CAMERA" />
        <overlay android:targetPackage="android" />
        <application android:name=".DemoApp">
          <activity android:name=".MainActivity" />
          <service android:name="com.acme.demo.SyncService" />
          <provider android:name=".DemoProvider" android:authorities="com.acme.demo.provider" />
        </application>
      </manifest>
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'module', name: 'com.acme.demo' }),
      expect.objectContaining({ kind: 'component', qualifiedName: 'com.acme.demo.MainActivity' }),
      expect.objectContaining({ kind: 'service', qualifiedName: 'com.acme.demo.SyncService' }),
      expect.objectContaining({ kind: 'resource', name: 'android.permission.CAMERA' }),
      expect.objectContaining({ kind: 'resource', name: 'com.acme.demo.provider' }),
    ]));
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'com.acme.demo.MainActivity', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: 'android', referenceKind: 'overlays' }),
    ]));
  });

  it('extracts runtime resource overlay mapping entries', () => {
    const result = extractFromSource('vendor/acme/overlay/resourcesMap.xml', `
      <resource-mappings>
        <item value="@color/acme_accent" target="@color/system_accent" />
      </resource-mappings>
    `);
    const mapping = result.nodes.find((node) => node.signature === 'RRO resource mapping');
    expect(mapping).toMatchObject({ qualifiedName: '@color/system_accent' });
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
      fromNodeId: mapping!.id, referenceName: '@color/acme_accent', referenceKind: 'overlays',
    }));
  });

  it('extracts resource declarations and symbolic references', () => {
    const result = extractFromSource('frameworks/base/core/res/res/values/styles.xml', `
      <resources>
        <color name="accent">@color/system_accent</color>
        <style name="Theme.Demo" parent="Theme.Material">
          <item name="android:textColor">@color/accent</item>
        </style>
      </resources>
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'resource', qualifiedName: '@color/accent' }),
      expect.objectContaining({ kind: 'resource', qualifiedName: '@style/Theme.Demo' }),
    ]));
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: '@style/Theme.Material', referenceKind: 'extends' }),
      expect.objectContaining({ referenceName: '@color/system_accent', referenceKind: 'references' }),
    ]));
  });

  it('extracts layout class, onClick, and resource references', () => {
    const result = extractFromSource('packages/apps/Demo/res/layout/main.xml', `
      <com.acme.demo.Widget android:id="@+id/widget" android:onClick="onWidgetClick" />
    `);
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'com.acme.demo.Widget', referenceKind: 'references' }),
      expect.objectContaining({ referenceName: 'onWidgetClick', referenceKind: 'calls' }),
      expect.objectContaining({ referenceName: '@id/widget', referenceKind: 'references' }),
    ]));
  });

  it('extracts VINTF HAL versions and instances', () => {
    const result = extractFromSource('device/acme/manifest.xml', `
      <manifest version="1.0" type="device">
        <hal format="hidl">
          <name>android.hardware.foo</name><version>2.0</version>
          <transport>hwbinder</transport>
          <fqname>IFoo/default</fqname>
          <interface><name>IFoo</name><instance>default</instance></interface>
        </hal>
      </manifest>
    `);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'service', qualifiedName: 'vintf:android.hardware.foo@2.0', signature: expect.stringContaining('transport=hwbinder') }),
      expect.objectContaining({ kind: 'service', qualifiedName: 'android.hardware.foo::IFoo/default' }),
    ]));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'IFoo/default', referenceKind: 'binds' }));
  });
});

describe('AOSP Android resource scan policy', () => {
  it('indexes Android resources inside a detected AOSP workspace', () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, '.repo'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.repo', 'manifest.xml'), '<manifest/>');
    expect(buildDefaultIgnore(dir).ignores('frameworks/base/core/res/res/values/strings.xml')).toBe(false);
    expect(buildScopeIgnore(dir, []).ignores('frameworks/base/core/res/res/layout/main.xml')).toBe(false);
  });

  it('restores root AOSP build/vendor source trees but keeps generated and nested copies excluded', () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, '.repo'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.repo', 'manifest.xml'), '<manifest/>');
    const matcher = buildDefaultIgnore(dir);
    expect(matcher.ignores('build/soong/Android.bp')).toBe(false);
    expect(matcher.ignores('vendor/acme/sepolicy/domain.te')).toBe(false);
    expect(matcher.ignores('third_party/tool/build/generated.ts')).toBe(true);
    expect(matcher.ignores('third_party/tool/vendor/dependency.go')).toBe(true);
    expect(matcher.ignores('out/target/product/demo/system.img')).toBe(true);
    expect(matcher.ignores('.repo/projects/system.git/objects/pack')).toBe(true);
  });

  it('keeps the existing resource exclusion for ordinary Android apps', () => {
    const dir = root();
    expect(buildDefaultIgnore(dir).ignores('app/src/main/res/values/strings.xml')).toBe(true);
    expect(buildDefaultIgnore(dir).ignores('build/generated.ts')).toBe(true);
    expect(buildDefaultIgnore(dir).ignores('vendor/dependency.go')).toBe(true);
  });

  it('allows an AOSP project to disable resource indexing explicitly', () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, '.repo'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.repo', 'manifest.xml'), '<manifest/>');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ aosp: { indexAndroidResources: false } }));
    expect(buildDefaultIgnore(dir).ignores('frameworks/base/core/res/res/values/strings.xml')).toBe(true);
  });

  it('allows a standalone platform repository to force-enable the AOSP resource profile', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ aosp: { enabled: true } }));
    expect(buildDefaultIgnore(dir).ignores('frameworks/base/core/res/res/values/strings.xml')).toBe(false);
  });

  it('lets enabled=false override automatic AOSP workspace detection', () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, '.repo'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.repo', 'manifest.xml'), '<manifest/>');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ aosp: { enabled: false } }));
    expect(buildDefaultIgnore(dir).ignores('frameworks/base/core/res/res/values/strings.xml')).toBe(true);
  });
});
