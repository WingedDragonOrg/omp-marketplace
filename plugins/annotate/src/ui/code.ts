import type { DiffDocument } from "@oh-my-pi/pi-coding-agent/cli/git-tui/diff-pane";
import { replaceTabs, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CodeAnchor, CodeSnapshot, DiffFile, DiffLine, ReviewItem } from "../model";
import type { GitCommit } from "../git";
import type { CodeSelection, CodeSource, CodeSourceItem } from "./types";

function codeAnchorTouchesLine(anchor: CodeAnchor, line: DiffLine): boolean {
  const oldMatches =
    anchor.oldStart > 0 &&
    line.oldLine !== undefined &&
    line.oldLine >= anchor.oldStart &&
    line.oldLine <= anchor.oldEnd;
  const newMatches =
    anchor.newStart > 0 &&
    line.newLine !== undefined &&
    line.newLine >= anchor.newStart &&
    line.newLine <= anchor.newEnd;
  return oldMatches || newMatches;
}

function displayLine(value: string): string {
  return replaceTabs(value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
}

export function codeAnnotationsForLine(
  items: readonly ReviewItem[],
  snapshot: CodeSnapshot | undefined,
  filePath: string,
  line: DiffLine,
): ReviewItem[] {
  if (!snapshot) return [];
  return items.filter(
    item =>
      item.source === "code" &&
      item.anchor.kind === "code" &&
      item.anchor.filePath === filePath &&
      item.anchor.commitOid === snapshot.commitOid &&
      codeAnchorTouchesLine(item.anchor, line),
  );
}

export function annotationRailGlyph(annotationCount: number, hasPrevious: boolean, hasNext: boolean): string {
  if (annotationCount <= 0) return " ";
  if (annotationCount >= 10) return "9+";
  if (annotationCount > 1) return String(annotationCount);
  if (hasPrevious && hasNext) return "│";
  if (hasPrevious) return "└";
  if (hasNext) return "┌";
  return "◆";
}

function codeSelections(snapshot: CodeSnapshot | undefined): CodeSelection[] {
  if (!snapshot) return [];
  const selections: CodeSelection[] = [];
  for (const file of snapshot.files) {
    if (file.binary) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        selections.push({
          filePath: file.path,
          line,
          lines: [line],
          ...(snapshot.commitOid === undefined ? {} : { commitOid: snapshot.commitOid }),
        });
      }
    }
  }
  return selections;
}

export function codeSourceItems(
  snapshot: CodeSnapshot | undefined,
  source: CodeSource,
  commits: readonly GitCommit[],
): CodeSourceItem[] {
  if (source.kind === "commit-list") return commits.map(commit => ({ kind: "commit", commit }));
  if (!snapshot) return [];
  return [
    ...codeSelections(snapshot),
    ...snapshot.files
      .filter(file => file.binary || file.hunks.length === 0)
      .map(file => ({
        filePath: file.path,
        label: file.binary ? ("binary" as const) : ("no selectable patch lines" as const),
        browseOnly: true as const,
      })),
  ];
}

type PaneRow = {
  kind: "context" | "del" | "add";
  oldNum?: number;
  newNum?: number;
  oldText: string;
  newText: string;
  oldWidth: number;
  newWidth: number;
  oldRaw?: string;
  newRaw?: string;
};

export interface AnnotateDiffDocument {
  document: DiffDocument;
  selections: CodeSelection[];
  hunkSelections: CodeSelection[][];
}

/**
 * Adapt Annotate's unified-diff records to the same document contract used by
 * the built-in `/git` DiffPane. Every displayed row retains exactly one
 * selectable source line, including deletion-only rows.
 */
export function buildAnnotateDiffDocument(file: DiffFile): AnnotateDiffDocument {
  const rows: PaneRow[] = [];
  const selections: CodeSelection[] = [];
  const hunkSelections: CodeSelection[][] = [];
  let additions = 0;
  let deletions = 0;
  let maxOldLine = 0;
  let maxNewLine = 0;
  let maxLineWidth = 0;

  for (const hunk of file.hunks) {
    const hunkSelectionsForFile: CodeSelection[] = [];
    for (const line of hunk.lines) {
      const displayText = displayLine(line.content);
      const oldText = line.oldLine === undefined ? "" : displayText;
      const newText = line.newLine === undefined ? "" : displayText;
      const row: PaneRow = {
        kind: line.kind === "context" ? "context" : line.kind === "deletion" ? "del" : "add",
        ...(line.oldLine === undefined ? {} : { oldNum: line.oldLine }),
        ...(line.newLine === undefined ? {} : { newNum: line.newLine }),
        oldText,
        newText,
        oldWidth: visibleWidth(oldText),
        newWidth: visibleWidth(newText),
        ...(line.oldLine === undefined ? {} : { oldRaw: line.content }),
        ...(line.newLine === undefined ? {} : { newRaw: line.content }),
      };
      rows.push(row);
      const selection = { filePath: file.path, line, lines: [line] };
      selections.push(selection);
      hunkSelectionsForFile.push(selection);
      if (line.kind === "addition") additions += 1;
      if (line.kind === "deletion") deletions += 1;
      if (line.oldLine !== undefined) {
        maxOldLine = Math.max(maxOldLine, line.oldLine);
      }
      if (line.newLine !== undefined) {
        maxNewLine = Math.max(maxNewLine, line.newLine);
      }
      maxLineWidth = Math.max(maxLineWidth, visibleWidth(displayText));
    }
    hunkSelections.push(hunkSelectionsForFile);
  }

  // The source is a unified diff, not a complete file. Keep the full-file
  // arrays empty so the shared DiffPane cannot fabricate omitted rows or
  // allocate memory proportional to a distant line number.
  const oldDisplayLines: string[] = [];
  const newDisplayLines: string[] = [];
  const fileLines: { text: string; width: number }[] = [];
  const rowIndexByNewLine: number[] = [];
  const paneHunks = file.hunks.map((hunk, index) => ({
    header: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${
      hunk.header ? ` ${displayLine(hunk.header)}` : ""
    }`,
    patch: "",
    rows: file.hunks[index]!.lines.map((_line, lineIndex) => rows[
      file.hunks.slice(0, index).reduce((total, previous) => total + previous.lines.length, 0) + lineIndex
    ]!),
  }));
  const document = {
    filePath: file.path,
    rows,
    hunks: paneHunks,
    fileLines,
    oldDisplayLines,
    newDisplayLines,
    additions,
    deletions,
    gutterWidth: Math.max(3, String(Math.max(maxOldLine, maxNewLine)).length),
    maxLineWidth,
    canPatch: false,
    rawOld: oldDisplayLines.join("\n"),
    rawNew: newDisplayLines.join("\n"),
    oldEndsNewline: false,
    newEndsNewline: false,
    rowIndexByNewLine,
  } as unknown as DiffDocument;
  return { document, selections, hunkSelections };
}

export type AnnotateCodePaneMode = "split" | "inline" | "hunk" | "file";

const ANNOTATE_CODE_MODES = ["split", "inline", "hunk"] as const;

export function nextAnnotateCodeMode(mode: AnnotateCodePaneMode): (typeof ANNOTATE_CODE_MODES)[number] {
  const index = ANNOTATE_CODE_MODES.indexOf(mode as (typeof ANNOTATE_CODE_MODES)[number]);
  return ANNOTATE_CODE_MODES[(index + 1 + ANNOTATE_CODE_MODES.length) % ANNOTATE_CODE_MODES.length]!;
}

export interface PaneSelectionRange {
  from: number;
  to: number;
}

/** Keep the active pane row as the source of truth for new annotations. */
export function codeSelectionForPane(
  built: AnnotateDiffDocument,
  paneSelection: PaneSelectionRange | null | undefined,
  mode: AnnotateCodePaneMode,
  selectedHunk: number,
): CodeSelection | undefined {
  let selection: CodeSelection | undefined;
  if (paneSelection) {
    const from = Math.max(0, paneSelection.from);
    const to = Math.min(built.selections.length - 1, paneSelection.to);
    const selected = built.selections.slice(from, to + 1);
    const first = selected[0];
    if (first) selection = { ...first, lines: selected.map(item => item.line) };
  }
  if (!selection && mode === "hunk") {
    selection = built.hunkSelections[selectedHunk]?.find(candidate => candidate.line.kind !== "context");
  }
  if (!selection && mode === "file") return undefined;
  return selection ?? built.selections.find(candidate => candidate.line.kind !== "context") ?? built.selections[0];
}

function hunkRowVisualHeight(
  row: { kind: "context" | "change" | "add" | "del"; oldWidth: number; newWidth: number },
  textWidth: number,
  wrap: boolean,
): number {
  if (!wrap) return 1;
  const width =
    row.kind === "change"
      ? Math.max(row.oldWidth, row.newWidth)
      : row.kind === "del"
        ? row.oldWidth
        : row.newWidth;
  return Math.max(1, Math.ceil(Math.max(1, width) / textWidth));
}

/** Map a hunk-view visual row back to the exact diff line it displays. */
export function codeSelectionForHunkVisualRow(
  built: AnnotateDiffDocument,
  width: number,
  wrap: boolean,
  visualRow: number,
): CodeSelection | undefined {
  if (!Number.isInteger(visualRow) || visualRow < 0) return undefined;
  const safeWidth = Math.max(1, Math.trunc(width));
  const textWidth = Math.max(8, safeWidth - 2 * (built.document.gutterWidth + 1) - 3);
  let rowStart = 0;
  for (let hunkIndex = 0; hunkIndex < built.document.hunks.length; hunkIndex += 1) {
    rowStart += 1;
    const rows = built.document.hunks[hunkIndex]?.rows ?? [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const rowHeight = hunkRowVisualHeight(rows[rowIndex]!, textWidth, wrap);
      if (visualRow >= rowStart && visualRow < rowStart + rowHeight) {
        return built.hunkSelections[hunkIndex]?.[rowIndex];
      }
      rowStart += rowHeight;
    }
    rowStart += 1;
  }
  return undefined;
}

