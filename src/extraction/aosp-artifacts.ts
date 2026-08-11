/**
 * Android/AOSP artifact discovery.
 *
 * AOSP's most important build and configuration inputs are commonly named by
 * convention instead of by a unique extension (`Android.bp`, `BUILD`,
 * `Kconfig`, Android's `*_contexts` files). Keeping these rules in one leaf
 * module prevents the scanner and language detector from drifting apart.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Language } from '../types';

const EXACT_FILENAMES: Readonly<Record<string, Language>> = Object.freeze({
  'Android.bp': 'blueprint',
  'Android.mk': 'make',
  'BoardConfig.mk': 'make',
  'device.mk': 'make',
  'product.mk': 'make',
  BUILD: 'starlark',
  'BUILD.bazel': 'starlark',
  WORKSPACE: 'starlark',
  'WORKSPACE.bazel': 'starlark',
  'MODULE.bazel': 'starlark',
  Kconfig: 'kconfig',
  Kbuild: 'kconfig',
  TEST_MAPPING: 'yaml',
  service_contexts: 'selinux',
  hwservice_contexts: 'selinux',
  vndservice_contexts: 'selinux',
  property_contexts: 'selinux',
  file_contexts: 'selinux',
  seapp_contexts: 'selinux',
  genfs_contexts: 'selinux',
  port_contexts: 'selinux',
  fs_use: 'selinux',
  'mac_permissions.xml': 'xml',
});

const CONTEXT_SUFFIX = /(?:^|_)(?:service|hwservice|vndservice|property|file|seapp|genfs|port)_contexts$/;

/** Return the AOSP language selected by a path-level convention, if any. */
export function detectAospArtifactLanguage(filePath: string): Language | null {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  const exact = EXACT_FILENAMES[base];
  if (exact) return exact;
  if (CONTEXT_SUFFIX.test(base)) return 'selinux';
  return null;
}

export function isAospTestMapping(filePath: string): boolean {
  return path.posix.basename(filePath.replace(/\\/g, '/')) === 'TEST_MAPPING';
}

export function isDeviceTreeBindingYaml(filePath: string, source = ''): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|\/)Documentation\/devicetree\/bindings\/.*\.ya?ml$/i.test(normalized)
    || (/\.(?:yaml|yml)$/i.test(normalized) && /(?:^|\n)\s*\$schema\s*:/.test(source) && /\bcompatible\s*:/.test(source));
}

/** Whether the path is one of AOSP's extensionless/special-name artifacts. */
export function isAospArtifactFile(filePath: string): boolean {
  return detectAospArtifactLanguage(filePath) !== null;
}

/**
 * Cheap, deterministic AOSP workspace detection. This intentionally requires
 * a strong marker (`.repo`, Soong/Make checkout, or root Android.bp plus a
 * canonical AOSP subtree) to avoid changing ordinary Android application
 * behavior merely because it happens to contain an Android.bp file.
 */
export function isAospWorkspace(rootDir: string): boolean {
  const exists = (rel: string): boolean => fs.existsSync(path.join(rootDir, rel));
  if (exists('.repo/manifest.xml')) return true;
  if (exists('build/soong') && exists('build/make')) return true;
  if (exists('Android.bp') && (exists('frameworks/base') || exists('system/core'))) return true;
  return false;
}
