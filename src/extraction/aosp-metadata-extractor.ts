import * as path from 'path';
import type { Edge, ExtractionError, ExtractionResult, Node, NodeKind, ReferenceKind, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/** Extract TEST_MAPPING and Devicetree binding YAML without evaluating tools. */
export class AospMetadataExtractor {
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly refs: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly lineStarts: number[] = [0];
  private readonly now = Date.now();
  private fileNode!: Node;

  constructor(private readonly filePath: string, private readonly source: string, private readonly kind: 'test-mapping' | 'dt-binding') {
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  extract(): ExtractionResult {
    const started = Date.now();
    this.fileNode = this.node('file', path.posix.basename(this.filePath), this.filePath, 1, undefined, null);
    try {
      if (this.kind === 'test-mapping') this.extractTestMapping();
      else this.extractDtBinding();
    } catch (error) {
      this.errors.push({
        message: `AOSP metadata extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath, severity: 'warning', code: 'aosp_metadata_parse_error',
      });
    }
    return { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.refs, errors: this.errors, durationMs: Date.now() - started };
  }

  private lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lineStarts[mid]! <= Math.max(0, offset)) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(1, lo);
  }
  private node(kind: NodeKind, name: string, qualifiedName: string, line: number, signature?: string, parent: Node | null = this.fileNode): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, qualifiedName, line), kind, name, qualifiedName,
      filePath: this.filePath, language: 'yaml', startLine: line, endLine: line,
      startColumn: 0, endColumn: 0, signature, updatedAt: this.now,
    };
    this.nodes.push(node);
    if (parent) this.edges.push({ source: parent.id, target: node.id, kind: 'contains' });
    return node;
  }
  private ref(from: Node, name: string, kind: ReferenceKind, line: number): void {
    if (name) this.refs.push({ fromNodeId: from.id, referenceName: name, referenceKind: kind, line, column: 0 });
  }

  private extractTestMapping(): void {
    // TEST_MAPPING is JSON; tolerate line comments and trailing commas used by
    // hand-edited trees while keeping malformed-file failure non-fatal.
    const cleaned = this.source.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const imports = Array.isArray(parsed.imports) ? parsed.imports : [];
    for (const entry of imports) {
      const imported = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined;
      if (typeof imported === 'string') this.ref(this.fileNode, imported, 'imports', this.lineAt(this.source.indexOf(imported)));
    }
    for (const [group, value] of Object.entries(parsed)) {
      if (group === 'imports' || !Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const test = item as { name?: unknown; host?: unknown; options?: unknown };
        if (typeof test.name !== 'string') continue;
        const line = this.lineAt(this.source.indexOf(`"${test.name}"`));
        const target = this.node('build_target', test.name, `test-mapping:${this.filePath}:${group}:${test.name}`, line,
          `TEST_MAPPING ${group}${test.host === true ? ' host' : ''}`);
        this.ref(target, test.name, 'depends_on', line);
        if (Array.isArray(test.options)) {
          for (const option of test.options) {
            if (!option || typeof option !== 'object') continue;
            for (const [key, optionValue] of Object.entries(option)) {
              if (typeof optionValue === 'string' && /(?:include-filter|exclude-filter|module|test-config)/.test(key)) {
                this.ref(target, optionValue, key === 'module' ? 'depends_on' : 'configures', line);
              }
            }
          }
        }
      }
    }
  }

  private extractDtBinding(): void {
    const id = /^\s*\$id\s*:\s*["']?([^\s"']+)/m.exec(this.source)?.[1];
    const title = /^\s*title\s*:\s*["']?([^\n"']+)/m.exec(this.source)?.[1]?.trim();
    const schema = this.node('resource', title ?? path.posix.basename(this.filePath), id ?? `devicetree-schema:${this.filePath}`, 1, 'Devicetree binding schema');
    const compatibles = new Set<string>();
    for (const match of this.source.matchAll(/\bconst\s*:\s*["']?([\w.+-]+,[\w,.*+?-]+)["']?/g)) compatibles.add(match[1]!);
    for (const block of this.source.matchAll(/\bcompatible\s*:\s*\n([\s\S]*?)(?=\n\S|\n\s{0,3}[A-Za-z_$][\w$-]*\s*:|$)/g)) {
      for (const match of block[1]!.matchAll(/["']([\w.+-]+,[\w,.*+?-]+)["']/g)) compatibles.add(match[1]!);
    }
    if (compatibles.size > 0) schema.signature = `Devicetree binding compatible=${[...compatibles].join('|')}`;
    for (const match of this.source.matchAll(/\$ref\s*:\s*["']?([^\s"']+)/g)) this.ref(schema, match[1]!, 'imports', this.lineAt(match.index!));
  }
}
