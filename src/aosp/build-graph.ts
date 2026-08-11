import * as fs from 'fs';
import type { ExtractionResult, Node } from '../types';

export type AospBuildSystem = 'soong' | 'make' | 'bazel' | 'kleaf';

export interface VariantConstraint {
  expression: string;
  source: 'static' | 'authoritative';
}

export interface BuildFileRef {
  path: string;
  generated?: boolean;
}

export interface BuildTarget {
  id: string;
  system: AospBuildSystem;
  name: string;
  packagePath: string;
  targetType: string;
  sources: BuildFileRef[];
  generatedOutputs: BuildFileRef[];
  dependencies: string[];
  variants: VariantConstraint[];
  metadata: Record<string, unknown>;
}

export interface BuildGraphProvider {
  readonly id: string;
  discover(): Promise<BuildTarget[]> | BuildTarget[];
}

export interface SelectedKernelConfig {
  symbol: string;
  value: string;
  enabled: boolean;
}

/** Parse an existing kernel .config/defconfig; never invokes Kconfig tools. */
export class KernelConfigProvider {
  constructor(private readonly configPath: string) {}

  discover(): SelectedKernelConfig[] {
    const rows: SelectedKernelConfig[] = [];
    for (const raw of fs.readFileSync(this.configPath, 'utf8').split(/\r?\n/)) {
      const disabled = /^#\s*(CONFIG_[A-Z0-9_]+) is not set$/.exec(raw);
      if (disabled) { rows.push({ symbol: disabled[1]!, value: 'n', enabled: false }); continue; }
      const selected = /^(CONFIG_[A-Z0-9_]+)=(.*)$/.exec(raw);
      if (selected) rows.push({ symbol: selected[1]!, value: selected[2]!, enabled: selected[2] !== 'n' });
    }
    return rows;
  }
}

export interface AospExtractionRecord {
  filePath: string;
  result: ExtractionResult;
}

function directoryOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

function buildSystemFor(node: Node): AospBuildSystem {
  if (node.language === 'blueprint') return 'soong';
  if (node.language === 'make') return 'make';
  const type = node.signature?.toLowerCase() ?? '';
  return /kernel|kleaf|ddk|dtb|dtbo/.test(type) ? 'kleaf' : 'bazel';
}

/** Convert the normal extraction stream into the shared AOSP build model. */
export class StaticExtractionBuildGraphProvider implements BuildGraphProvider {
  readonly id = 'aosp-static-extraction';
  constructor(private readonly records: readonly AospExtractionRecord[]) {}

  discover(): BuildTarget[] {
    const targets: BuildTarget[] = [];
    for (const { filePath, result } of this.records) {
      const byId = new Map(result.nodes.map((n) => [n.id, n]));
      for (const node of result.nodes) {
        if (node.kind !== 'build_target') continue;
        const refs = result.unresolvedReferences.filter((r) => r.fromNodeId === node.id);
        const generated = result.edges
          .filter((e) => e.source === node.id && e.kind === 'generates')
          .map((e) => byId.get(e.target))
          .filter((n): n is Node => !!n);
        targets.push({
          id: `${buildSystemFor(node)}:${node.qualifiedName}`,
          system: buildSystemFor(node),
          name: node.name,
          packagePath: directoryOf(filePath),
          targetType: node.signature ?? 'unknown',
          sources: refs
            .filter((r) => r.referenceKind === 'references')
            .map((r) => ({ path: r.referenceName })),
          generatedOutputs: generated.map((n) => ({ path: n.name, generated: true })),
          dependencies: refs
            .filter((r) => r.referenceKind === 'depends_on')
            .map((r) => r.referenceName),
          variants: refs.flatMap((r) => {
            const variant = r.metadata?.variant;
            return (Array.isArray(variant) ? variant.filter((value): value is string => typeof value === 'string') : [])
              .map((expression) => ({ expression, source: 'static' as const }));
          }),
          metadata: { sourceFile: filePath, extractionNodeId: node.id },
        });
      }
    }
    return targets;
  }
}

interface ModuleInfoEntry {
  path?: string[];
  dependencies?: string[];
  required?: string[];
  installed?: string[];
  module_name?: string;
  class?: string[];
  test_config?: string[];
  compatibility_suites?: string[];
  variants?: string[];
  [key: string]: unknown;
}

/**
 * Authoritative Make/Soong provider for an existing product's module-info.json.
 * It reads metadata only and never invokes the Android build.
 */
export class ModuleInfoBuildGraphProvider implements BuildGraphProvider {
  readonly id = 'aosp-module-info';
  constructor(private readonly moduleInfoPath: string, private readonly product?: string) {}

  discover(): BuildTarget[] {
    const parsed = JSON.parse(fs.readFileSync(this.moduleInfoPath, 'utf8')) as Record<string, ModuleInfoEntry>;
    const targets: BuildTarget[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const name = typeof value.module_name === 'string' ? value.module_name : key;
      const paths = Array.isArray(value.path) ? value.path.filter((p): p is string => typeof p === 'string') : [];
      const dependencies = [
        ...(Array.isArray(value.dependencies) ? value.dependencies : []),
        ...(Array.isArray(value.required) ? value.required : []),
      ].filter((v): v is string => typeof v === 'string');
      const variants = Array.isArray(value.variants)
        ? value.variants.filter((v): v is string => typeof v === 'string')
        : this.product ? [this.product] : [];
      targets.push({
        id: `module-info:${name}:${paths[0] ?? ''}:${variants.join(',')}`,
        system: 'soong',
        name,
        packagePath: paths[0] ?? '',
        targetType: Array.isArray(value.class) ? value.class.join(',') : 'module',
        sources: [],
        generatedOutputs: (Array.isArray(value.installed) ? value.installed : [])
          .filter((p): p is string => typeof p === 'string')
          .map((p) => ({ path: p, generated: true })),
        dependencies,
        variants: variants.map((expression) => ({ expression, source: 'authoritative' })),
        metadata: {
          authoritative: true,
          moduleInfoPath: this.moduleInfoPath,
          allPaths: paths,
          testConfig: value.test_config ?? [],
          compatibilitySuites: value.compatibility_suites ?? [],
        },
      });
    }
    return targets;
  }
}

interface BazelQueryTarget {
  label?: string;
  ruleClass?: string;
  rule_class?: string;
  dependencies?: string[];
  deps?: string[];
  sources?: string[];
  srcs?: string[];
  outputs?: string[];
  configuration?: string;
}

interface BazelProtoAttribute {
  name?: string;
  stringValue?: string;
  string_value?: string;
  stringListValue?: string[];
  string_list_value?: string[];
}

interface BazelProtoRule {
  name?: string;
  ruleClass?: string;
  rule_class?: string;
  attribute?: BazelProtoAttribute[];
  ruleInput?: string[];
  rule_input?: string[];
  ruleOutput?: string[];
  rule_output?: string[];
  configuredRuleInput?: Array<{ label?: string; configurationChecksum?: string; configuration_checksum?: string }>;
  configured_rule_input?: Array<{ label?: string; configurationChecksum?: string; configuration_checksum?: string }>;
}

interface BazelProtoTarget { rule?: BazelProtoRule }
interface BazelConfiguredTarget {
  target?: BazelProtoTarget;
  configurationId?: number | string;
  configuration_id?: number | string;
  configuration?: { mnemonic?: string; checksum?: string };
}

const BAZEL_SOURCE_ATTRS = new Set(['srcs', 'hdrs', 'textual_hdrs', 'data']);
const BAZEL_DEP_ATTRS = new Set(['deps', 'implementation_deps', 'exports', 'tools', 'runtime_deps', 'plugins']);

function protoAttributeValues(attribute: BazelProtoAttribute): string[] {
  const list = attribute.stringListValue ?? attribute.string_list_value;
  if (Array.isArray(list)) return list.filter((value): value is string => typeof value === 'string');
  const scalar = attribute.stringValue ?? attribute.string_value;
  return typeof scalar === 'string' ? [scalar] : [];
}

function bazelLabelToPath(label: string): string {
  const external = /^@{1,2}([^/]+)\/\/([^:]*)(?::(.*))?$/.exec(label);
  if (external) return ['external', external[1], external[2], external[3]].filter(Boolean).join('/');
  if (!label.startsWith('//')) return label.replace(/^:/, '');
  const [pkg, name = ''] = label.slice(2).split(':', 2);
  return pkg && name ? `${pkg}/${name}` : pkg || name;
}

function normalizeBazelDependency(label: string, owner: string): string {
  if (!label.startsWith(':')) return label;
  const colon = owner.lastIndexOf(':');
  return `${colon >= 0 ? owner.slice(0, colon) : owner}${label}`;
}

function normalizeProtoRule(rule: BazelProtoRule, configuration?: string): BazelQueryTarget | null {
  if (!rule.name) return null;
  const attributes = Array.isArray(rule.attribute) ? rule.attribute : [];
  const sources = attributes
    .filter((attribute) => attribute.name && BAZEL_SOURCE_ATTRS.has(attribute.name))
    .flatMap(protoAttributeValues);
  const attributeDeps = attributes
    .filter((attribute) => attribute.name && BAZEL_DEP_ATTRS.has(attribute.name))
    .flatMap(protoAttributeValues);
  const configuredInputs = (rule.configuredRuleInput ?? rule.configured_rule_input ?? [])
    .map((input) => input.label)
    .filter((label): label is string => typeof label === 'string');
  const allInputs = (rule.ruleInput ?? rule.rule_input ?? []).filter((label): label is string => typeof label === 'string');
  const sourceSet = new Set(sources);
  const dependencies = configuredInputs.length > 0
    ? configuredInputs
    : attributeDeps.length > 0 ? attributeDeps : allInputs.filter((label) => !sourceSet.has(label));
  return {
    label: rule.name,
    ruleClass: rule.ruleClass ?? rule.rule_class,
    sources: sources.map(bazelLabelToPath),
    dependencies: dependencies.map((label) => normalizeBazelDependency(label, rule.name!)),
    outputs: (rule.ruleOutput ?? rule.rule_output ?? []).map(bazelLabelToPath),
    configuration,
  };
}

function normalizeBazelQueryRows(parsed: unknown): BazelQueryTarget[] {
  if (Array.isArray(parsed)) return parsed as BazelQueryTarget[];
  if (!parsed || typeof parsed !== 'object') return [];
  const envelope = parsed as {
    targets?: BazelQueryTarget[];
    target?: BazelProtoTarget[];
    results?: BazelConfiguredTarget[];
    configurations?: Array<{ id?: number | string; mnemonic?: string; checksum?: string }>;
  };
  if (Array.isArray(envelope.targets)) return envelope.targets;
  if (Array.isArray(envelope.target)) {
    return envelope.target.flatMap((target) => {
      const row = target.rule ? normalizeProtoRule(target.rule) : null;
      return row ? [row] : [];
    });
  }
  if (Array.isArray(envelope.results)) {
    const configurations = new Map((envelope.configurations ?? []).map((config) => [String(config.id), config]));
    return envelope.results.flatMap((configured) => {
      if (!configured.target?.rule) return [];
      const id = configured.configurationId ?? configured.configuration_id;
      const config = configured.configuration ?? (id !== undefined ? configurations.get(String(id)) : undefined);
      const configuration = config?.mnemonic ?? config?.checksum ?? (id !== undefined ? String(id) : undefined);
      const row = normalizeProtoRule(configured.target.rule, configuration);
      return row ? [row] : [];
    });
  }
  return [];
}

/** Import a previously captured machine-readable Bazel query/cquery result. */
export class BazelQueryBuildGraphProvider implements BuildGraphProvider {
  readonly id = 'aosp-bazel-query';
  constructor(private readonly queryPath: string) {}

  discover(): BuildTarget[] {
    const parsed = JSON.parse(fs.readFileSync(this.queryPath, 'utf8')) as unknown;
    const rows = normalizeBazelQueryRows(parsed);
    return rows.flatMap((row): BuildTarget[] => {
      if (!row.label || typeof row.label !== 'string') return [];
      const colon = row.label.lastIndexOf(':');
      const packagePath = row.label.startsWith('//')
        ? row.label.slice(2, colon >= 0 ? colon : undefined)
        : '';
      const name = colon >= 0 ? row.label.slice(colon + 1) : row.label.split('/').pop()!;
      const targetType = row.ruleClass ?? row.rule_class ?? 'bazel_target';
      const system: AospBuildSystem = /kernel|kleaf|ddk|dtb|dtbo/i.test(targetType) ? 'kleaf' : 'bazel';
      return [{
        id: `bazel-query:${row.label}:${row.configuration ?? ''}`,
        system,
        name,
        packagePath,
        targetType,
        sources: (row.sources ?? row.srcs ?? []).filter((v): v is string => typeof v === 'string').map((p) => ({ path: p })),
        generatedOutputs: (row.outputs ?? []).filter((v): v is string => typeof v === 'string').map((p) => ({ path: p, generated: true })),
        dependencies: (row.dependencies ?? row.deps ?? []).filter((v): v is string => typeof v === 'string'),
        variants: row.configuration ? [{ expression: row.configuration, source: 'authoritative' }] : [],
        metadata: { authoritative: true, bazelQueryPath: this.queryPath, label: row.label },
      }];
    });
  }
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Merge static evidence with authoritative selected-product metadata. Static
 * source ownership is retained; authoritative dependency/variant information
 * wins when the same module and package are present.
 */
export function mergeBuildTargets(staticTargets: readonly BuildTarget[], authoritativeTargets: readonly BuildTarget[]): BuildTarget[] {
  const out = new Map<string, BuildTarget>();
  const keyOf = (t: BuildTarget): string => `${t.name}\0${t.packagePath}`;
  for (const target of staticTargets) out.set(keyOf(target), { ...target });
  for (const authoritative of authoritativeTargets) {
    const key = keyOf(authoritative);
    const current = out.get(key);
    if (!current) { out.set(key, { ...authoritative }); continue; }
    out.set(key, {
      ...current,
      id: authoritative.id,
      targetType: authoritative.targetType === 'module' ? current.targetType : authoritative.targetType,
      dependencies: stableUnique(authoritative.dependencies),
      sources: current.sources,
      generatedOutputs: [...current.generatedOutputs, ...authoritative.generatedOutputs]
        .filter((v, i, all) => all.findIndex((x) => x.path === v.path) === i),
      variants: authoritative.variants,
      metadata: { ...current.metadata, ...authoritative.metadata, staticTargetId: current.id },
    });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export class AospBuildGraph {
  private readonly byId = new Map<string, BuildTarget>();
  private readonly byName = new Map<string, BuildTarget[]>();
  private readonly owners = new Map<string, BuildTarget[]>();

  constructor(targets: readonly BuildTarget[]) {
    for (const target of targets) {
      this.byId.set(target.id, target);
      this.byName.set(target.name, [...(this.byName.get(target.name) ?? []), target]);
      for (const source of target.sources) {
        const normalized = source.path.replace(/\\/g, '/');
        this.owners.set(normalized, [...(this.owners.get(normalized) ?? []), target]);
        if (target.packagePath && !normalized.startsWith('/') && !normalized.startsWith(`${target.packagePath}/`)) {
          const rooted = `${target.packagePath}/${normalized}`;
          this.owners.set(rooted, [...(this.owners.get(rooted) ?? []), target]);
        }
      }
    }
  }

  targets(): BuildTarget[] { return [...this.byId.values()]; }
  findByName(name: string): BuildTarget[] { return [...(this.byName.get(name) ?? [])]; }
  owningTargets(filePath: string): BuildTarget[] { return [...(this.owners.get(filePath.replace(/\\/g, '/')) ?? [])]; }

  dependencyClosure(targetId: string): BuildTarget[] {
    const root = this.byId.get(targetId);
    if (!root) return [];
    const result: BuildTarget[] = [];
    const queue = [...root.dependencies];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const target of this.byName.get(name) ?? []) {
        result.push(target);
        queue.push(...target.dependencies);
      }
    }
    return result;
  }

  /** Return test modules transitively affected by changed owned sources. */
  impactedTests(changedFiles: readonly string[]): BuildTarget[] {
    const reverse = new Map<string, BuildTarget[]>();
    for (const target of this.byId.values()) {
      for (const dependency of target.dependencies) reverse.set(dependency, [...(reverse.get(dependency) ?? []), target]);
    }
    const queue = changedFiles.flatMap((file) => this.owningTargets(file));
    const visited = new Set<string>();
    const impacted: BuildTarget[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const metadata = current.metadata as { testConfig?: unknown[]; compatibilitySuites?: unknown[] };
      if (/TEST/i.test(current.targetType)
        || (Array.isArray(metadata.testConfig) && metadata.testConfig.length > 0)
        || (Array.isArray(metadata.compatibilitySuites) && metadata.compatibilitySuites.length > 0)) impacted.push(current);
      queue.push(...(reverse.get(current.name) ?? []));
    }
    return impacted.sort((a, b) => a.id.localeCompare(b.id));
  }
}
