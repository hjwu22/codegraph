import * as path from 'path';
import type {
  Edge,
  EdgeKind,
  ExtractionError,
  ExtractionResult,
  Language,
  Node,
  NodeKind,
  ReferenceKind,
  UnresolvedReference,
} from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Tolerant, non-evaluating extractors for AOSP's declarative/configuration
 * languages. These parsers intentionally model literal source evidence and
 * conditional alternatives; they never execute Make, Soong, Starlark, dtc,
 * m4, or init commands.
 */
export class AospArtifactExtractor {
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly lines: string[];
  private readonly lineStarts: number[] = [0];
  private readonly now = Date.now();
  private fileNode!: Node;

  constructor(
    private readonly filePath: string,
    private readonly source: string,
    private readonly language: Language,
  ) {
    this.lines = source.split(/\r?\n/);
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  extract(): ExtractionResult {
    const started = Date.now();
    this.fileNode = this.addNode(
      'file',
      path.posix.basename(this.filePath.replace(/\\/g, '/')),
      this.filePath,
      1,
      Math.max(1, this.lines.length),
      undefined,
      null,
    );

    try {
      switch (this.language) {
        case 'aidl': this.extractAidl(); break;
        case 'blueprint': this.extractBlueprint(); break;
        case 'starlark': this.extractStarlark(); break;
        case 'devicetree': this.extractDeviceTree(); break;
        case 'make': this.extractMake(); break;
        case 'hidl': this.extractHidl(); break;
        case 'protobuf': this.extractProto(); break;
        case 'initrc': this.extractInitRc(); break;
        case 'sysprop': this.extractSysprop(); break;
        case 'selinux': this.extractSelinux(); break;
        case 'kconfig': this.extractKconfig(); break;
      }
    } catch (error) {
      this.errors.push({
        message: `AOSP ${this.language} extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'warning',
        code: 'aosp_parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - started,
    };
  }

  private addNode(
    kind: NodeKind,
    name: string,
    qualifiedName: string,
    startLine: number,
    endLine = startLine,
    signature?: string,
    parent: Node | null = this.fileNode,
  ): Node {
    const id = generateNodeId(this.filePath, kind, qualifiedName, startLine);
    const node: Node = {
      id,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: this.language,
      startLine,
      endLine,
      startColumn: 0,
      endColumn: this.lines[Math.max(0, endLine - 1)]?.length ?? 0,
      signature,
      updatedAt: this.now,
    };
    this.nodes.push(node);
    if (parent) this.edges.push({ source: parent.id, target: node.id, kind: 'contains' });
    return node;
  }

  private addRef(from: Node, name: string, kind: ReferenceKind, line: number, metadata?: Record<string, unknown>): void {
    const cleaned = this.unquote(name.trim()).replace(/^:+/, '');
    if (!cleaned) return;
    this.unresolvedReferences.push({
      fromNodeId: from.id,
      referenceName: cleaned,
      referenceKind: kind,
      line,
      column: 0,
      ...(metadata ? { metadata } : {}),
    } as UnresolvedReference);
  }

  private addDirectEdge(source: Node, target: Node, kind: EdgeKind, metadata?: Record<string, unknown>): void {
    this.edges.push({ source: source.id, target: target.id, kind, metadata });
  }

  private lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(1, lo);
  }

  private unquote(value: string): string {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  private listValues(text: string): string[] {
    const out: string[] = [];
    const strings = text.matchAll(/["']([^"']+)["']/g);
    for (const m of strings) out.push(m[1]!);
    if (out.length > 0) return out;
    return text.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
  }

  private braceEnd(openOffset: number, open = '{', close = '}'): number {
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = openOffset; i < this.source.length; i++) {
      const ch = this.source[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return i;
    }
    return this.source.length - 1;
  }

  private extractImports(owner: Node, regex: RegExp, kind: ReferenceKind = 'imports'): void {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.source)) !== null) {
      this.addRef(owner, match[1]!, kind, this.lineAt(match.index));
    }
  }

  private extractAidl(): void {
    const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(this.source)?.[1] ?? '';
    if (pkg) this.addNode('namespace', pkg.split('.').pop()!, pkg, this.lineAt(this.source.indexOf(pkg)));
    this.extractImports(this.fileNode, /\bimport\s+([\w.]+)\s*;/g);

    const declarations = /(?:@[\w().,="'\s]+\s+)*(?:oneway\s+)?(interface|parcelable|union|enum)\s+(\w+)(?:\s+extends\s+([\w.]+))?/g;
    let m: RegExpExecArray | null;
    while ((m = declarations.exec(this.source)) !== null) {
      const keyword = m[1]!;
      const name = m[2]!;
      const kind: NodeKind = keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'union' ? 'union' : 'struct';
      const qn = pkg ? `${pkg}.${name}` : name;
      const openCandidate = this.source.indexOf('{', m.index + m[0].length);
      const semicolon = this.source.indexOf(';', m.index + m[0].length);
      const open = openCandidate >= 0 && (semicolon < 0 || openCandidate < semicolon) ? openCandidate : -1;
      const end = open >= 0 ? this.braceEnd(open) : semicolon >= 0 ? semicolon : m.index + m[0].length;
      const node = this.addNode(kind, name, qn, this.lineAt(m.index), this.lineAt(end), keyword);
      if (m[3]) this.addRef(node, m[3], 'extends', this.lineAt(m.index));
      if (keyword !== 'interface' || open < 0) continue;
      const body = this.source.slice(open + 1, end);
      const methodRe = /(?:oneway\s+)?([\w.<>\[\]?]+)\s+(\w+)\s*\(([^;{}]*)\)\s*(?:throws\s+[\w.,\s]+)?;/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        const line = this.lineAt(open + 1 + mm.index);
        const method = this.addNode('method', mm[2]!, `${qn}::${mm[2]}`, line, line, `${mm[1]} ${mm[2]}(${mm[3]})`, node);
        if (/^[A-Z]/.test(mm[1]!)) this.addRef(method, mm[1]!, 'returns', line);
        for (const type of mm[3]!.matchAll(/\b(?:in|out|inout)?\s*([A-Z]\w*(?:\.[A-Z]\w*)*)/g)) {
          this.addRef(method, type[1]!, 'references', line);
        }
      }
    }
  }

  private extractBlueprint(): void {
    const moduleRe = /(^|\n)\s*([A-Za-z_]\w*)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = moduleRe.exec(this.source)) !== null) {
      const open = this.source.indexOf('{', m.index);
      const end = this.braceEnd(open);
      const body = this.source.slice(open + 1, end);
      const name = /\bname\s*:\s*["']([^"']+)["']/.exec(body)?.[1];
      if (!name) { moduleRe.lastIndex = end + 1; continue; }
      const type = m[2]!;
      const line = this.lineAt(m.index + (m[1]?.length ?? 0));
      let signature = type;
      if (type === 'aidl_interface') {
        const stability = /\bstability\s*:\s*["']([^"']+)["']/.exec(body)?.[1];
        const frozen = /\bfrozen\s*:\s*(true|false)/.exec(body)?.[1];
        const versions = /\bversions\s*:\s*\[([\s\S]*?)\]/.exec(body);
        const versionList = versions ? this.listValues(versions[1]!) : [];
        signature = [type, stability ? `stability=${stability}` : '', frozen ? `frozen=${frozen}` : '', versionList.length ? `versions=${versionList.join('|')}` : ''].filter(Boolean).join(' ');
      }
      const target = this.addNode('build_target', name, name, line, this.lineAt(end), signature);
      const depKeys = /\b(?:defaults|static_libs|whole_static_libs|shared_libs|header_libs|runtime_libs|system_shared_libs|libs|java_libs|uses_libs|optional_uses_libs|required|tools|plugins|data|aidl_interfaces|generated_sources|generated_headers|export_(?:generated|shared|static|header)_lib_headers)\s*:\s*\[([\s\S]*?)\]/g;
      let dm: RegExpExecArray | null;
      while ((dm = depKeys.exec(body)) !== null) {
        for (const dep of this.listValues(dm[1]!)) this.addRef(target, dep.replace(/^:/, ''), 'depends_on', line);
      }
      const srcKeys = /\bsrcs\s*:\s*\[([\s\S]*?)\]/g;
      while ((dm = srcKeys.exec(body)) !== null) {
        for (const src of this.listValues(dm[1]!)) {
          if (src.startsWith(':')) this.addRef(target, src.slice(1), 'depends_on', line);
          else this.addRef(target, src, 'references', line);
        }
      }
      const outMatch = /\bout\s*:\s*\[([\s\S]*?)\]/.exec(body);
      for (const output of outMatch ? this.listValues(outMatch[1]!) : []) {
        const generated = this.addNode('resource', path.posix.basename(output), `${name}:${output}`, line, line, 'generated output', target);
        this.addDirectEdge(target, generated, 'generates', { synthesizedBy: 'soong-static', confidence: 'strong' });
      }
      if (type === 'aidl_interface') {
        for (const imports of body.matchAll(/\bimports\s*:\s*\[([\s\S]*?)\]/g)) {
          for (const imported of this.listValues(imports[1]!)) this.addRef(target, imported, 'depends_on', line);
        }
        const backendProperty = /\bbackend\s*:\s*\{/.exec(body);
        const backendOpen = backendProperty ? open + 1 + backendProperty.index + backendProperty[0].lastIndexOf('{') : -1;
        const backendBlock = backendOpen >= 0 ? this.source.slice(backendOpen + 1, this.braceEnd(backendOpen)) : '';
        for (const backend of ['java', 'cpp', 'ndk', 'rust']) {
          const block = new RegExp(`\\b${backend}\\s*:\\s*\\{([\\s\\S]*?)\\}`).exec(backendBlock)?.[1];
          if (backendProperty && !block) continue;
          if (block && /\benabled\s*:\s*false/.test(block)) continue;
          if (!backendProperty && backend === 'rust') continue;
          const generated = this.addNode('resource', `${name}-${backend}`, `${name}:backend:${backend}`, line, line,
            `generated AIDL ${backend} backend`, target);
          this.addDirectEdge(target, generated, 'generates', { synthesizedBy: 'aidl-interface-static', confidence: 'strong' });
        }
      }
      moduleRe.lastIndex = end + 1;
    }
  }

  private extractStarlark(): void {
    const loadRe = /\bload\s*\(\s*["']([^"']+)["']/g;
    this.extractImports(this.fileNode, loadRe);
    const ruleRe = /(^|\n)\s*([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(this.source)) !== null) {
      const type = m[2]!;
      if (type === 'load' || ['glob', 'select', 'depset'].includes(type)) continue;
      const open = this.source.indexOf('(', m.index);
      const end = this.braceEnd(open, '(', ')');
      const body = this.source.slice(open + 1, end);
      const name = /\bname\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
      if (!name) continue;
      const pkg = path.posix.dirname(this.filePath.replace(/\\/g, '/'));
      const label = `//${pkg === '.' ? '' : pkg}:${name}`;
      const line = this.lineAt(m.index);
      const target = this.addNode('build_target', name, label, line, this.lineAt(end), type);
      const sourceKeys = new Set(['srcs', 'hdrs', 'textual_hdrs', 'data']);
      for (const key of [...sourceKeys, 'deps', 'implementation_deps', 'exports', 'tools', 'runtime_deps', 'plugins']) {
        const expression = this.starlarkAttributeExpression(body, key);
        if (!expression) continue;
        for (const item of this.starlarkExpressionValues(expression)) {
          const referenceKind: ReferenceKind = sourceKeys.has(key) && !item.value.startsWith(':') && !item.value.startsWith('//')
            ? 'references'
            : 'depends_on';
          this.addRef(target, this.normalizeBazelLabel(item.value, pkg), referenceKind, line,
            item.variant ? { variant: [item.variant], confidence: 'strong' }
              : item.glob ? { glob: true, confidence: 'strong' }
                : undefined);
        }
      }
      for (const key of ['outs', 'out']) {
        const expression = this.starlarkAttributeExpression(body, key);
        if (!expression) continue;
        for (const output of this.starlarkExpressionValues(expression)) {
          const generated = this.addNode('resource', path.posix.basename(output.value), `${label}:${output.value}`, line, line,
            output.variant ? `generated output [${output.variant}]` : 'generated output', target);
          this.addDirectEdge(target, generated, 'generates', {
            synthesizedBy: 'bazel-static', confidence: output.variant ? 'strong' : 'exact',
            ...(output.variant ? { variant: output.variant } : {}),
          });
        }
      }
      ruleRe.lastIndex = end + 1;
    }
  }

  /** Return one top-level Starlark attribute expression without evaluating it. */
  private starlarkAttributeExpression(body: string, key: string): string | null {
    const match = new RegExp(`\\b${key}\\s*=`).exec(body);
    if (!match) return null;
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) return body.slice(start, i).trim();
    }
    return body.slice(start).trim();
  }

  /**
   * Collect literal direct-list, glob include-pattern, and select-branch values.
   * Conditions are retained as metadata; exclude= glob lists are not claimed as
   * sources. Dynamic function results remain unresolved rather than guessed.
   */
  private starlarkExpressionValues(expression: string): Array<{ value: string; variant?: string; glob?: boolean }> {
    const values: Array<{ value: string; variant?: string; glob?: boolean }> = [];
    const masked = expression.split('');
    const mask = (start: number, length: number): void => { for (let i = start; i < start + length; i++) masked[i] = ' '; };

    for (const selected of expression.matchAll(/\bselect\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const branch of selected[1]!.matchAll(/["']([^"']+)["']\s*:\s*\[([\s\S]*?)\]/g)) {
        for (const value of this.listValues(branch[2]!)) values.push({ value, variant: branch[1]! });
      }
      mask(selected.index!, selected[0].length);
    }

    const withoutSelect = masked.join('');
    for (const glob of withoutSelect.matchAll(/\bglob\s*\(\s*\[([\s\S]*?)\](?:\s*,[\s\S]*?)?\)/g)) {
      for (const value of this.listValues(glob[1]!)) values.push({ value, glob: true });
      mask(glob.index!, glob[0].length);
    }

    for (const direct of masked.join('').matchAll(/\[([\s\S]*?)\]/g)) {
      for (const value of this.listValues(direct[1]!)) values.push({ value });
    }
    if (values.length === 0) {
      const scalar = /^\s*["']([^"']+)["']\s*$/.exec(masked.join(''));
      if (scalar) values.push({ value: scalar[1]! });
    }
    return values.filter((item, index, all) => all.findIndex((candidate) =>
      candidate.value === item.value && candidate.variant === item.variant && candidate.glob === item.glob) === index);
  }

  private normalizeBazelLabel(value: string, pkg: string): string {
    const item = this.unquote(value);
    if (item.startsWith('//') || item.startsWith('@')) return item;
    if (item.startsWith(':')) return `//${pkg === '.' ? '' : pkg}${item}`;
    return item;
  }

  private extractMake(): void {
    const vars = new Map<string, string[]>();
    let moduleStart = 1;
    const flush = (buildKind: string, line: number): void => {
      const name = vars.get('LOCAL_MODULE')?.at(-1);
      if (name) {
        const target = this.addNode('build_target', name, name, moduleStart, line, buildKind);
        const depVars = ['LOCAL_STATIC_LIBRARIES', 'LOCAL_SHARED_LIBRARIES', 'LOCAL_HEADER_LIBRARIES', 'LOCAL_JAVA_LIBRARIES', 'LOCAL_REQUIRED_MODULES'];
        for (const key of depVars) for (const dep of vars.get(key) ?? []) this.addRef(target, dep, 'depends_on', moduleStart);
        for (const src of [...(vars.get('LOCAL_SRC_FILES') ?? []), ...(vars.get('LOCAL_GENERATED_SOURCES') ?? [])]) {
          this.addRef(target, src, 'references', moduleStart);
        }
      }
      vars.clear();
      moduleStart = line + 1;
    };

    let continued = '';
    for (let i = 0; i < this.lines.length; i++) {
      const lineNo = i + 1;
      const raw = continued + this.lines[i]!;
      if (/\\\s*$/.test(raw)) { continued = raw.replace(/\\\s*$/, ' '); continue; }
      continued = '';
      if (/include\s+\$\(CLEAR_VARS\)/.test(raw)) { vars.clear(); moduleStart = lineNo; continue; }
      const assignment = /^\s*([A-Za-z0-9_.$(){}-]+)\s*(?::=|\+=|=)\s*(.*?)\s*$/.exec(raw.replace(/\s+#.*$/, ''));
      if (assignment) {
        const values = assignment[2]!.split(/\s+/).filter(Boolean);
        const current = vars.get(assignment[1]!) ?? [];
        vars.set(assignment[1]!, raw.includes('+=') ? [...current, ...values] : values);
        if (/^PRODUCT_(?:PACKAGES|PACKAGES_DEBUG)$/.test(assignment[1]!)) {
          const product = this.addNode('build_target', path.posix.basename(this.filePath), `product:${this.filePath}`, lineNo, lineNo, assignment[1]);
          for (const dep of values) this.addRef(product, dep, 'depends_on', lineNo);
        }
      }
      const inherit = /(?:inherit-product|inherit-product-if-exists)\s*,\s*([^\s)]+)/.exec(raw);
      if (inherit) this.addRef(this.fileNode, inherit[1]!, 'imports', lineNo);
      const build = /include\s+\$\((BUILD_[A-Z0-9_]+)\)/.exec(raw);
      if (build) flush(build[1]!, lineNo);
    }
    if (vars.has('LOCAL_MODULE')) flush('android_make_module', this.lines.length);
  }

  private extractDeviceTree(): void {
    this.extractImports(this.fileNode, /(?:#include|\/include\/)\s*[<"]([^>"]+)[>"]/g);
    const nodeRe = /(?:^|\n)\s*(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_][\w,.-]*)(?:@([0-9a-fA-F]+))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = nodeRe.exec(this.source)) !== null) {
      const name = m[1] || `${m[2]}${m[3] ? `@${m[3]}` : ''}`;
      const open = this.source.indexOf('{', m.index);
      const end = this.braceEnd(open);
      const body = this.source.slice(open + 1, end);
      if (m[2] === 'fragment' && !m[1]) {
        const line = this.lineAt(m.index);
        const fragment = this.addNode('device', name, `${this.filePath}::${name}`, line, this.lineAt(end), 'Device Tree overlay fragment');
        const target = /\btarget\s*=\s*<&([A-Za-z_]\w*)>/.exec(body);
        if (target) this.addRef(fragment, target[1]!, 'overlays', line);
        // Do not jump to the fragment end: nested __overlay__ child devices
        // remain eligible for ordinary node extraction.
        continue;
      }
      if (m[2] === '__overlay__' && !m[1]) continue;
      const compatibles = [...body.matchAll(/\bcompatible\s*=\s*([^;]+);/g)].flatMap((cm) => this.listValues(cm[1]!));
      const line = this.lineAt(m.index);
      const node = this.addNode('device', name, `${this.filePath}::${name}`, line, this.lineAt(end), compatibles.length ? `compatible=${compatibles.join('|')}` : 'device node');
      for (const ref of body.matchAll(/&([A-Za-z_]\w*)/g)) this.addRef(node, ref[1]!, 'references', this.lineAt(open + ref.index!));
      const overlay = /\btarget\s*=\s*<&([A-Za-z_]\w*)>/.exec(body);
      if (overlay) this.addRef(node, overlay[1]!, 'overlays', line);
      nodeRe.lastIndex = end + 1;
    }
    // Overlay sugar used by plugin sources: &label { ... }.
    for (const overlay of this.source.matchAll(/(?:^|\n)\s*&([A-Za-z_]\w*)\s*\{/g)) {
      const line = this.lineAt(overlay.index!);
      const node = this.addNode('device', `&${overlay[1]}`, `${this.filePath}::overlay:&${overlay[1]}`, line, line, 'Device Tree label overlay');
      this.addRef(node, overlay[1]!, 'overlays', line);
    }
  }

  private extractHidl(): void {
    const pkg = /\bpackage\s+([\w.]+)@([\d.]+)\s*;/.exec(this.source);
    const prefix = pkg ? `${pkg[1]}@${pkg[2]}` : '';
    this.extractImports(this.fileNode, /\bimport\s+([\w.]+@[\d.]+(?:::\w+)?)\s*;/g);
    const declRe = /\b(interface|struct|union|enum)\s+(\w+)(?:\s+extends\s+([\w.@:]+))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(this.source)) !== null) {
      const kind: NodeKind = m[1] === 'interface' ? 'interface' : m[1] === 'struct' ? 'struct' : m[1] === 'union' ? 'union' : 'enum';
      const qn = prefix ? `${prefix}::${m[2]}` : m[2]!;
      const open = this.source.indexOf('{', m.index);
      const end = this.braceEnd(open);
      const node = this.addNode(kind, m[2]!, qn, this.lineAt(m.index), this.lineAt(end), m[1]);
      if (m[3]) this.addRef(node, m[3], 'extends', this.lineAt(m.index));
      if (kind === 'interface') {
        const body = this.source.slice(open + 1, end);
        for (const mm of body.matchAll(/\b(\w+)\s*\(([^)]*)\)\s*(?:generates\s*\(([^)]*)\))?\s*;/g)) {
          this.addNode('method', mm[1]!, `${qn}::${mm[1]}`, this.lineAt(open + 1 + mm.index!), this.lineAt(open + 1 + mm.index!), `${mm[1]}(${mm[2]})${mm[3] ? ` generates (${mm[3]})` : ''}`, node);
        }
      }
      declRe.lastIndex = end + 1;
    }
  }

  private extractProto(): void {
    const pkg = /\bpackage\s+([\w.]+)\s*;/.exec(this.source)?.[1] ?? '';
    this.extractImports(this.fileNode, /\bimport\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/g);
    const declRe = /\b(message|enum|service)\s+(\w+)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(this.source)) !== null) {
      const kind: NodeKind = m[1] === 'message' ? 'struct' : m[1] === 'service' ? 'interface' : 'enum';
      const qn = pkg ? `${pkg}.${m[2]}` : m[2]!;
      const open = this.source.indexOf('{', m.index);
      const end = this.braceEnd(open);
      const node = this.addNode(kind, m[2]!, qn, this.lineAt(m.index), this.lineAt(end), m[1]);
      if (m[1] === 'service') {
        const body = this.source.slice(open + 1, end);
        for (const rpc of body.matchAll(/\brpc\s+(\w+)\s*\(([^)]*)\)\s+returns\s*\(([^)]*)\)/g)) {
          const method = this.addNode('method', rpc[1]!, `${qn}::${rpc[1]}`, this.lineAt(open + 1 + rpc.index!), this.lineAt(open + 1 + rpc.index!), `rpc ${rpc[1]}(${rpc[2]}) returns (${rpc[3]})`, node);
          this.addRef(method, rpc[2]!, 'references', method.startLine);
          this.addRef(method, rpc[3]!, 'returns', method.startLine);
        }
      }
      declRe.lastIndex = end + 1;
    }
  }

  private extractInitRc(): void {
    let current: Node | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      const raw = this.lines[i]!;
      const line = i + 1;
      const imp = /^\s*import\s+(.+?)\s*$/.exec(raw);
      if (imp) { this.addRef(this.fileNode, imp[1]!, 'imports', line); continue; }
      const service = /^\s*service\s+(\S+)\s+(\S+)(.*)$/.exec(raw);
      if (service) {
        current = this.addNode('service', service[1]!, `init:${service[1]}`, line, line, `${service[2]}${service[3]}`);
        this.addRef(current, service[2]!, 'binds', line);
        continue;
      }
      const action = /^\s*on\s+(.+)$/.exec(raw);
      if (action) { current = this.addNode('function', action[1]!, `init-trigger:${action[1]}`, line, line, `on ${action[1]}`); continue; }
      if (!current || !/^\s+/.test(raw)) continue;
      const command = raw.trim().split(/\s+/);
      if (['start', 'stop', 'restart', 'enable'].includes(command[0]!) && command[1]) this.addRef(current, `init:${command[1]}`, 'calls', line);
      if (command[0] === 'setprop' && command[1]) this.addRef(current, command[1], 'configures', line);
      if ((command[0] === 'exec' || command[0] === 'exec_background') && command.at(-1)) this.addRef(current, command.at(-1)!, 'calls', line);
    }
  }

  private extractSysprop(): void {
    const owner = /\bowner\s*:\s*(?:["']([^"']+)["']|([A-Za-z_]\w*))/.exec(this.source);
    const ownerName = owner?.[1] ?? owner?.[2];
    for (const block of this.source.matchAll(/\bprop\s*\{([\s\S]*?)\}/g)) {
      const body = block[1]!;
      const name = /\bapi_name\s*:\s*["']([^"']+)["']/.exec(body)?.[1] ?? /\bprop_name\s*:\s*["']([^"']+)["']/.exec(body)?.[1];
      if (!name) continue;
      const propName = /\bprop_name\s*:\s*["']([^"']+)["']/.exec(body)?.[1] ?? name;
      this.addNode('property', name, propName, this.lineAt(block.index!), this.lineAt(block.index! + block[0].length), ownerName ? `owner=${ownerName}` : 'sysprop');
    }
  }

  private extractSelinux(): void {
    const base = path.posix.basename(this.filePath);
    const contextFile = /(?:_contexts|\.fc)$/.test(base) || base === 'fs_use';
    for (let i = 0; i < this.lines.length; i++) {
      const text = this.lines[i]!.replace(/#.*/, '').trim();
      const line = i + 1;
      const type = /^(?:type\s+|\(\s*type\s+)([\w.-]+)/.exec(text);
      if (type) this.addNode('type_alias', type[1]!, type[1]!, line, line, text.replace(/;$/, ''));
      const attr = /^(?:attribute\s+|\(\s*typeattribute\s+)([\w.-]+)/.exec(text);
      if (attr) this.addNode('trait', attr[1]!, attr[1]!, line, line, 'SELinux attribute');
      const rule = /^(?:\(\s*)?(allow|neverallow|type_transition|domain_auto_trans)\s*\(?\s*([\w.-]+)\s+\(?\s*([\w.-]+)/.exec(text);
      if (rule) {
        const node = this.addNode('function', `${rule[1]}:${rule[2]}:${rule[3]}`, `sepolicy:${this.filePath}:${line}`, line, line, text);
        this.addRef(node, rule[2]!, 'configures', line);
        this.addRef(node, rule[3]!, 'configures', line);
      }
      if (!text) continue;
      if (contextFile) {
        const parts = text.split(/\s+/);
        const contextIndex = parts.findIndex((part) => /^[^:]+:[^:]+:[^:]+:s\d/.test(part));
        if (contextIndex > 0) {
          const key = parts.slice(0, contextIndex).join(' ');
          const context = parts[contextIndex]!;
          const resource = this.addNode('resource', key, key, line, line, context);
          this.addRef(resource, context.split(':')[2] ?? context, 'configures', line);
        }
      }
    }
  }

  private extractKconfig(): void {
    for (let i = 0; i < this.lines.length; i++) {
      const line = i + 1;
      const raw = this.lines[i]!;
      const config = /^\s*(?:menu)?config\s+([A-Z0-9_]+)/.exec(raw);
      if (config) {
        const node = this.addNode('constant', config[1]!, `CONFIG_${config[1]}`, line, line, raw.trim());
        for (let j = i + 1; j < this.lines.length && /^\s+/.test(this.lines[j]!); j++) {
          const dep = /^\s*(?:depends on|select|imply)\s+(.+)$/.exec(this.lines[j]!);
          if (dep) for (const symbol of dep[1]!.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []) this.addRef(node, `CONFIG_${symbol}`, 'depends_on', j + 1);
        }
      }
      const source = /^\s*(?:rsource|source)\s+["']?([^"']+)["']?/.exec(raw);
      if (source) this.addRef(this.fileNode, source[1]!, 'imports', line);
      for (const obj of raw.matchAll(/obj-\$\(CONFIG_([A-Z0-9_]+)\)\s*\+?=\s*([^#]+)/g)) {
        const target = this.addNode('build_target', obj[2]!.trim(), `kbuild:${obj[2]!.trim()}`, line, line, `CONFIG_${obj[1]}`);
        this.addRef(target, `CONFIG_${obj[1]}`, 'configures', line);
      }
    }
  }
}
