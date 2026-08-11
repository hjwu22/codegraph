import * as path from 'path';
import type { Edge, ExtractionError, ExtractionResult, Node, NodeKind, ReferenceKind, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/** True when an XML file carries Android resource/manifest/VINTF semantics. */
export function isAndroidSemanticXml(filePath: string, source: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(filePath.replace(/\\/g, '/'));
  if (base === 'AndroidManifest.xml' || base === 'resourcesMap.xml' || /^AndroidTest(?:Template)?\.xml$/i.test(base)) return true;
  if (/\/res\/(?:anim|animator|color|drawable|font|layout|menu|mipmap|navigation|transition|values|xml)(?:-[^/]+)?\//.test(normalized)) return true;
  // VINTF roots have an Android-specific type attribute. Do not route generic
  // XML merely because it contains <resources> or <configuration>: Maven POMs
  // commonly contain both and must stay on the ordinary XML path.
  return /<(?:compatibility-matrix|manifest)\b[^>]*\btype\s*=/.test(source);
}

/**
 * Streaming-style tolerant extractor for Android XML. It scans tags and
 * attributes without constructing a DOM, which keeps framework resource trees
 * bounded and preserves useful output even while a file is being edited.
 */
export class AndroidXmlExtractor {
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly lines: string[];
  private readonly lineStarts: number[] = [0];
  private readonly now = Date.now();
  private fileNode!: Node;

  constructor(private readonly filePath: string, private readonly source: string) {
    this.lines = source.split(/\r?\n/);
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  extract(): ExtractionResult {
    const started = Date.now();
    this.fileNode = this.addNode('file', path.posix.basename(this.filePath), this.filePath, 1, Math.max(1, this.lines.length), undefined, null);
    try {
      if (/<configuration(?:\s|>)/.test(this.source)) this.extractTradefed();
      else if (/<compatibility-matrix\b|<manifest\b[^>]*\btype\s*=/.test(this.source)) this.extractVintf();
      else if (path.posix.basename(this.filePath) === 'AndroidManifest.xml' || /<manifest\b/.test(this.source)) this.extractManifest();
      if (/<resources(?:\s|>)/.test(this.source)) this.extractResources();
      if (/\/(?:layout|menu|navigation|xml)(?:-[^/]+)?\//.test(this.filePath.replace(/\\/g, '/'))) this.extractLayoutReferences();
      if (/resourcesMap\.xml$/.test(this.filePath)) this.extractResourceMap();
    } catch (error) {
      this.errors.push({ message: `Android XML extraction error: ${error instanceof Error ? error.message : String(error)}`, filePath: this.filePath, severity: 'warning', code: 'android_xml_parse_error' });
    }
    return { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors, durationMs: Date.now() - started };
  }

  private addNode(kind: NodeKind, name: string, qualifiedName: string, startLine: number, endLine = startLine, signature?: string, parent: Node | null = this.fileNode): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, qualifiedName, startLine), kind, name, qualifiedName,
      filePath: this.filePath, language: 'xml', startLine, endLine, startColumn: 0,
      endColumn: this.lines[Math.max(0, endLine - 1)]?.length ?? 0, signature, updatedAt: this.now,
    };
    this.nodes.push(node);
    if (parent) this.edges.push({ source: parent.id, target: node.id, kind: 'contains' });
    return node;
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
  private attr(attrs: string, name: string): string | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*=\\s*["']([^"']+)["']`).exec(attrs)?.[1];
  }
  private ref(from: Node, name: string, kind: ReferenceKind, line: number): void {
    if (!name) return;
    this.unresolvedReferences.push({ fromNodeId: from.id, referenceName: name, referenceKind: kind, line, column: 0 });
  }

  private extractManifest(): void {
    const manifest = /<manifest\b([^>]*)>/.exec(this.source);
    const pkg = manifest ? this.attr(manifest[1]!, 'package') : undefined;
    const root = pkg ? this.addNode('module', pkg, pkg, this.lineAt(manifest!.index), this.lineAt(manifest!.index), 'Android package') : this.fileNode;
    const componentRe = /<(activity|activity-alias|service|receiver|provider|instrumentation|application)\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = componentRe.exec(this.source)) !== null) {
      const className = this.attr(m[2]!, 'name');
      if (!className) continue;
      const resolved = className.startsWith('.') && pkg ? `${pkg}${className}` : className;
      const kind: NodeKind = m[1] === 'service' ? 'service' : 'component';
      const component = this.addNode(kind, resolved.split('.').pop()!, resolved, this.lineAt(m.index), this.lineAt(m.index), m[1], root);
      this.ref(component, resolved, 'references', component.startLine);
      const authority = this.attr(m[2]!, 'authorities');
      if (authority) this.addNode('resource', authority, authority, component.startLine, component.startLine, 'provider authority', component);
    }
    for (const permission of this.source.matchAll(/<(?:uses-permission|permission)\b([^>]*)>/g)) {
      const name = this.attr(permission[1]!, 'name');
      if (name) this.addNode('resource', name, name, this.lineAt(permission.index!), this.lineAt(permission.index!), 'Android permission', root);
    }
    const overlay = /<overlay\b([^>]*)>/.exec(this.source);
    const targetPackage = overlay ? this.attr(overlay[1]!, 'targetPackage') : undefined;
    if (targetPackage) {
      const overlayNode = this.addNode('resource', pkg ?? this.filePath, `overlay:${pkg ?? this.filePath}`, this.lineAt(overlay!.index), this.lineAt(overlay!.index), 'runtime resource overlay', root);
      this.ref(overlayNode, targetPackage, 'overlays', overlayNode.startLine);
    }
  }

  private extractResources(): void {
    const resourceRe = /<(string|color|dimen|bool|integer|string-array|integer-array|plurals|style|declare-styleable|attr|item)\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = resourceRe.exec(this.source)) !== null) {
      const name = this.attr(m[2]!, 'name');
      if (!name) continue;
      const type = m[1] === 'item' ? this.attr(m[2]!, 'type') ?? 'item' : m[1]!;
      const node = this.addNode('resource', name, `@${type}/${name}`, this.lineAt(m.index), this.lineAt(m.index), type);
      const parent = this.attr(m[2]!, 'parent');
      if (parent) this.ref(node, parent.startsWith('@') ? parent : `@style/${parent}`, 'extends', node.startLine);
    }
    this.extractSymbolicReferences(this.fileNode);
  }

  private extractLayoutReferences(): void {
    for (const tag of this.source.matchAll(/<([A-Za-z_][\w.$]+)\b([^>]*)>/g)) {
      const tagName = tag[1]!;
      if (tagName.includes('.') || /^[A-Z]/.test(tagName)) this.ref(this.fileNode, tagName, 'references', this.lineAt(tag.index!));
      const handler = this.attr(tag[2]!, 'onClick');
      if (handler) this.ref(this.fileNode, handler, 'calls', this.lineAt(tag.index!));
    }
    this.extractSymbolicReferences(this.fileNode);
  }

  private extractSymbolicReferences(owner: Node): void {
    for (const match of this.source.matchAll(/@\+?([A-Za-z_][\w.]*)\/([A-Za-z_][\w.]*)/g)) {
      this.ref(owner, `@${match[1]}/${match[2]}`, 'references', this.lineAt(match.index!));
    }
  }

  private extractResourceMap(): void {
    for (const item of this.source.matchAll(/<item\b([^>]*)\/?\s*>/g)) {
      const target = this.attr(item[1]!, 'target');
      const value = this.attr(item[1]!, 'value');
      if (!target || !value) continue;
      const node = this.addNode('resource', target, target, this.lineAt(item.index!), this.lineAt(item.index!), 'RRO resource mapping');
      this.ref(node, value, 'overlays', node.startLine);
    }
  }

  private extractVintf(): void {
    const type = /<(manifest|compatibility-matrix)\b([^>]*)>/.exec(this.source);
    const root = this.addNode('module', type?.[1] ?? 'vintf', `vintf:${this.filePath}`, type ? this.lineAt(type.index) : 1, type ? this.lineAt(type.index) : 1, type?.[1]);
    for (const hal of this.source.matchAll(/<hal\b([^>]*)>([\s\S]*?)<\/hal>/g)) {
      const body = hal[2]!;
      const bodyOffset = hal.index! + hal[0].indexOf(body);
      const format = this.attr(hal[1]!, 'format') ?? 'hidl';
      const name = /<name>\s*([^<]+)\s*<\/name>/.exec(body)?.[1]?.trim();
      if (!name) continue;
      const version = /<version>\s*([^<]+)\s*<\/version>/.exec(body)?.[1]?.trim();
      const transport = /<transport>\s*([^<]+)\s*<\/transport>/.exec(body)?.[1]?.trim();
      const service = this.addNode('service', name, `vintf:${name}${version ? `@${version}` : ''}`, this.lineAt(hal.index!), this.lineAt(hal.index! + hal[0].length),
        `${format}${version ? ` @${version}` : ''}${transport ? ` transport=${transport}` : ''}`, root);
      for (const fq of body.matchAll(/<fqname>\s*([^<]+)\s*<\/fqname>/g)) this.ref(service, fq[1]!.trim(), 'binds', this.lineAt(bodyOffset + fq.index!));
      for (const iface of body.matchAll(/<interface>[\s\S]*?<name>\s*([^<]+)\s*<\/name>[\s\S]*?<instance>\s*([^<]+)\s*<\/instance>[\s\S]*?<\/interface>/g)) {
        const instance = this.addNode('service', iface[2]!.trim(), `${name}::${iface[1]!.trim()}/${iface[2]!.trim()}`, this.lineAt(bodyOffset + iface.index!), this.lineAt(bodyOffset + iface.index!), `VINTF ${format} instance`, service);
        this.ref(instance, iface[1]!.trim(), 'binds', instance.startLine);
      }
    }
  }

  private extractTradefed(): void {
    const description = /<configuration\b([^>]*)>/.exec(this.source);
    const name = description ? this.attr(description[1]!, 'description') ?? path.posix.basename(this.filePath, '.xml') : path.posix.basename(this.filePath, '.xml');
    const config = this.addNode('build_target', name, `tradefed:${this.filePath}`, description ? this.lineAt(description.index) : 1,
      description ? this.lineAt(description.index) : 1, 'Tradefed test configuration');
    for (const component of this.source.matchAll(/<(test|target_preparer|result_reporter|device_recovery)\b([^>]*)>/g)) {
      const className = this.attr(component[2]!, 'class');
      if (className) this.ref(config, className, component[1] === 'test' ? 'calls' : 'configures', this.lineAt(component.index!));
    }
    for (const option of this.source.matchAll(/<option\b([^>]*)\/?\s*>/g)) {
      const optionName = this.attr(option[1]!, 'name');
      const value = this.attr(option[1]!, 'value');
      if (!optionName || !value) continue;
      if (/^(?:module|test-module-name|dependency)$/.test(optionName)) this.ref(config, value, 'depends_on', this.lineAt(option.index!));
      else if (/^(?:test-config|include-filter|exclude-filter|compatibility-suite)$/.test(optionName)) this.ref(config, value, 'configures', this.lineAt(option.index!));
    }
  }
}
