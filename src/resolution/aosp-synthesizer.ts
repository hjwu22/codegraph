/**
 * Cross-language AOSP graph synthesis.
 *
 * AOSP deliberately crosses language-family boundaries through generated or
 * runtime bindings. Normal name resolution rejects those collisions, so the
 * bridges below require protocol-specific evidence (JNI encoding or native
 * table, AIDL naming convention, Device Tree compatible, init executable).
 */
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import type { Edge, Node, NodeKind } from '../types';
import type { ResolutionContext } from './types';

export interface GraphSynthesizer {
  readonly id: string;
  synthesize(context: ResolutionContext): Edge[];
}

function nodesOf(context: ResolutionContext, kind: NodeKind): Node[] {
  return context.iterateNodesByKind
    ? [...context.iterateNodesByKind(kind)]
    : context.getNodesByKind(kind);
}

function edge(source: Node, target: Node, kind: Edge['kind'], id: string, evidence: string[], confidence: 'exact' | 'strong' | 'heuristic'): Edge {
  return {
    source: source.id,
    target: target.id,
    kind,
    provenance: 'heuristic',
    line: source.startLine,
    metadata: { synthesizedBy: id, evidence, confidence },
  };
}

function uniqueEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.source}\0${e.target}\0${e.kind}\0${String(e.metadata?.synthesizedBy)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLine(context: ResolutionContext, node: Node): string {
  const lines = context.getFileLines?.(node.filePath)
    ?? context.readFile(node.filePath)?.split(/\r?\n/)
    ?? [];
  return lines[node.startLine - 1] ?? '';
}

function decodeJniPart(encoded: string): string {
  return encoded
    .replace(/_0([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/_1/g, '\u0000')
    .replace(/_2/g, ';')
    .replace(/_3/g, '[')
    .replace(/_/g, '.')
    .replace(/\u0000/g, '_');
}

function normalizedJvmQualifiedName(node: Node): string {
  return node.qualifiedName.replace(/::/g, '.').replace(/\//g, '.');
}

function splitParameters(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '<' || value[i] === '(' || value[i] === '[') depth++;
    else if (value[i] === '>' || value[i] === ')' || value[i] === ']') depth = Math.max(0, depth - 1);
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  out.push(value.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

/** JNI parameter descriptor for source signatures; null means “do not guess”. */
function jniParameterDescriptor(node: Node): string | null {
  const params = /\((.*)\)/.exec(node.signature ?? '')?.[1];
  if (params === undefined) return null;
  if (!params.trim()) return '';
  const primitive: Record<string, string> = {
    boolean: 'Z', Boolean: 'Z', byte: 'B', Byte: 'B', char: 'C', Char: 'C',
    short: 'S', Short: 'S', int: 'I', Int: 'I', long: 'J', Long: 'J',
    float: 'F', Float: 'F', double: 'D', Double: 'D',
  };
  const javaLang = new Set(['String', 'Object', 'Class', 'Throwable', 'CharSequence']);
  const qn = normalizedJvmQualifiedName(node);
  const owner = qn.slice(0, Math.max(0, qn.length - node.name.length - 1));
  const ownerPackage = owner.includes('.') ? owner.slice(0, owner.lastIndexOf('.')) : '';
  let descriptor = '';
  for (let raw of splitParameters(params)) {
    raw = raw.replace(/@[A-Za-z_]\w*(?:\([^)]*\))?\s*/g, '').replace(/\b(?:final|vararg|crossinline|noinline)\b\s*/g, '').trim();
    let type: string;
    const kotlin = /^(\w+)\s*:\s*(.+)$/.exec(raw);
    if (kotlin) type = kotlin[2]!.trim();
    else {
      const words = raw.split(/\s+/);
      if (words.length < 2) return null;
      type = words.slice(0, -1).join(' ');
    }
    let arrays = 0;
    if (type.endsWith('...')) { arrays++; type = type.slice(0, -3); }
    while (/\[\]$/.test(type)) { arrays++; type = type.slice(0, -2); }
    type = type.replace(/<[^<>]*>/g, '').replace(/\?$/, '').trim();
    let encoded = primitive[type];
    if (!encoded) {
      const fqcn = type.includes('.') ? type : javaLang.has(type) ? `java.lang.${type}` : ownerPackage ? `${ownerPackage}.${type}` : '';
      if (!fqcn || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(fqcn)) return null;
      encoded = `L${fqcn.replace(/\./g, '/')};`;
    }
    descriptor += '['.repeat(arrays) + encoded;
  }
  return descriptor;
}

function mangleJniDescriptor(descriptor: string): string {
  return descriptor.replace(/_/g, '_1').replace(/;/g, '_2').replace(/\[/g, '_3').replace(/\//g, '_');
}

export const jniSynthesizer: GraphSynthesizer = {
  id: 'aosp-jni',
  synthesize(context): Edge[] {
    const jvmMethods = nodesOf(context, 'method').filter((n) => n.language === 'java' || n.language === 'kotlin');
    if (jvmMethods.length === 0) return [];
    const methods = jvmMethods.filter((n) => {
      if (n.language !== 'java' && n.language !== 'kotlin') return false;
      const declaration = `${n.signature ?? ''} ${sourceLine(context, n)}`;
      return /\bnative\b|\bexternal\b/.test(declaration);
    });
    const byName = new Map<string, Node[]>();
    for (const method of methods) {
      const list = byName.get(method.name) ?? [];
      list.push(method);
      byName.set(method.name, list);
    }

    const nativeFunctions = [
      ...nodesOf(context, 'function'),
      ...nodesOf(context, 'method'),
    ].filter((n) => n.language === 'c' || n.language === 'cpp');
    const out: Edge[] = [];

    // Name-based JNI: Java_pkg_Class_method[__signature].
    for (const fn of nativeFunctions) {
      if (!fn.name.startsWith('Java_')) continue;
      const symbol = fn.name.slice('Java_'.length);
      const signatureMarker = symbol.indexOf('__');
      const base = signatureMarker >= 0 ? symbol.slice(0, signatureMarker) : symbol;
      const encodedSignature = signatureMarker >= 0 ? symbol.slice(signatureMarker + 2) : null;
      const candidates: Array<{ method: Node; score: number }> = [];
      for (const [methodName, matching] of byName) {
        const encodedSuffix = `_${methodName.replace(/_/g, '_1')}`;
        if (!base.endsWith(encodedSuffix)) continue;
        const classPart = decodeJniPart(base.slice(0, -encodedSuffix.length));
        for (const method of matching) {
          const qn = normalizedJvmQualifiedName(method);
          const owner = qn.slice(0, -(method.name.length + 1));
          const score = owner === classPart ? 3 : owner.endsWith(`.${classPart}`) || classPart.endsWith(`.${owner}`) ? 2 : owner.endsWith(classPart) ? 1 : 0;
          const descriptor = encodedSignature === null ? null : jniParameterDescriptor(method);
          if (score > 0 && (encodedSignature === null || (descriptor !== null && mangleJniDescriptor(descriptor) === encodedSignature))) {
            candidates.push({ method, score });
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length === 0 || (candidates[1] && candidates[1].score === candidates[0]!.score)) continue;
      out.push(edge(candidates[0]!.method, fn, 'calls', this.id, [`JNI symbol ${fn.name}`, fn.filePath], 'exact'));
    }

    // Dynamic registration: JNINativeMethod entries plus a class literal in
    // RegisterMethodsOrDie/jniRegisterNativeMethods/FindClass.
    for (const filePath of context.getAllFiles()) {
      if (!/\.(?:c|cc|cpp|cxx|h|hpp)$/i.test(filePath)) continue;
      const content = context.readFile(filePath);
      if (!content || !/(?:JNINativeMethod|RegisterMethodsOrDie|RegisterNatives|jniRegisterNativeMethods)/.test(content)) continue;
      const classMatch = /(?:RegisterMethodsOrDie|jniRegisterNativeMethods|FindClass)\s*\([^\n]*?["']([\w/$]+)["']/.exec(content);
      const owner = classMatch?.[1]?.replace(/\$/g, '.').replace(/\//g, '.');
      for (const entry of content.matchAll(/\{\s*["'](\w+)["']\s*,\s*["']([^"']*)["']\s*,\s*(?:reinterpret_cast<[^>]+>\s*\(|\(\s*void\s*\*\s*\)\s*)?&?([A-Za-z_]\w*)/g)) {
        const methodName = entry[1]!;
        const fnName = entry[3]!;
        const fnCandidates = nativeFunctions.filter((n) => n.name === fnName && n.filePath === filePath);
        if (fnCandidates.length !== 1) continue;
        let javaCandidates = byName.get(methodName) ?? [];
        if (owner) javaCandidates = javaCandidates.filter((n) => normalizedJvmQualifiedName(n).startsWith(`${owner}.`));
        const nativeParams = /^\((.*)\)/.exec(entry[2]!)?.[1];
        if (nativeParams !== undefined) {
          const described = javaCandidates.map((method) => ({ method, descriptor: jniParameterDescriptor(method) }));
          if (described.some((candidate) => candidate.descriptor !== null)) {
            javaCandidates = described.filter((candidate) => candidate.descriptor === nativeParams).map((candidate) => candidate.method);
          }
        }
        if (javaCandidates.length !== 1) continue;
        out.push(edge(javaCandidates[0]!, fnCandidates[0]!, 'calls', this.id,
          [`JNINativeMethod ${methodName}${entry[2]}`, owner ?? 'class unresolved', filePath], owner ? 'exact' : 'strong'));
      }
    }

    // Reverse JNI callback: native code looks up a class and method by exact
    // string literals, then invokes it through Call*Method. Requiring all three
    // signals avoids turning incidental strings into cross-language calls.
    for (const fn of nativeFunctions) {
      const lines = context.getFileLines?.(fn.filePath) ?? context.readFile(fn.filePath)?.split(/\r?\n/) ?? [];
      const body = lines.slice(Math.max(0, fn.startLine - 1), Math.max(fn.startLine, fn.endLine)).join('\n');
      if (!/\bCall(?:Static|Nonvirtual)?\w*Method\s*\(/.test(body)) continue;
      const classLiteral = /\bFindClass\s*\(\s*["']([\w/$]+)["']\s*\)/.exec(body)?.[1];
      if (!classLiteral) continue;
      const owner = classLiteral.replace(/\$/g, '.').replace(/\//g, '.');
      for (const lookup of body.matchAll(/\bGet(?:Static)?MethodID\s*\([^,]+,\s*["'](\w+)["']\s*,\s*["']([^"']*)["']/g)) {
        const candidates = jvmMethods.filter((method) => method.name === lookup[1]
          && normalizedJvmQualifiedName(method).startsWith(`${owner}.`));
        if (candidates.length !== 1) continue;
        out.push(edge(fn, candidates[0]!, 'calls', this.id,
          [`FindClass ${classLiteral}`, `GetMethodID ${lookup[1]}${lookup[2]}`, 'Call*Method'], 'exact'));
      }
    }
    return uniqueEdges(out);
  },
};

export const aidlBinderSynthesizer: GraphSynthesizer = {
  id: 'aosp-aidl-binder',
  synthesize(context): Edge[] {
    const interfaces = nodesOf(context, 'interface').filter((n) => n.language === 'aidl');
    if (interfaces.length === 0) return [];
    const types = [
      ...nodesOf(context, 'class'),
      ...nodesOf(context, 'struct'),
      ...nodesOf(context, 'interface'),
    ].filter((n) => ['java', 'kotlin', 'c', 'cpp', 'rust'].includes(n.language));
    const methods = nodesOf(context, 'method');
    const out: Edge[] = [];

    const typesByName = new Map<string, Node[]>();
    const typesByDeclaredBinding = new Map<string, Node[]>();
    for (const type of types) {
      typesByName.set(type.name, [...(typesByName.get(type.name) ?? []), type]);
      const declaration = sourceLine(context, type);
      if (!/(?:\bimplements\b|\bextends\b|(?<!:):(?!:))/.test(declaration)) continue;
      const clauses = [
        ...[...declaration.matchAll(/\b(?:implements|extends)\s+([^\{]+)/g)].map((match) => match[1]!),
        ...[...declaration.matchAll(/(?<!:):(?!:)\s*([^={]+)/g)].map((match) => match[1]!),
      ];
      for (const clause of clauses) {
        for (const token of clause.matchAll(/[A-Za-z_]\w*(?:(?:::|\.)[A-Za-z_]\w*)*/g)) {
          const bare = token[0].split(/::|\./).pop()!;
          typesByDeclaredBinding.set(bare, [...(typesByDeclaredBinding.get(bare) ?? []), type]);
        }
      }
    }

    const aidlMethodsByOwner = new Map<string, Node[]>();
    const implementationMethodsByName = new Map<string, Node[]>();
    for (const method of methods) {
      if (method.language === 'aidl') {
        const owner = method.qualifiedName.slice(0, method.qualifiedName.lastIndexOf('::'));
        aidlMethodsByOwner.set(owner, [...(aidlMethodsByOwner.get(owner) ?? []), method]);
      } else {
        implementationMethodsByName.set(method.name, [...(implementationMethodsByName.get(method.name) ?? []), method]);
      }
    }

    for (const iface of interfaces) {
      const base = iface.name.startsWith('I') ? iface.name.slice(1) : iface.name;
      const generatedNames = [iface.name, `Bn${base}`, `Bp${base}`, `${iface.name}Stub`, `${base}Stub`, `${base}Service`];
      const boundTypes = [...new Map([
        ...generatedNames.flatMap((name) => typesByName.get(name) ?? []),
        ...(typesByDeclaredBinding.get(iface.name) ?? []),
      ].map((type) => [type.id, type])).values()];
      for (const target of boundTypes) {
        if (target.id === iface.id) continue;
        out.push(edge(iface, target, 'binds', this.id, [`AIDL interface ${iface.qualifiedName}`, `binding type ${target.name}`], 'strong'));
      }

      const aidlMethods = aidlMethodsByOwner.get(iface.qualifiedName) ?? [];
      const boundOwnerPrefixes = [...new Set(boundTypes.map((type) => `${type.qualifiedName}::`))];
      for (const method of aidlMethods) {
        const candidates = (implementationMethodsByName.get(method.name) ?? [])
          .filter((candidate) => boundOwnerPrefixes.some((prefix) => candidate.qualifiedName.startsWith(prefix)));
        for (const target of candidates) {
          out.push(edge(method, target, 'binds', this.id, [`AIDL method ${method.signature ?? method.name}`, `binding owner ${target.qualifiedName}`], 'strong'));
        }
      }
    }
    return uniqueEdges(out);
  },
};

export const deviceTreeDriverSynthesizer: GraphSynthesizer = {
  id: 'aosp-devicetree-driver',
  synthesize(context): Edge[] {
    const devices = nodesOf(context, 'device').filter((n) => n.language === 'devicetree' && n.signature?.includes('compatible='));
    if (devices.length === 0) return [];
    const functions = nodesOf(context, 'function').filter((n) => n.language === 'c' || n.language === 'cpp');
    const probesByFile = new Map<string, Node[]>();
    for (const fn of functions) {
      if (!/(?:probe|bind|init)$/i.test(fn.name)) continue;
      probesByFile.set(fn.filePath, [...(probesByFile.get(fn.filePath) ?? []), fn]);
    }
    const compatibleToProbes = new Map<string, Node[]>();
    for (const [filePath, probes] of probesByFile) {
      const content = context.readFile(filePath);
      if (!content) continue;
      for (const match of content.matchAll(/\.compatible\s*=\s*["']([^"']+)["']/g)) {
        compatibleToProbes.set(match[1]!, [...(compatibleToProbes.get(match[1]!) ?? []), ...probes]);
      }
    }
    const out: Edge[] = [];
    for (const device of devices) {
      const compatibles = device.signature!.slice(device.signature!.indexOf('compatible=') + 11).split('|').filter(Boolean);
      for (const compatible of compatibles) {
        for (const probe of compatibleToProbes.get(compatible) ?? []) {
          out.push(edge(device, probe, 'binds', this.id, [`compatible=${compatible}`, probe.filePath], 'exact'));
        }
      }
    }
    return uniqueEdges(out);
  },
};

export const deviceTreeBindingSynthesizer: GraphSynthesizer = {
  id: 'aosp-devicetree-binding',
  synthesize(context): Edge[] {
    const devices = nodesOf(context, 'device').filter((n) => n.language === 'devicetree' && n.signature?.includes('compatible='));
    const schemas = nodesOf(context, 'resource').filter((n) => n.language === 'yaml' && n.signature?.startsWith('Devicetree binding compatible='));
    const compatibleToSchemas = new Map<string, Node[]>();
    for (const schema of schemas) {
      for (const compatible of schema.signature!.split('compatible=')[1]!.split('|')) {
        compatibleToSchemas.set(compatible, [...(compatibleToSchemas.get(compatible) ?? []), schema]);
      }
    }
    const out: Edge[] = [];
    for (const device of devices) {
      for (const compatible of device.signature!.split('compatible=')[1]!.split('|')) {
        for (const schema of compatibleToSchemas.get(compatible) ?? []) {
          out.push(edge(device, schema, 'configures', this.id, [`compatible=${compatible}`, schema.filePath], 'exact'));
        }
      }
    }
    return uniqueEdges(out);
  },
};

export const initServiceSynthesizer: GraphSynthesizer = {
  id: 'aosp-init-service',
  synthesize(context): Edge[] {
    const services = nodesOf(context, 'service').filter((n) => n.language === 'initrc');
    const targets = nodesOf(context, 'build_target');
    const out: Edge[] = [];
    for (const service of services) {
      const executable = service.signature?.trim().split(/\s+/)[0];
      if (!executable?.startsWith('/')) continue;
      const binary = path.posix.basename(executable);
      const candidates = targets.filter((n) => n.name === binary || n.name === service.name);
      if (candidates.length !== 1) continue;
      out.push(edge(service, candidates[0]!, 'binds', this.id, [`init executable ${executable}`, `build target ${candidates[0]!.name}`], 'exact'));
    }
    return uniqueEdges(out);
  },
};

export const halVintfSynthesizer: GraphSynthesizer = {
  id: 'aosp-hal-vintf',
  synthesize(context): Edge[] {
    const services = nodesOf(context, 'service').filter((n) => n.language === 'xml' && /VINTF|^(?:aidl|hidl)/i.test(n.signature ?? ''));
    const interfaces = nodesOf(context, 'interface').filter((n) => n.language === 'aidl' || n.language === 'hidl');
    const out: Edge[] = [];
    for (const service of services) {
      const match = /::([A-Za-z_]\w*)\//.exec(service.qualifiedName);
      const interfaceName = match?.[1] ?? service.name;
      const pkg = service.qualifiedName.split('::')[0]!.replace(/^vintf:/, '').replace(/@[^:]+$/, '');
      const candidates = interfaces.filter((n) => n.name === interfaceName && (n.qualifiedName.includes(pkg) || !pkg.includes('.')));
      if (candidates.length !== 1) continue;
      out.push(edge(service, candidates[0]!, 'binds', this.id, [`VINTF instance ${service.qualifiedName}`, `interface ${candidates[0]!.qualifiedName}`], 'exact'));
    }
    return uniqueEdges(out);
  },
};

export const selinuxBindingSynthesizer: GraphSynthesizer = {
  id: 'aosp-selinux-binding',
  synthesize(context): Edge[] {
    const contexts = nodesOf(context, 'resource').filter((n) => n.language === 'selinux');
    const services = nodesOf(context, 'service');
    const properties = nodesOf(context, 'property');
    const out: Edge[] = [];
    for (const policy of contexts) {
      const serviceMatches = services.filter((n) => n.name === policy.name || n.qualifiedName === policy.name || n.qualifiedName.endsWith(`:${policy.name}`));
      for (const service of serviceMatches) out.push(edge(policy, service, 'configures', this.id, [`context ${policy.signature ?? ''}`, policy.filePath], 'exact'));
      const propertyMatches = properties.filter((n) => n.qualifiedName === policy.name || n.qualifiedName.startsWith(policy.name.replace(/\*$/, '')));
      for (const property of propertyMatches) out.push(edge(policy, property, 'configures', this.id, [`property context ${policy.name}`, policy.filePath], policy.name.includes('*') ? 'strong' : 'exact'));
    }
    return uniqueEdges(out);
  },
};

export const AOSP_GRAPH_SYNTHESIZERS: readonly GraphSynthesizer[] = [
  jniSynthesizer,
  aidlBinderSynthesizer,
  deviceTreeDriverSynthesizer,
  deviceTreeBindingSynthesizer,
  initServiceSynthesizer,
  halVintfSynthesizer,
  selinuxBindingSynthesizer,
];

/** Run every AOSP bridge and persist idempotently through the edge unique key. */
export function synthesizeAospEdges(queries: QueryBuilder, context: ResolutionContext): number {
  const edges = uniqueEdges(AOSP_GRAPH_SYNTHESIZERS.flatMap((s) => s.synthesize(context)));
  if (edges.length > 0) queries.insertEdges(edges);
  return edges.length;
}
