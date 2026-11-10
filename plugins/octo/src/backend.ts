import { spawn } from "node:child_process";

type JsonRecord = Record<string, unknown>;

interface ProseMirrorMark {
  type: string;
  attrs?: JsonRecord;
}

interface ProseMirrorNode {
  type: string;
  text?: string;
  attrs?: JsonRecord;
  marks?: ProseMirrorMark[];
  content?: ProseMirrorNode[];
  [key: string]: unknown;
}

interface BackendSnapshot {
  sourceDocument?: ProseMirrorNode;
  slug?: string;
}

export interface OctoDocument {
  readonly id: string;
  readonly type: "doc" | "html";
  readonly text: string;
  readonly version: string | number;
  readonly backend: Readonly<BackendSnapshot>;
}

const MARKDOWN_ESCAPABLE: Record<string, true> = {
  "\\": true,
  "`": true,
  "*": true,
  "_": true,
  "{": true,
  "}": true,
  "[": true,
  "]": true,
  "(": true,
  ")": true,
  "#": true,
  "+": true,
  "-": true,
  ".": true,
  "!": true,
  "|": true,
  ">": true,
  "~": true,
};
const REPLACEABLE_NODE_ATTRS: Record<string, string[]> = {
  heading: ["level"],
  orderedList: ["order"],
  codeBlock: ["language"],
};
const REPLACEABLE_MARKS = ["strong", "bold", "em", "italic", "strike", "strikethrough", "code", "link"];
const EMPTY_PARAGRAPH_MARKER = "[[octo:empty-paragraph]]";
const EMPTY_TABLE_MARKER = "[[octo:empty-table]]";
const EMPTY_BLOCKQUOTE_MARKER = "[[octo:empty-blockquote]]";
const REPLACEABLE_NODE_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "horizontal_rule",
  "text",
  "hardBreak",
];

function runOctoCli(args: string[], input?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("octo-cli", [...args, "--format", "json"], { stdio: ["pipe", "pipe", "pipe"] });
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout || !stderr) {
      child.kill();
      reject(new Error("Could not open octo-cli process streams."));
      return;
    }

    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk: string) => stdoutParts.push(chunk));
    stderr.on("data", (chunk: string) => stderrParts.push(chunk));
    stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      child.kill();
      reject(error);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const output = stdoutParts.join("");
      const errors = stderrParts.join("");
      if (code !== 0) {
        const diagnostic = [output, errors].filter(Boolean).join("\n");
        reject(new Error(diagnostic || `octo-cli exited with ${code ?? signal}`));
        return;
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(output);
      } catch {
        const diagnostic = [`octo-cli returned invalid JSON: ${output}`, errors].filter(Boolean).join("\n");
        reject(new Error(diagnostic));
        return;
      }
      if (!isRecord(envelope) || envelope.ok !== true || !("data" in envelope)) {
        reject(new Error([JSON.stringify(envelope), errors].filter(Boolean).join("\n")));
        return;
      }
      resolve(envelope.data);
    });
    stdin.end(input ?? "");
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`octo-cli returned invalid ${description}`);
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`octo-cli returned invalid ${description}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`octo-cli returned invalid ${description}`);
  }
  return value;
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonRecord)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(
  id: string,
  type: OctoDocument["type"],
  text: string,
  version: string | number,
  backend: BackendSnapshot,
): OctoDocument {
  return immutable({ id, type, text, version, backend });
}

export async function readDocument(id: string): Promise<OctoDocument> {
  const metadata = requireRecord(await runOctoCli(["docs", "get", id]), "document metadata");
  const docType = metadata.docType;

  if (docType === "doc") {
    const content = requireRecord(await runOctoCli(["docs", "content", "get", id]), "document content");
    const version = requireString(content.baseVersion, "document baseVersion");
    const sourceDocument = asProseMirrorNode(content.doc, "document body");
    if (sourceDocument.type !== "doc") throw new Error("Octo docs.content.get returned a body that is not a ProseMirror doc");
    const text = renderDocument(sourceDocument);
    return snapshot(id, "doc", text, version, { sourceDocument });
  }

  if (docType === "html") {
    const slug = requireString(metadata.octoDocSlug, "HTML document slug from docs.get metadata");
    const source = requireRecord(await runOctoCli(["html", "source", slug]), "HTML source");
    const sourceSlug = requireString(source.slug, "HTML source slug");
    if (sourceSlug !== slug) throw new Error(`Octo HTML source returned slug ${sourceSlug} for metadata slug ${slug}`);
    const version = requirePositiveInteger(source.version, "HTML source version");
    const text = requireStringAllowEmpty(source.html, "HTML source");
    return snapshot(id, "html", text, version, { slug });
  }

  throw new Error(`Unsupported Octo document type "${String(docType)}"; only doc and html documents are supported.`);
}

function requireStringAllowEmpty(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`octo-cli returned invalid ${description}`);
  return value;
}

function asProseMirrorNode(value: unknown, description: string): ProseMirrorNode {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error(`octo-cli returned invalid ${description}`);
  }
  if (value.content !== undefined && !Array.isArray(value.content)) {
    throw new Error(`octo-cli returned invalid ${description} content`);
  }
  const node = value as unknown as ProseMirrorNode;
  if (node.content) {
    for (const child of node.content) asProseMirrorNode(child, `${description} child`);
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) throw new Error(`octo-cli returned invalid ${description} marks`);
    for (const mark of node.marks) {
      if (!isRecord(mark) || typeof mark.type !== "string") {
        throw new Error(`octo-cli returned invalid ${description} mark`);
      }
    }
  }
  return node;
}

export async function writeDocument(document: OctoDocument, text: string): Promise<OctoDocument> {
  if (document.type === "html") return writeHtmlDocument(document, text);
  if (document.type !== "doc") throw new Error(`Unsupported Octo document type "${String(document.type)}"`);

  const sourceDocument = document.backend.sourceDocument;
  if (!sourceDocument || sourceDocument.type !== "doc") {
    throw new Error("The Octo document snapshot is missing its ProseMirror source body.");
  }
  if (typeof document.version !== "string" || document.version.length === 0) {
    throw new Error("The Octo document snapshot is missing its docs baseVersion.");
  }
  if (text === document.text) return document;

  const sourceBlocks = contentOf(sourceDocument);
  const targetBlocks = parseMarkdown(text);
  const patches = calculatePatches(sourceBlocks, targetBlocks);
  if (patches.length === 0) return document;

  const operations = patches
    .slice()
    .sort((left, right) => right.oldStart - left.oldStart)
    .map((patch) => blockOperation(patch, sourceBlocks, targetBlocks));
  const response = requireRecord(
    await runOctoCli([
      "docs",
      "content",
      "edit",
      document.id,
      "--base-version",
      document.version,
      "--data",
      "@-",
    ], JSON.stringify({ ops: operations })),
    "document edit response",
  );
  const version = requireString(response.baseVersion, "updated document baseVersion");
  const updatedBlocks = applyPatches(sourceBlocks, targetBlocks, patches);
  const updatedDocument = { ...sourceDocument, content: updatedBlocks };
  return snapshot(document.id, "doc", renderDocument(updatedDocument), version, {
    sourceDocument: updatedDocument,
  });
}

async function writeHtmlDocument(document: OctoDocument, text: string): Promise<OctoDocument> {
  const slug = document.backend.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("The Octo HTML snapshot is missing its metadata-provided document slug.");
  }
  if (typeof document.version !== "number" || !Number.isInteger(document.version) || document.version < 1) {
    throw new Error("The Octo HTML snapshot is missing its source version.");
  }
  if (text === document.text) return document;

  const version = document.version + 1;
  const response = requireRecord(
    await runOctoCli([
      "html",
      "publish",
      "--data",
      "@-",
    ], JSON.stringify({ html: text, slug, version })),
    "HTML publish response",
  );
  const responseSlug = requireString(response.slug, "HTML publish slug");
  if (responseSlug !== slug) throw new Error(`Octo HTML publish returned slug ${responseSlug} for snapshot slug ${slug}`);
  const publishedVersion = requirePositiveInteger(response.version, "published HTML version");
  if (publishedVersion !== version) {
    throw new Error(`Octo HTML publish returned version ${publishedVersion}; expected guarded version ${version}`);
  }
  return snapshot(document.id, "html", text, publishedVersion, { slug });
}

function contentOf(node: ProseMirrorNode): ProseMirrorNode[] {
  return node.content ?? [];
}

function renderDocument(document: ProseMirrorNode): string {
  return contentOf(document).map(renderBlock).join("\n\n");
}

function renderBlock(node: ProseMirrorNode): string {
  switch (node.type) {
    case "paragraph": {
      const content = renderInline(contentOf(node));
      return content || EMPTY_PARAGRAPH_MARKER;
    }
    case "heading": {
      const level = node.attrs?.level;
      const content = contentOf(node);
      if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6 || content.some((inline) => inline.type === "hardBreak")) return renderUnknownBlock(node);
      return `${"#".repeat(level)} ${renderInline(content)}`;
    }
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "blockquote": {
      const body = contentOf(node).map(renderBlock).join("\n\n");
      return body ? body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : EMPTY_BLOCKQUOTE_MARKER;
    }
    case "codeBlock": {
      const children = contentOf(node);
      if (children.some((child) => child.type !== "text" || typeof child.text !== "string" || child.marks?.length)) return renderUnknownBlock(node);
      const code = children.map((child) => child.text ?? "").join("");
      const language = node.attrs?.language;
      if (language !== undefined && (typeof language !== "string" || language.trim() !== language || language.length === 0 || /[\r\n`]/.test(language))) return renderUnknownBlock(node);
      const longestFence = (code.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2);
      const fence = "`".repeat(longestFence + 1);
      return `${fence}${language ?? ""}\n${code}\n${fence}`;
    }
    case "horizontalRule":
    case "horizontal_rule":
      return "---";
    case "table":
      return renderTable(node);
    default:
      return renderUnknownBlock(node);
  }
}

function renderTable(node: ProseMirrorNode): string {
  const rows = contentOf(node);
  if (rows.length === 0) return EMPTY_TABLE_MARKER;
  const cells = rows.map((row) => {
    if (row.type !== "tableRow" && row.type !== "table_row") {
      return [renderUnknownBlock(row)];
    }
    return contentOf(row).map((cell) => {
      if (cell.type !== "tableCell" && cell.type !== "tableHeader" && cell.type !== "table_cell" && cell.type !== "table_header") {
        return renderUnknownBlock(cell);
      }
      const blocks = contentOf(cell);
      if (blocks.some((block) => block.type !== "paragraph" || contentOf(block).some((inline) => inline.type === "hardBreak" || (inline.type === "text" && inline.text?.includes("\n"))))) {
        return renderUnknownBlock(cell);
      }
      return blocks.map((block) => renderInline(contentOf(block))).join(" / ");
    });
  });
  const width = cells.reduce((current, row) => Math.max(current, row.length), 0);
  if (width === 0) return EMPTY_TABLE_MARKER;
  const renderRow = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  const separator = renderRow(Array.from({ length: width }, () => "---"));
  return [renderRow(cells[0]), separator, ...cells.slice(1).map(renderRow)].join("\n");
}

function renderImage(node: ProseMirrorNode): string {
  const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
  if (alt.includes("\n")) return renderUnknownInline(node);
  const candidate = node.attrs?.attachId;
  const attachId = typeof candidate === "string" && /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : "";
  return `![${escapeMarkdownText(alt)}](octo-attachment:${attachId})`;
}

function renderUnknownInline(node: ProseMirrorNode): string {
  const content = visibleNodeText(node);
  return escapeMarkdownText(`[Unsupported inline ${node.type}${content ? `: ${content}` : ""}]`);
}

function renderUnknownBlock(node: ProseMirrorNode): string {
  const content = visibleNodeText(node);
  return escapeMarkdownText(`[Unsupported Octo block ${node.type}${content ? `: ${content}` : ""}]`);
}

function visibleNodeText(node: ProseMirrorNode): string {
  const labels = ["alt", "label", "title", "text"];
  const own = labels
    .map((key) => node[key] ?? node.attrs?.[key])
    .filter((value): value is string => typeof value === "string");
  return [...own, ...contentOf(node).map(visibleNodeText)].join(" ").replace(/\s+/g, " ").trim();
}

function renderList(node: ProseMirrorNode, ordered: boolean): string {
  const items = contentOf(node);
  if (
    items.length === 0 ||
    items.some((item) => {
      if (item.type !== "listItem") return true;
      const children = contentOf(item);
      if (children.length !== 1 || children[0].type !== "paragraph") return true;
      return contentOf(children[0]).some((inline) => inline.type === "hardBreak");
    })
  ) return renderUnknownBlock(node);
  const start = ordered ? node.attrs?.order ?? 1 : 1;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 1) return renderUnknownBlock(node);
  return items
    .map((item, index) => {
      const paragraph = contentOf(item)[0];
      const marker = ordered ? `${start + index}. ` : "- ";
      return `${marker}${renderInline(contentOf(paragraph))}`;
    })
    .join("\n");
}

function renderInline(nodes: ProseMirrorNode[]): string {
  return nodes.map((node, index) => (node.type === "hardBreak" && index === nodes.length - 1 ? renderUnknownInline(node) : renderInlineNode(node))).join("");
}

function renderInlineNode(node: ProseMirrorNode): string {
  if (node.type === "hardBreak") {
    if (node.marks?.length) return renderUnknownInline(node);
    return "  \n";
  }
  if (node.type === "image") return renderImage(node);
  if (node.type !== "text" || typeof node.text !== "string") return renderUnknownInline(node);

  if (node.text.includes("\n")) return renderUnknownInline(node);
  let rendered = escapeMarkdownText(node.text);
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "strong":
      case "bold":
        rendered = `**${rendered}**`;
        break;
      case "em":
      case "italic":
        rendered = `*${rendered}*`;
        break;
      case "strike":
      case "strikethrough":
        rendered = `~~${rendered}~~`;
        break;
      case "code":
        if (node.text.length === 0 || node.text.includes("`") || /^\s|\s$/.test(node.text) || (node.marks?.length ?? 0) > 1) {
          return escapeMarkdownText(`[Unsupported inline code: ${node.text}]`);
        }
        rendered = `\`${node.text}\``;
        break;
      case "link": {
        const href = mark.attrs?.href;
        if (typeof href !== "string" || /[\s()<>|]/.test(href)) return renderUnknownInline(node);
        const title = mark.attrs?.title;
        if (title !== undefined && (typeof title !== "string" || /[\\()"\r\n]/.test(title))) return renderUnknownInline(node);
        const suffix = typeof title === "string" ? ` "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : "";
        rendered = `[${rendered}](${href}${suffix})`;
        break;
      }
      default:
        return escapeMarkdownText(`[Unsupported mark ${mark.type}: ${node.text}]`);
    }
  }
  return rendered;
}

function escapeMarkdownText(text: string): string {
  const escapable = MARKDOWN_ESCAPABLE;
  let result = "";
  for (const character of text) {
    if (escapable[character]) result += "\\";
    result += character;
  }
  return result;
}

function parseMarkdown(text: string): ProseMirrorNode[] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const blocks: ProseMirrorNode[] = [];

  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }
    const line = lines[index];
    if (line === EMPTY_PARAGRAPH_MARKER) {
      blocks.push({ type: "paragraph", content: [] });
      index += 1;
      continue;
    }
    if (line === EMPTY_TABLE_MARKER) {
      blocks.push({ type: "table", content: [] });
      index += 1;
      continue;
    }
    if (line === EMPTY_BLOCKQUOTE_MARKER) {
      blocks.push({ type: "blockquote", content: [] });
      index += 1;
      continue;
    }
    const fenceMatch = line.match(/^(`{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const language = fenceMatch[2].trim();
      const codeLines: string[] = [];
      index += 1;
      const closingFence = new RegExp("^`{" + fence.length + ",}\\s*$");
      while (index < lines.length && !closingFence.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index === lines.length) throw new Error("Unclosed Markdown code fence cannot be represented as a document block.");
      index += 1;
      const code = codeLines.join("\n");
      blocks.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        ...(code ? { content: [{ type: "text", text: code }] } : {}),
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const title = heading[2].replace(/\s+#+\s*$/, "");
      blocks.push({ type: "heading", attrs: { level: heading[1].length }, content: parseInline(title) });
      index += 1;
      continue;
    }

    if (/^(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: "horizontalRule" });
      index += 1;
      continue;
    }
    const setext = index + 1 < lines.length ? lines[index + 1].match(/^(=+|-{3,})\s*$/) : null;
    if (setext && !startsMarkdownBlock(line)) {
      blocks.push({ type: "heading", attrs: { level: setext[1][0] === "=" ? 1 : 2 }, content: parseInline(line) });
      index += 2;
      continue;
    }

    if (/^\s+[-+*]\s+/.test(line)) {
      throw new Error("Nested Markdown lists cannot be represented losslessly by the Octo block editor.");
    }
    const unordered = line.match(/^[-+*]\s+(.*)$/);
    if (unordered) {
      const items: ProseMirrorNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^[-+*]\s+(.*)$/);
        if (!item) break;
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(item[1]) }] });
        index += 1;
      }
      blocks.push({ type: "bulletList", content: items });
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.*)$/);
    if (ordered) {
      const start = Number(ordered[1]);
      const items: ProseMirrorNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\d+)\.\s+(.*)$/);
        if (!item) break;
        if (Number(item[1]) !== start + items.length) {
          throw new Error("Non-sequential ordered lists cannot be represented losslessly as Octo blocks.");
        }
        items.push({ type: "listItem", content: [{ type: "paragraph", content: parseInline(item[2]) }] });
        index += 1;
      }
      blocks.push({ type: "orderedList", attrs: { order: start }, content: items });
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
        quoted.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      const content = parseMarkdown(quoted.join("\n"));
      if (content.length === 0) throw new Error("Empty Markdown blockquotes cannot be represented as Octo blocks.");
      blocks.push({ type: "blockquote", content });
      continue;
    }

    if (/^ {0,3}<[A-Za-z!/]/.test(line)) {
      throw new Error("Raw HTML cannot be represented losslessly as an Octo rich-text block.");
    }
    if (isMarkdownTableStart(lines, index)) {
      const parsed = parseMarkdownTable(lines, index);
      blocks.push(parsed.table);
      index = parsed.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines[index]) && !isMarkdownTableStart(lines, index)) {
      if (/^ {0,3}<[A-Za-z!/]/.test(lines[index])) {
        throw new Error("Raw HTML cannot be represented losslessly as an Octo rich-text block.");
      }
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", content: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

function startsMarkdownBlock(line: string): boolean {
  return (
    /^(`{3,})/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^(?:---+|\*\*\*+|___+)\s*$/.test(line) ||
    /^[-+*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}<[A-Za-z!/]/.test(line)
  );
}
function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !lines[index].includes("|") || !lines[index + 1].includes("|")) return false;
  const headers = splitMarkdownTableRow(lines[index]);
  const separators = splitMarkdownTableRow(lines[index + 1]);
  return headers.length > 1 && separators.length === headers.length && separators.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(lines: string[], index: number): { table: ProseMirrorNode; nextIndex: number } {
  const headers = splitMarkdownTableRow(lines[index]);
  const separators = splitMarkdownTableRow(lines[index + 1]);
  if (separators.some((cell) => cell.startsWith(":") || cell.endsWith(":"))) {
    throw new Error("Markdown table alignment cannot be represented losslessly in Octo table cells.");
  }
  const rows = [headers];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim() && lines[nextIndex].includes("|")) {
    const row = splitMarkdownTableRow(lines[nextIndex]);
    if (row.length !== headers.length) throw new Error("Markdown table rows with inconsistent cell counts cannot be represented losslessly.");
    rows.push(row);
    nextIndex += 1;
  }
  return {
    table: {
      type: "table",
      content: rows.map((row, rowIndex) => ({
        type: "tableRow",
        content: row.map((cell) => ({
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [{ type: "paragraph", content: parseInline(cell) }],
        })),
      })),
    },
    nextIndex,
  };
}

function splitMarkdownTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !isEscaped(value, value.length - 1)) value = value.slice(0, -1);
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && !isEscaped(value, index)) {
      cells.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  cells.push(value.slice(start).trim());
  return cells;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}


function parseInline(text: string, inheritedMarks: ProseMirrorMark[] = []): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  for (let index = 0; index < text.length;) {
    if (text.startsWith("![", index)) {
      if (inheritedMarks.length) throw new Error("Markdown attachment images cannot carry inline marks.");
      const bracket = findUnescaped(text, "]", index + 2);
      if (bracket === -1 || text[bracket + 1] !== "(") throw new Error("Malformed Markdown image syntax.");
      const close = findUnescaped(text, ")", bracket + 2);
      if (close === -1) throw new Error("Malformed Markdown image syntax.");
      const target = parseLinkTarget(text.slice(bracket + 2, close));
      if (typeof target.href !== "string" || !target.href.startsWith("octo-attachment:") || "title" in target) {
        throw new Error("Markdown images can only reference document-scoped Octo attachments.");
      }
      const attachId = target.href.slice("octo-attachment:".length);
      if (attachId && !/^[A-Za-z0-9_-]+$/.test(attachId)) throw new Error("Octo attachment identifiers must use letters, digits, underscores, or hyphens.");
      const altNodes = parseInline(text.slice(index + 2, bracket));
      if (altNodes.some((node) => node.type !== "text" || node.marks?.length)) throw new Error("Markdown image alt text must be plain text.");
      nodes.push({
        type: "image",
        attrs: { alt: altNodes.map((node) => node.text ?? "").join(""), ...(attachId ? { attachId } : {}) },
      });
      index = close + 1;
      continue;
    }
    if (text[index] === "\\" && index + 1 < text.length && MARKDOWN_ESCAPABLE[text[index + 1]]) {
      appendText(nodes, text[index + 1], inheritedMarks);
      index += 2;
      continue;
    }
    if (text.startsWith("  \n", index)) {
      nodes.push({ type: "hardBreak" });
      index += 3;
      continue;
    }
    if (text[index] === "\n") {
      appendText(nodes, " ", inheritedMarks);
      index += 1;
      continue;
    }
    const htmlTag = text.slice(index).match(/^<\/?[A-Za-z][^>]*>/);
    if (htmlTag) throw new Error("Raw HTML cannot be represented losslessly as an Octo inline node.");

    if (text[index] === "`") {
      const ticks = text.slice(index).match(/^`+/)?.[0] ?? "`";
      if (ticks.length > 1) throw new Error("Multi-backtick inline code cannot be represented losslessly in Octo documents.");
      const close = findUnescaped(text, ticks, index + ticks.length);
      if (close !== -1) {
        appendText(nodes, text.slice(index + ticks.length, close), [...inheritedMarks, { type: "code" }]);
        index = close + ticks.length;
        continue;
      }
    }

    if (text[index] === "[") {
      const bracket = findUnescaped(text, "]", index + 1);
      if (bracket !== -1 && text[bracket + 1] === "(") {
        const close = findUnescaped(text, ")", bracket + 2);
        if (close !== -1) {
          const link = parseLinkTarget(text.slice(bracket + 2, close));
          const nested = parseInline(text.slice(index + 1, bracket), [
            ...inheritedMarks,
            { type: "link", attrs: link },
          ]);
          nodes.push(...nested);
          index = close + 1;
          continue;
        }
      }
    }

    let delimiter: string | undefined;
    let mark: ProseMirrorMark | undefined;
    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      delimiter = text.slice(index, index + 2);
      mark = { type: "strong" };
    } else if (text.startsWith("~~", index)) {
      delimiter = "~~";
      mark = { type: "strike" };
    } else if (text[index] === "*" || text[index] === "_") {
      delimiter = text[index];
      mark = { type: "em" };
    }
    if (delimiter && mark) {
      const close = findUnescaped(text, delimiter, index + delimiter.length);
      if (close > index + delimiter.length) {
        nodes.push(...parseInline(text.slice(index + delimiter.length, close), [...inheritedMarks, mark]));
        index = close + delimiter.length;
        continue;
      }
    }

    let end = index + 1;
    while (
      end < text.length &&
      text[end] !== "\\" &&
      text[end] !== "`" &&
      text[end] !== "[" &&
      text[end] !== "*" &&
      text[end] !== "_" &&
      text[end] !== "~" &&
      text[end] !== "<" &&
      text[end] !== "\n" &&
      !(text[end] === "!" && text[end + 1] === "[")
    ) {
      end += 1;
    }
    appendText(nodes, text.slice(index, end), inheritedMarks);
    index = end;
  }
  return nodes;
}

function parseLinkTarget(value: string): JsonRecord {
  const trimmed = value.trim();
  let href: string;
  let rest: string;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close === -1) throw new Error("Malformed Markdown link destination.");
    href = trimmed.slice(1, close);
    rest = trimmed.slice(close + 1).trim();
  } else {
    const separator = trimmed.search(/\s/);
    href = separator === -1 ? trimmed : trimmed.slice(0, separator);
    rest = separator === -1 ? "" : trimmed.slice(separator).trim();
  }
  const titleMatch = rest.match(/^["'](.*)["']$/);
  if (rest && !titleMatch) throw new Error("Markdown link titles must use a quoted destination.");
  return { href, ...(titleMatch ? { title: titleMatch[1] } : {}) };
}

function findUnescaped(value: string, delimiter: string, start: number): number {
  for (let index = start; index <= value.length - delimiter.length; index += 1) {
    if (value.startsWith(delimiter, index) && !isEscaped(value, index)) return index;
  }
  return -1;
}

function appendText(nodes: ProseMirrorNode[], text: string, marks: ProseMirrorMark[]): void {
  if (!text) return;
  const previous = nodes[nodes.length - 1];
  if (
    previous?.type === "text" &&
    JSON.stringify(previous.marks ?? []) === JSON.stringify(marks)
  ) {
    previous.text = (previous.text ?? "") + text;
    return;
  }
  nodes.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
}

interface BlockPatch {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface BlockMatch {
  oldIndex: number;
  newIndex: number;
}

function calculatePatches(oldBlocks: ProseMirrorNode[], newBlocks: ProseMirrorNode[]): BlockPatch[] {
  const oldKeys = oldBlocks.map(renderBlock);
  const newKeys = newBlocks.map(renderBlock);
  const oldPositions = collectPositions(oldKeys);
  const newPositions = collectPositions(newKeys);
  const candidates: BlockMatch[] = [];

  for (const [key, oldIndexes] of oldPositions) {
    const newIndexes = newPositions.get(key);
    if (!newIndexes) continue;
    if (oldIndexes.length > newIndexes.length && !allBlocksEqual(oldIndexes.map((index) => oldBlocks[index]))) {
      throw new Error("Repeated Markdown blocks with different rich formatting cannot be removed unambiguously.");
    }
    const matches = Math.min(oldIndexes.length, newIndexes.length);
    for (let index = 0; index < matches; index += 1) {
      candidates.push({ oldIndex: oldIndexes[index], newIndex: newIndexes[index] });
    }
  }
  candidates.sort((left, right) => left.newIndex - right.newIndex);
  const anchors = longestIncreasingAnchors(candidates);

  const patches: BlockPatch[] = [];
  let oldStart = 0;
  let newStart = 0;
  for (const anchor of anchors) {
    addPatch(oldStart, anchor.oldIndex, newStart, anchor.newIndex, oldKeys, newKeys, patches);
    oldStart = anchor.oldIndex + 1;
    newStart = anchor.newIndex + 1;
  }
  addPatch(oldStart, oldBlocks.length, newStart, newBlocks.length, oldKeys, newKeys, patches);

  for (const patch of patches) {
    for (const block of oldBlocks.slice(patch.oldStart, patch.oldEnd)) assertReplaceable(block);
    for (const block of newBlocks.slice(patch.newStart, patch.newEnd)) assertWritableAttachments(block);
  }
  return patches;
}

function collectPositions(keys: string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const indexes = positions.get(key);
    if (indexes) indexes.push(index);
    else positions.set(key, [index]);
  });
  return positions;
}

function allBlocksEqual(blocks: ProseMirrorNode[]): boolean {
  if (blocks.length < 2) return true;
  const first = JSON.stringify(blocks[0]);
  return blocks.every((block) => JSON.stringify(block) === first);
}

function longestIncreasingAnchors(candidates: BlockMatch[]): BlockMatch[] {
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]].oldIndex < candidates[index].oldIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  }

  const anchors: BlockMatch[] = [];
  let index = tails.length ? tails[tails.length - 1] : -1;
  while (index !== -1) {
    anchors.push(candidates[index]);
    index = previous[index];
  }
  return anchors.reverse();
}

function addPatch(
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  oldKeys: string[],
  newKeys: string[],
  patches: BlockPatch[],
): void {
  if (oldStart === oldEnd && newStart === newEnd) return;
  const newKeySet = new Set(newKeys.slice(newStart, newEnd));
  if (oldKeys.slice(oldStart, oldEnd).some((key) => newKeySet.has(key))) {
    throw new Error("Ambiguous repeated Markdown blocks cannot be edited without losing rich-text formatting.");
  }
  patches.push({ oldStart, oldEnd, newStart, newEnd });
}
function assertWritableAttachments(node: ProseMirrorNode): void {
  if (node.type === "image") {
    const attachId = node.attrs?.attachId;
    if (typeof attachId !== "string" || !/^[A-Za-z0-9_-]+$/.test(attachId)) {
      throw new Error("New Markdown images require a valid document-scoped Octo attachment identifier.");
    }
  }
  for (const child of contentOf(node)) assertWritableAttachments(child);
}

function assertReplaceable(node: ProseMirrorNode): void {
  if (!REPLACEABLE_NODE_TYPES.includes(node.type)) {
    throw new Error(`Unsupported ProseMirror node "${node.type}" cannot be edited losslessly from Markdown.`);
  }
  if (node.type === "hardBreak") {
    throw new Error("Changing a block containing a hard break cannot be represented losslessly as Markdown.");
  }

  if (node.type !== "text" && node.marks?.length) {
    throw new Error(`Changing ProseMirror ${node.type} with marks cannot be represented losslessly as Markdown.`);
  }
  if (node.type === "text" && node.text?.includes("\n")) {
    throw new Error("Changing text with embedded newlines cannot be represented losslessly as Markdown.");
  }
  if (
    (node.type === "bulletList" || node.type === "orderedList") &&
    contentOf(node).some((item) => item.type !== "listItem" || contentOf(item).length !== 1 || contentOf(item)[0].type !== "paragraph")
  ) {
    throw new Error("Changing a list with nested or multi-paragraph items cannot be represented losslessly as Markdown.");
  }

  const allowed = REPLACEABLE_NODE_ATTRS[node.type] ?? [];
  if (node.attrs && Object.keys(node.attrs).some((key) => !allowed.includes(key))) {
    throw new Error(`Changing ProseMirror ${node.type} would discard formatting not representable in Markdown.`);
  }
  if (node.type === "text") {
    for (const mark of node.marks ?? []) {
      const supported = REPLACEABLE_MARKS;
      if (!supported.includes(mark.type)) {
        throw new Error(`Changing a block with ProseMirror mark "${mark.type}" cannot be represented losslessly as Markdown.`);
      }
      if (mark.type === "code" && (node.text?.length === 0 || node.text?.includes("`") || /^\s|\s$/.test(node.text ?? "") || (node.marks?.length ?? 0) > 1)) {
        throw new Error("Changing inline code with backticks, edge whitespace, or combined marks cannot be represented losslessly.");
      }
      if (mark.type === "link") {
        const href = mark.attrs?.href;
        const title = mark.attrs?.title;
        if (typeof href !== "string" || /[\s()<>|]/.test(href) || (title !== undefined && (typeof title !== "string" || /[\\()"\r\n]/.test(title)))) {
          throw new Error("Changing a link with an unsupported destination or title cannot be represented losslessly.");
        }
      }

      const markAttrs = mark.type === "link" ? ["href", "title"] : [];
      if (mark.attrs && Object.keys(mark.attrs).some((key) => !markAttrs.includes(key))) {
        throw new Error(`Changing a block with ProseMirror mark "${mark.type}" would discard mark attributes.`);
      }
    }
  }
  for (const child of contentOf(node)) assertReplaceable(child);
}

function blockOperation(
  patch: BlockPatch,
  oldBlocks: ProseMirrorNode[],
  newBlocks: ProseMirrorNode[],
): JsonRecord {
  const oldCount = patch.oldEnd - patch.oldStart;
  const newContent = replacementContent(patch, oldBlocks, newBlocks);
  if (oldCount > 0 && newContent.length > 0) {
    const operation: JsonRecord = {
      type: "replace",
      range: { from: { path: [patch.oldStart] }, to: { path: [patch.oldEnd - 1] } },
      content: newContent,
    };
    if (oldCount === 1) operation.expect = { type: oldBlocks[patch.oldStart].type };
    return operation;
  }
  if (oldCount > 0) {
    const operation: JsonRecord = {
      type: "delete",
      range: { from: { path: [patch.oldStart] }, to: { path: [patch.oldEnd - 1] } },
    };
    if (oldCount === 1) operation.expect = { type: oldBlocks[patch.oldStart].type };
    return operation;
  }
  if (oldBlocks.length === 0) {
    return { type: "insert", at: { path: [], position: "inside_start" }, content: newContent };
  }
  if (patch.oldStart < oldBlocks.length) {
    return {
      type: "insert",
      at: { path: [patch.oldStart], position: "before" },
      expect: { type: oldBlocks[patch.oldStart].type },
      content: newContent,
    };
  }
  return {
    type: "insert",
    at: { path: [oldBlocks.length - 1], position: "after" },
    expect: { type: oldBlocks[oldBlocks.length - 1].type },
    content: newContent,
  };
}

function replacementContent(
  patch: BlockPatch,
  oldBlocks: ProseMirrorNode[],
  newBlocks: ProseMirrorNode[],
): ProseMirrorNode[] {
  const content = newBlocks.slice(patch.newStart, patch.newEnd);
  const oldCount = patch.oldEnd - patch.oldStart;
  if (oldCount !== content.length) return content;
  return content.map((node, index) => {
    const original = oldBlocks[patch.oldStart + index];
    if (original.type !== node.type || !original.attrs) return node;
    return { ...node, attrs: { ...original.attrs, ...(node.attrs ?? {}) } };
  });
}

function applyPatches(
  oldBlocks: ProseMirrorNode[],
  newBlocks: ProseMirrorNode[],
  patches: BlockPatch[],
): ProseMirrorNode[] {
  const result = oldBlocks.slice();
  const descending = patches.slice().sort((left, right) => right.oldStart - left.oldStart);
  for (const patch of descending) {
    result.splice(
      patch.oldStart,
      patch.oldEnd - patch.oldStart,
      ...replacementContent(patch, oldBlocks, newBlocks),
    );
  }
  return result;
}
