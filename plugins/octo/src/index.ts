import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  EditSession,
  EditStore,
  editDescription,
  hashlineFormatHeader,
  hashlineFormatNumberedLines,
  type EditUrlResolution,
  type EditApplyOutcome,
  type EditWriteRequest,
} from "@oh-my-pi/pi-natives";
import { parseLineRanges, type LineRange } from "@oh-my-pi/pi-tui/tools/line-ranges";

import { readDocument, writeDocument } from "./backend.ts";

type OctoDocument = {
  id: string;
  type: "doc" | "html";
  text: string;
  version: string | number;
  [key: string]: unknown;
};

type OctoBackend = {
  readDocument(id: string): Promise<OctoDocument>;
  writeDocument(document: OctoDocument, text: string): Promise<OctoDocument>;
};

type ToolResult = {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

type ToolContext = {
  invokeTool?: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: (...args: unknown[]) => void },
  ) => Promise<ToolResult>;
};

type OctoTarget = {
  id: string;
  originalPath: string;
  basePath: string;
  selector?: string;
};

type ParsedTarget = { kind: "octo"; target: OctoTarget } | { kind: "other" } | { kind: "invalid"; message: string };

type EditSection = {
  path: string;
  tag: string;
  lines: string[];
};

type EditSections = {
  prefix: string[];
  suffix: string[];
  sections: EditSection[];
};

const HTTP_OCTO_PREFIX = /^https:\/\/im\.deepminer\.com\.cn\/d\//i;
const HASHLINE_HEADER = /^\s*\[([^\]]+)#([0-9a-f]{4})\]\s*$/i;
const WRAPPED_WRITE_PATH = /^\[([^\]]+)#([0-9a-f]{4})\]$/i;
const NATIVE_READ_DESCRIPTION = [
  "Use `read` for static web; browser only if needed.",
  "",
  "Put line ranges in `path`, never a separate range/offset/limit parameter: `{\"path\":\"notes.txt:450-455\"}` reads lines 450-455; `{\"path\":\"notes.txt:-5\"}` reads the last 5. Include the selector on every ranged call; repeating a bare path does not advance through the file.",
  "",
  "Path suffixes: :50 or :50- starts at line 50; :50-200 inclusive; :50+150 counts lines; :-60 last 60; commas join ranges (:5-16,960-973) or individual lines (:19,59). A single non-raw range also shows 1 line before and 3 after (e.g. :50-80 shows 49-83); non-raw reads (comma lists too) may add the open/close line of a cut block; only :raw stays exact. :raw verbatim without anchors/prefixes; combine :2-4:raw or :raw:2-4 for exactly those lines; beside :raw a bare number is that one line (:17:raw), :17-:raw runs on. :conflicts lists one line per unresolved merge block. SVG/SVGZ default text; :img rasterizes an SVG/SVGZ into an image, :raw original. Raster images (PNG, JPEG) need no selector; :img rejects them. Video requires ffmpeg/ffprobe: bare preview grid+metadata, :412 frame, :1h5m42s/:90s/:01:23 time.",
  "",
  "Sources:",
  "- Bare code: declarations only; re-read ONLY footer-named omissions, NEVER guess `..`/`…`.",
  "- In hashline edit mode, selected files use `[foo.ts#1A2B]` snapshot+lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER invent a tag.",
  "- Directory: complete root; child listings cap at 12 (`… N more`), read child; page via :N-M/:-N.",
  "- SQLite: file.db tables; :table schema/rows; :table:key by primary key; ?limit=, ?where=, ?q=SELECT.",
  "- Archives: ZIP/JAR/APK/WHL, compressed TAR, RAR/7z/ISO/CAB/DEB/RPM/CPIO/AR/LZH/ARJ/ASAR, compressed streams; member via archive.ext:member/path.",
  "- JSON/JSONL/NDJSON: file.json?q=<jq filter>; &raw=true unquoted strings, &compact=true one-line results, &offset=&limit= page array elements or result values; `&` inside the filter → %26. Output is text, not one JSON document; follow its continuation hint for the next page.",
  "- Executables (ELF/PE/Mach-O, extensionless ok): overview + function list; :<func|0xaddr> pseudocode, :<func>:asm, :imports, :exports, :strings, :xrefs:<func|0xaddr>; line ranges apply after the view (bin:main:10-40). Universal Mach-O: host-arch slice by default, bin:@<arch> picks another (bin:@x86_64:main).",
  "- PDF/documents: extracted text; notebooks: editable cells; images: decoded inline. URLs: reader text/markdown, :raw original HTML; bare host:port needs trailing slash.",
].join("\n");

const NATIVE_WRITE_DESCRIPTION = [
  "SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.",
  "`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.",
  "In device-only mode, `path` may be `xd://<tool>` with JSON arguments in `content`, or a `local://` session scratch file. Other paths are rejected by that native mode.",
  "Some internal `proc://` paths accept actions such as `proc://<id>/kill` with `content` omitted.",
].join("\n");

const NATIVE_EDIT_MODES = ["replace", "patch", "apply_patch", "hashline", "sloppy"] as const;
const NATIVE_EDIT_DESCRIPTION = NATIVE_EDIT_MODES
  .map(mode => `### ${mode}\n${editDescription(mode)}`)
  .join("\n\n");


function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}


function splitIdSelector(value: string): { id: string; selector?: string } | { error: string } {
  if (value.includes("?") || value.includes("#") || value.includes("/")) {
    return { error: "Octo document paths must contain exactly one document ID and no query or fragment" };
  }

  const rawPrefix = /^(.*):raw:(.+)$/i.exec(value);
  if (rawPrefix && isRangeSelector(rawPrefix[2]!)) {
    return { id: rawPrefix[1]!, selector: `raw:${rawPrefix[2]}` };
  }

  const rawSuffix = /^(.*):(.+):raw$/i.exec(value);
  if (rawSuffix && isRangeSelector(rawSuffix[2]!)) {
    return { id: rawSuffix[1]!, selector: `${rawSuffix[2]}:raw` };
  }

  const colon = value.lastIndexOf(":");
  if (colon >= 0) {
    const suffix = value.slice(colon + 1);
    if (/^(?:raw|img|conflicts)$/i.test(suffix) || isRangeSelector(suffix)) {
      return { id: value.slice(0, colon), selector: suffix };
    }
  }

  return { id: value };
}

function isRangeSelector(value: string): boolean {
  return /^-?\d[\d,.+\-]*$/i.test(value);
}



function decodeDocumentId(id: string): string | undefined {
  if (!id || id.includes(":") || id.trim() !== id) return undefined;
  try {
    const decoded = decodeURIComponent(id);
    return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseOctoPath(rawPath: string): ParsedTarget {
  if (/^octo:/i.test(rawPath)) {
    if (!/^octo:\/\//i.test(rawPath)) {
      return { kind: "invalid", message: `Unsupported Octo path '${rawPath}'; use octo://<docId>` };
    }
    const part = rawPath.slice("octo://".length);
    const split = splitIdSelector(part);
    if ("error" in split) return { kind: "invalid", message: `${split.error}: '${rawPath}'` };
    const id = decodeDocumentId(split.id);
    if (!id) return { kind: "invalid", message: `Invalid Octo document ID in '${rawPath}'` };
    const basePath = rawPath.slice(0, rawPath.length - (split.selector ? split.selector.length + 1 : 0));
    return {
      kind: "octo",
      target: { id, originalPath: rawPath, basePath, ...(split.selector ? { selector: split.selector } : {}) },
    };
  }

  const httpPrefix = HTTP_OCTO_PREFIX.exec(rawPath);
  if (!httpPrefix) return { kind: "other" };
  const part = rawPath.slice(httpPrefix[0].length);
  const split = splitIdSelector(part);
  if ("error" in split) return { kind: "invalid", message: `${split.error}: '${rawPath}'` };
  const id = decodeDocumentId(split.id);
  if (!id) return { kind: "invalid", message: `Invalid Octo document ID in '${rawPath}'` };
  const basePath = rawPath.slice(0, rawPath.length - (split.selector ? split.selector.length + 1 : 0));
  return {
    kind: "octo",
    target: { id, originalPath: rawPath, basePath, ...(split.selector ? { selector: split.selector } : {}) },
  };
}

function isOctoLikePath(value: string): boolean {
  return /^octo:/i.test(value) || HTTP_OCTO_PREFIX.test(value);
}

function unwrapWritePath(value: string): { path: string; tag?: string } {
  const match = WRAPPED_WRITE_PATH.exec(value);
  return match ? { path: match[1]!, tag: match[2]!.toUpperCase() } : { path: value };
}

function pathFromArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || !("path" in args)) return "";
  return String(args.path ?? "");
}
function inputFromArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || !("input" in args)) return "";
  return String(args.input ?? "");
}

// Native invokeTool bypasses the host approval gate; without its private path resolver, local calls fail closed.
function approvalTier(rawPath: string, operation: "read" | "write"): "read" | "write" | "exec" {
  const unwrapped = operation === "write" ? unwrapWritePath(rawPath).path : rawPath;
  return parseOctoPath(unwrapped).kind === "octo" ? operation : "exec";
}

function hasOctoReference(value: string): boolean {
  const pathHeaders = [...value.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to): ([^\r\n]+)$/gim)];
  if (pathHeaders.length > 0) return pathHeaders.some(match => isOctoLikePath(match[1]!.trim()));
  return /(?:octo:\/\/|https:\/\/im\.deepminer\.com\.cn\/d\/)/i.test(value);
}

function editSections(input: string): EditSections | undefined {
  const lines = input.split(/\r?\n/);
  const starts: Array<{ index: number; path: string; tag: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = HASHLINE_HEADER.exec(lines[index]!);
    if (match) starts.push({ index, path: match[1]!, tag: match[2]!.toUpperCase() });
  }
  if (starts.length === 0) return undefined;

  const lastStart = starts[starts.length - 1]!.index;
  const endIndex = lines.findIndex((line, index) => index > lastStart && line.trim() === "*** End Patch");
  const bodyEnd = endIndex < 0 ? lines.length : endIndex;
  const sections = starts.map((start, index): EditSection => {
    const nextStart = starts[index + 1]?.index ?? bodyEnd;
    return { path: start.path, tag: start.tag, lines: lines.slice(start.index, Math.min(nextStart, bodyEnd)) };
  });
  return {
    prefix: lines.slice(0, starts[0]!.index),
    suffix: endIndex < 0 ? [] : lines.slice(endIndex),
    sections,
  };
}

function hasCrossDomainRegisters(
  localSections: readonly EditSection[],
  remoteSections: readonly EditSection[],
): boolean {
  const registerDomains = new Map<string, "local" | "remote">();
  for (const [sections, domain] of [[localSections, "local"], [remoteSections, "remote"]] as const) {
    for (const section of sections) {
      for (const line of section.lines) {
        const match = /^\s*(?:CUT|PUT)\b.*\s@([A-Za-z0-9_-]+)\s*$/i.exec(line);
        if (!match) continue;
        const name = match[1]!;
        const previous = registerDomains.get(name);
        if (previous && previous !== domain) return true;
        registerDomains.set(name, domain);
      }
    }
  }
  return false;
}



function rangesForRead(selector: string | undefined, totalLines: number): { ranges: LineRange[]; error?: string } {
  if (!selector) return { ranges: totalLines > 0 ? [{ startLine: 1, endLine: totalLines }] : [] };
  const normalizedSelector = selector.toLowerCase();
  if (normalizedSelector === "raw" || normalizedSelector.startsWith("raw:") || normalizedSelector.endsWith(":raw")) {
    return { ranges: [], error: `The :raw selector is not supported for Octo documents` };
  }
  if (normalizedSelector === "img" || normalizedSelector === "conflicts") {
    return { ranges: [], error: `The :${selector} selector is not supported for Octo documents` };
  }

  const rangeText = selector;

  const tail = /^-(\d+)$/.exec(rangeText);
  if (tail) {
    const count = Number(tail[1]);
    if (count < 1) return { ranges: [], error: `Invalid line selector :${selector}` };
    const startLine = Math.max(1, totalLines - count + 1);
    return { ranges: totalLines > 0 ? [{ startLine, endLine: totalLines }] : [] };
  }

  try {
    const ranges = parseLineRanges(rangeText, "onward");
    if (!ranges) return { ranges: [], error: `Invalid line selector :${selector}` };
    return {
      ranges: ranges
        .map(range => ({ startLine: range.startLine, endLine: Math.min(range.endLine ?? totalLines, totalLines) }))
        .filter(range => range.startLine <= totalLines && range.endLine >= range.startLine),
    };
  } catch (error) {
    return { ranges: [], error: `Invalid line selector :${selector}: ${errorText(error)}` };
  }
}

function sourceLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (text.length === 0) return [];
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function selectedLineNumbers(ranges: readonly LineRange[], totalLines: number): number[] {
  const seen: number[] = [];
  for (const range of ranges) {
    const end = Math.min(range.endLine ?? totalLines, totalLines);
    for (let line = range.startLine; line <= end; line += 1) seen.push(line);
  }
  return seen;
}

function renderSelectedLines(lines: readonly string[], ranges: readonly LineRange[]): string {
  const chunks: string[] = [];
  for (const range of ranges) {
    const start = range.startLine;
    const end = Math.min(range.endLine ?? lines.length, lines.length);
    if (start > end) continue;
    const text = lines.slice(start - 1, end).join("\n");
    if (text.length > 0) chunks.push(hashlineFormatNumberedLines(text, start));
  }
  return chunks.join("\n…\n");
}


function resultApprovalTargets(rawPath: string, operation: "read" | "write"): string[] | undefined {
  const unwrapped = operation === "write" ? unwrapWritePath(rawPath).path : rawPath;
  const parsed = parseOctoPath(unwrapped);
  return parsed.kind === "octo" ? [`octo://${parsed.target.id}`] : undefined;
}

function editApprovalTargets(args: unknown): string[] | undefined {
  const sections = editSections(inputFromArgs(args));
  let paths: string[];
  if (sections) {
    if (!sections.sections.every(section => parseOctoPath(section.path).kind === "octo")) return undefined;
    paths = sections.sections.map(section => section.path);
  } else {
    const rawPath = pathFromArgs(args);
    paths = rawPath ? [rawPath] : [];
  }
  const targets = new Set<string>();
  for (const rawPath of paths) {
    for (const target of resultApprovalTargets(rawPath, "write") ?? []) targets.add(target);
  }
  return targets.size > 0 ? [...targets] : undefined;
}



async function delegateNative(
  name: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((...args: unknown[]) => void) | undefined,
  context: ToolContext | undefined,
): Promise<ToolResult> {
  if (!context?.invokeTool) return toolError(`Native ${name} delegation is unavailable for this call`);
  try {
    return await context.invokeTool(params, { signal, onUpdate });
  } catch (error) {
    return toolError(`Native ${name} failed: ${errorText(error)}`);
  }
}

function rewriteTempPaths(text: string, paths: ReadonlyMap<string, string>): string {
  let result = text;
  for (const [tempPath, originalPath] of paths) result = result.replaceAll(tempPath, originalPath);
  return result;
}

export function registerOctoTools(
  api: Pick<ExtensionAPI, "registerTool" | "zod">,
  backend: OctoBackend = {
    readDocument: readDocument as (id: string) => Promise<OctoDocument>,
    writeDocument: writeDocument as (document: OctoDocument, text: string) => Promise<OctoDocument>,
  },
): () => Promise<void> {
  const editStore = new EditStore();
  const documentSnapshots = new Map<string, OctoDocument>();
  const documentVisibility = new Map<string, { tag: string; lineCount: number; seenLines: Set<number> }>();
  const documentPaths = new Map<string, string>();
  const documentIdsByPath = new Map<string, string>();
  const displayPaths = new Map<string, string>();
  let tempRootPromise: Promise<string> | undefined;

  const tempRoot = (): Promise<string> => {
    tempRootPromise ??= mkdtemp(path.join(os.tmpdir(), "omp-octo-edit-"));
    return tempRootPromise;
  };

  const tempPath = async (id: string): Promise<string> => {
    const cached = documentPaths.get(id);
    if (cached) return cached;
    const filename = path.join(await tempRoot(), `${encodeURIComponent(id)}.md`);
    documentIdsByPath.set(filename, id);
    documentPaths.set(id, filename);
    return filename;
  };

  const updateSnapshot = async (document: OctoDocument, originalPath: string, seenLines?: number[]): Promise<{ filePath: string; tag: string }> => {
    const filePath = await tempPath(document.id);
    await writeFile(filePath, document.text, "utf8");
    documentSnapshots.set(document.id, document);
    displayPaths.set(filePath, originalPath);
    const tag = editStore.recordSnapshot(filePath, document.text);
    const prior = documentVisibility.get(document.id);
    const visible = prior?.tag === tag ? new Set(prior.seenLines) : new Set<number>();
    if (seenLines) for (const line of seenLines) visible.add(line);
    documentVisibility.set(document.id, { tag, lineCount: sourceLines(document.text).length, seenLines: visible });
    if (seenLines && seenLines.length > 0) editStore.recordSeenLines(filePath, tag, seenLines);
    return { filePath, tag };
  };

  const readOcto = async (rawPath: string): Promise<ToolResult> => {
    const parsed = parseOctoPath(rawPath);
    if (parsed.kind === "invalid") return toolError(parsed.message);
    if (parsed.kind !== "octo") return toolError(`Not an Octo document path: '${rawPath}'`);
    let document: OctoDocument;
    try {
      document = await backend.readDocument(parsed.target.id);
    } catch (error) {
      return toolError(`Unable to read Octo document '${rawPath}': ${errorText(error)}`);
    }

    const lines = sourceLines(document.text);
    const selection = rangesForRead(parsed.target.selector, lines.length);
    if (selection.error) return toolError(`${selection.error} in '${rawPath}'`);
    const visible = selectedLineNumbers(selection.ranges, lines.length);
    let snapshot: { filePath: string; tag: string };
    try {
      snapshot = await updateSnapshot(document, parsed.target.basePath, visible);
    } catch (error) {
      return toolError(`Unable to record Octo read snapshot for '${rawPath}': ${errorText(error)}`);
    }

    const output = [
      hashlineFormatHeader(parsed.target.basePath, snapshot.tag),
      renderSelectedLines(lines, selection.ranges),
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text: output }],
      details: {
        path: parsed.target.originalPath,
        type: document.type,
        version: document.version,
        snapshot: snapshot.tag,
        ranges: selection.ranges,
      },
    };
  };

  const writeOcto = async (rawPath: string, content: string): Promise<ToolResult> => {
    const unwrapped = unwrapWritePath(rawPath);
    const parsed = parseOctoPath(unwrapped.path);
    if (parsed.kind === "invalid") return toolError(parsed.message);
    if (parsed.kind !== "octo") return toolError(`Not an Octo document path: '${rawPath}'`);
    if (parsed.target.selector) return toolError(`Whole-document write does not accept a line selector: '${rawPath}'`);

    let snapshot = documentSnapshots.get(parsed.target.id);
    if (unwrapped.tag) {
      const filePath = await tempPath(parsed.target.id);
      const currentTag = editStore.headHash(filePath);
      if (!currentTag || currentTag !== unwrapped.tag) {
        return toolError(`Stale or unseen hashline snapshot for '${rawPath}'; read the document again before writing`);
      }
      snapshot ??= documentSnapshots.get(parsed.target.id);
    }
    if (!snapshot) {
      try {
        snapshot = await backend.readDocument(parsed.target.id);
      } catch (error) {
        return toolError(`Unable to read Octo document before replacing '${rawPath}': ${errorText(error)}`);
      }
    }

    try {
      const written = await backend.writeDocument(snapshot, content);
      const lines = sourceLines(written.text);
      await updateSnapshot(written, parsed.target.basePath, selectedLineNumbers(
        lines.length > 0 ? [{ startLine: 1, endLine: lines.length }] : [],
        lines.length,
      ));
      return {
        content: [{ type: "text", text: `Wrote Octo document '${rawPath}' (${written.type}, version ${written.version})` }],
        details: { path: rawPath, type: written.type, version: written.version },
      };
    } catch (error) {
      return toolError(`Unable to write Octo document '${rawPath}': ${errorText(error)}`);
    }
  };

  const executeRemoteEdit = async (input: string, signal?: AbortSignal): Promise<ToolResult> => {
    if (signal?.aborted) return toolError("Octo edit was cancelled before submission");
    const remoteDisplayPaths = new Map<string, string>();
    const session = new EditSession(
      editStore,
      {
        cwd: process.cwd(),
        mode: "hashline",
        allowFuzzy: false,
        fuzzyThreshold: 0.8,
        enforceSeenLines: true,
        maxColumns: 0,
        blockAutoGenerated: false,
        planActive: false,
        urlSchemes: ["octo", "https"],
        urlAliasSchemes: [],
        planWritableRoots: [],
        homeDir: os.homedir(),
        rawInput: false,
      },
      null,
      async (_error, url): Promise<EditUrlResolution> => {
        const parsed = parseOctoPath(url);
        if (parsed.kind === "invalid") return { error: parsed.message, planWritable: false };
        if (parsed.kind !== "octo") return { error: `Not an Octo document path: '${url}'`, planWritable: false };
        if (parsed.target.selector) {
          return { error: `Hashline edits must target the whole Octo document: '${url}'`, planWritable: false };
        }
        if (!documentSnapshots.has(parsed.target.id)) {
          return { error: `Read Octo document '${url}' before editing it`, planWritable: false };
        }
        const filePath = await tempPath(parsed.target.id);
        displayPaths.set(filePath, parsed.target.basePath);
        remoteDisplayPaths.set(filePath, parsed.target.basePath);
        return { path: filePath, planWritable: false };
      },
    );

    let outcome: EditApplyOutcome;
    try {
      session.setArgsJson(JSON.stringify({ input }));
      session.finish();
      outcome = await session.apply({ lspFlush: false }, async (error, request: EditWriteRequest) => {
        if (error) throw error;
        if (signal?.aborted) throw new Error("Octo edit was cancelled before submission");
        if (request.op !== "update" || request.content === undefined) {
          throw new Error(`Octo documents cannot be ${request.op === "delete" ? "deleted" : request.op === "move" ? "renamed" : "created"}`);
        }
        const id = documentIdsByPath.get(request.path);
        const snapshot = id ? documentSnapshots.get(id) : undefined;
        if (!id || !snapshot) throw new Error(`No read snapshot is available for '${request.displayPath}'`);
        const written = await backend.writeDocument(snapshot, request.content);
        await writeFile(request.path, written.text, "utf8");
        documentSnapshots.set(id, written);
        const tag = editStore.recordSnapshot(request.path, written.text);
        documentVisibility.set(id, {
          tag,
          lineCount: sourceLines(written.text).length,
          seenLines: new Set(),
        });
        return { written: written.text };
      });
    } catch (error) {
      return toolError(`Octo edit failed: ${errorText(error)}`);
    } finally {
      session.close();
    }

    const text = rewriteTempPaths(outcome.text || outcome.files.map(file => file.text).join("\n"), remoteDisplayPaths);
    return {
      content: [{ type: "text", text }],
      details: {
        files: outcome.files.map(file => ({
          path: displayPaths.get(file.path) ?? file.displayPath,
          operation: file.op,
          diff: file.diff,
        })),
      },
      ...(outcome.isError ? { isError: true } : {}),
    };
  };

  const readTool = {
    name: "read",
    label: "Read",
    description: `${NATIVE_READ_DESCRIPTION}\n\nOcto documents use octo://<docId> or https://im.deepminer.com.cn/d/<docId>; reads include hashline anchors and accept native line-range selectors. Octo :raw, :img, and :conflicts selectors are unsupported.`,
    parameters: api.zod.object({ path: api.zod.string() }),
    readsSkillUris: true,
    strict: true,
    loadMode: "essential",
    concurrency: "exclusive",
    approval: (args: unknown) => approvalTier(pathFromArgs(args), "read"),
    approvalCacheTargets: (args: unknown) => resultApprovalTargets(pathFromArgs(args), "read"),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (...args: unknown[]) => void,
      context?: ToolContext,
    ): Promise<ToolResult> => {
      const rawPath = typeof params.path === "string" ? params.path : "";
      const parsed = parseOctoPath(rawPath);
      if (parsed.kind === "invalid") return toolError(parsed.message);
      if (parsed.kind === "other") return delegateNative("read", params, signal, onUpdate, context);
      return readOcto(rawPath);
    },
  };

  const writeTool = {
    name: "write",
    label: "Write",
    description: `${NATIVE_WRITE_DESCRIPTION}\n\nFor Octo documents, replace the complete content of an existing document at octo://<docId> or https://im.deepminer.com.cn/d/<docId>; writes are version-guarded.`,
    parameters: api.zod.object({ path: api.zod.string(), content: api.zod.string().optional() }),
    strict: true,
    loadMode: "essential",
    concurrency: "exclusive",
    approval: (args: unknown) => approvalTier(pathFromArgs(args), "write"),
    approvalCacheTargets: (args: unknown) => resultApprovalTargets(pathFromArgs(args), "write"),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (...args: unknown[]) => void,
      context?: ToolContext,
    ): Promise<ToolResult> => {
      if (typeof params.path !== "string") return toolError("write requires a string path parameter");
      const parsed = parseOctoPath(unwrapWritePath(params.path).path);
      if (parsed.kind === "invalid") return toolError(parsed.message);
      if (parsed.kind === "other") return delegateNative("write", params, signal, onUpdate, context);
      if (typeof params.content !== "string") return toolError("Octo write requires a string content value");
      return writeOcto(params.path, params.content);
    },
  };

  const editTool = {
    name: "edit",
    label: "Edit",
    description: `${NATIVE_EDIT_DESCRIPTION}\n\nUse the parameter form for the host's configured edit mode; local edits are delegated unchanged. Octo documents use octo://<docId> or https://im.deepminer.com.cn/d/<docId> in hashline mode only. Read them first; only lines visible in the latest snapshot are editable. Octo document creation, deletion, and renaming are not supported.`,
    parameters: api.zod.union([
      api.zod.object({
        path: api.zod.string(),
        old_string: api.zod.string(),
        new_string: api.zod.string(),
        replace_all: api.zod.boolean().optional(),
      }),
      api.zod.object({
        path: api.zod.string(),
        edits: api.zod.array(api.zod.object({
          op: api.zod.enum(["create", "delete", "update"] as const).optional(),
          rename: api.zod.string().optional(),
          diff: api.zod.string().optional(),
        })),
      }),
      api.zod.object({ input: api.zod.string() }),
    ]),
    approval: (args: unknown) => {
      const input = inputFromArgs(args);
      const sections = editSections(input);
      if (sections) {
        return sections.sections.every(section => parseOctoPath(section.path).kind === "octo") ? "write" : "exec";
      }
      const rawPath = pathFromArgs(args);
      if (rawPath) return approvalTier(rawPath, "write");
      return "exec";
    },
    approvalCacheTargets: (args: unknown) => editApprovalTargets(args),
    strict: true,
    loadMode: "essential",
    concurrency: "exclusive",
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (...args: unknown[]) => void,
      context?: ToolContext,
    ): Promise<ToolResult> => {
      if (typeof params.input !== "string") {
        const rawPath = pathFromArgs(params);
        if (rawPath && parseOctoPath(rawPath).kind !== "other") {
          return toolError("Octo edits require hashline mode and a recent read snapshot");
        }
        return delegateNative("edit", params, signal, onUpdate, context);
      }
      const parsedSections = editSections(params.input);
      if (!parsedSections) {
        if (hasOctoReference(params.input)) {
          return toolError("Octo edits require hashline mode and a recent read snapshot");
        }
        return delegateNative("edit", params, signal, onUpdate, context);
      }

      const localSections: EditSection[] = [];
      const remoteSections: EditSection[] = [];
      for (const section of parsedSections.sections) {
        const parsed = parseOctoPath(section.path);
        if (parsed.kind === "octo" || parsed.kind === "invalid" && isOctoLikePath(section.path)) remoteSections.push(section);
        else localSections.push(section);
      }
      for (const section of remoteSections) {
        const parsed = parseOctoPath(section.path);
        if (parsed.kind !== "octo") continue;
        const visibility = documentVisibility.get(parsed.target.id);
        if (
          visibility?.tag === section.tag &&
          visibility.lineCount > 0 &&
          visibility.seenLines.size === 0
        ) {
          return toolError(`No document lines were visible in the latest read of '${section.path}'; read lines before editing`);
        }
      }
      if (localSections.length > 0 && remoteSections.length > 0 && hasCrossDomainRegisters(localSections, remoteSections)) {
        return toolError("Named hashline registers cannot cross local and Octo documents in one edit");
      }
      if (remoteSections.length === 0) return delegateNative("edit", params, signal, onUpdate, context);

      let localResult: ToolResult | undefined;
      if (localSections.length > 0) {
        localResult = await delegateNative(
          "edit",
          { ...params, input: [...parsedSections.prefix, ...localSections.flatMap(section => section.lines), ...parsedSections.suffix].join("\n") },
          signal,
          onUpdate,
          context,
        );
      }

      const remoteResult = await executeRemoteEdit(
        [...parsedSections.prefix, ...remoteSections.flatMap(section => section.lines), ...parsedSections.suffix].join("\n"),
        signal,
      );
      if (!localResult) return remoteResult;
      const remoteText = remoteResult.content
        .filter((block): block is { type: string; text: string } => typeof block.text === "string")
        .map(block => block.text)
        .join("\n");
      const content = [
        ...localResult.content,
        ...(remoteText ? [{ type: "text", text: remoteText }] : []),
      ];
      if (content.length === 0) content.push({ type: "text", text: "Edit completed without output" });
      return {
        content,
        details: { local: localResult.details, remote: remoteResult.details },
        ...(localResult.isError || remoteResult.isError ? { isError: true } : {}),
      };
    },
  };

  api.registerTool(readTool as never);
  api.registerTool(writeTool as never);
  api.registerTool(editTool as never);

  return async () => {
    if (!tempRootPromise) return;
    await rm(await tempRootPromise, { recursive: true, force: true });
    tempRootPromise = undefined;
  };
}

export default function octoExtension(pi: ExtensionAPI): void {
  const dispose = registerOctoTools(pi);
  pi.on("session_shutdown", async () => dispose());
}
