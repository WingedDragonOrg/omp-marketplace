import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
  CURSOR_MARKER,
  getSegmenter,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@oh-my-pi/pi-tui";
import {
  chooseAssistantDisplayWindow,
  createAssistantSelectionState,
  moveAssistantSelection,
  selectedAssistantRange,
  type AssistantSelectionRange,
  type AssistantSelectionState,
} from "./assistant-selection";
import type { DiffLine } from "./model";

const CODE_RANGE_HEIGHT = 16;

type DisplayPiece = {
  start: number;
  end: number;
  text: string;
  width: number;
};

interface CodeTextLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly diffLine: DiffLine;
}

export interface CodeRangeSelection {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly lines: readonly DiffLine[];
}

function safeDisplayText(value: string): string {
  const replacedControls = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, char => {
    const code = char.codePointAt(0) ?? 0;
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
  return replacedControls.replace(/\t/g, "   ").replace(/\r/g, "\\r");
}

function preview(value: string, maxLength = 100): string {
  const singleLine = safeDisplayText(value).replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(1, maxLength - 1))}…`;
}

function codeTextLines(lines: readonly DiffLine[]): CodeTextLine[] {
  let start = 0;
  return lines.map(diffLine => {
    const text = diffLine.content;
    const line = { start, end: start + text.length, text, diffLine };
    start = line.end + 1;
    return line;
  });
}

/** Return the diff lines touched by a half-open range in joined code text. */
export function codeLinesForRange(
  lines: readonly DiffLine[],
  range: Pick<AssistantSelectionRange, "start" | "end">,
): DiffLine[] {
  const selected: DiffLine[] = [];
  for (const line of codeTextLines(lines)) {
    const overlapsText = range.end > line.start && range.start < line.end;
    const includesLineBreak = range.end === line.start && range.start < line.start;
    const crossesEmptyLine = line.text.length === 0 && range.start <= line.start && range.end > line.start;
    const startsAtLineBreak = range.start === line.end && range.end > line.end;
    if (overlapsText || includesLineBreak || crossesEmptyLine || startsAtLineBreak) selected.push(line.diffLine);
  }
  return selected;
}

export function codeRangeSelectionForRange(
  lines: readonly DiffLine[],
  range: AssistantSelectionRange,
): CodeRangeSelection | undefined {
  const textLines = codeTextLines(lines);
  const selectedLines = codeLinesForRange(lines, range);
  const firstIndex = textLines.findIndex(line => line.diffLine === selectedLines[0]);
  const lastIndex = textLines.findIndex(line => line.diffLine === selectedLines[selectedLines.length - 1]);
  if (firstIndex < 0 || lastIndex < firstIndex) return undefined;

  const anchorLines = textLines.slice(firstIndex, lastIndex + 1).map(line => line.diffLine);
  const anchorText = anchorLines.map(line => line.content).join("\n");
  const baseOffset = textLines[firstIndex]!.start;
  const startOffset = range.start - baseOffset;
  const endOffset = Math.min(range.end, baseOffset + anchorText.length) - baseOffset;
  if (startOffset < 0 || endOffset <= startOffset || endOffset > anchorText.length) return undefined;
  return {
    startOffset,
    endOffset,
    text: anchorText.slice(startOffset, endOffset),
    lines: anchorLines,
  };
}

function lineIndexAtCursor(lines: readonly CodeTextLine[], cursor: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (cursor <= line.end || index === lines.length - 1) return index;
  }
  return Math.max(0, lines.length - 1);
}

function displayPieces(line: CodeTextLine): DisplayPiece[] {
  const pieces: DisplayPiece[] = [];
  for (const segment of getSegmenter().segment(line.text)) {
    const start = line.start + segment.index;
    const end = start + segment.segment.length;
    const text = safeDisplayText(segment.segment);
    pieces.push({ start, end, text, width: visibleWidth(text) });
  }
  return pieces;
}

function stylePiece(theme: Theme, piece: DisplayPiece, range: AssistantSelectionRange | undefined): string {
  if (!range || piece.end <= range.start || piece.start >= range.end) return piece.text;
  return theme.bgFill("selectedBg", theme.fgOnBg("text", "selectedBg", piece.text));
}

function linePrefix(theme: Theme, line: DiffLine, current: boolean): string {
  const pointer = current ? theme.fg("accent", "›") : " ";
  const color = line.kind === "addition" ? "toolDiffAdded" : line.kind === "deletion" ? "toolDiffRemoved" : "toolDiffContext";
  const lineNumber = line.kind === "deletion" ? line.oldLine : line.newLine ?? line.oldLine;
  const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
  return `${pointer} ${theme.fg(color, `${marker}${lineNumber ?? " "}`)} `;
}

class CodeRangeSelector implements Component {
  #selection: AssistantSelectionState;
  #notice: string | undefined;
  #codeScroll = new ScrollView([], { height: CODE_RANGE_HEIGHT, scrollbar: "auto" });
  #closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly lines: readonly DiffLine[],
    private readonly done: (result: CodeRangeSelection | undefined) => void,
  ) {
    this.#selection = createAssistantSelectionState(lines.map(line => line.content).join("\n"));
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const range = selectedAssistantRange(this.#selection);
    const rows: string[] = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold("Code precise range")), safeWidth),
      truncateToWidth(
        this.theme.fg("dim", "Arrows move  Shift+Arrows select  Home/End line  Enter confirm  Esc cancel"),
        safeWidth,
      ),
      truncateToWidth(
        this.theme.fg(
          range ? "text" : "muted",
          range ? `Selected ${range.start}–${range.end}: ${preview(range.text)}` : "Selected range: none",
        ),
        safeWidth,
      ),
    ];
    if (this.#notice) rows.push(truncateToWidth(this.theme.fg("warning", this.#notice), safeWidth));
    rows.push(this.theme.fg("dim", ""));

    const textLines = codeTextLines(this.lines);
    const cursorLine = lineIndexAtCursor(textLines, this.#selection.cursor);
    const sourceWidth = textLines.length > CODE_RANGE_HEIGHT ? Math.max(1, safeWidth - 1) : safeWidth;
    const sourceRows = textLines.map((line, index) => this.#renderLine(line, index, cursorLine, sourceWidth, range));
    this.#codeScroll.setLines(sourceRows);
    this.#codeScroll.setHeight(CODE_RANGE_HEIGHT);
    this.#codeScroll.setScrollOffset(this.#scrollOffset(cursorLine, sourceRows.length, CODE_RANGE_HEIGHT));
    rows.push(...this.#codeScroll.render(safeWidth));
    rows.push(truncateToWidth(this.theme.fg("dim", "The selected code text is saved with its line anchor."), safeWidth));
    return rows;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, "escape")) {
      this.#finish(undefined);
      return;
    }
    if (matchesKey(data, "enter")) {
      const range = selectedAssistantRange(this.#selection);
      if (!range) {
        this.#notice = "Select at least one character before confirming.";
        this.tui.requestRender();
        return;
      }
      const selection = codeRangeSelectionForRange(this.lines, range);
      if (!selection) {
        this.#notice = "The selected range has no code line anchor.";
        this.tui.requestRender();
        return;
      }
      this.#finish(selection);
      return;
    }

    if (matchesKey(data, "shift+left")) this.#move("left", true);
    else if (matchesKey(data, "shift+right")) this.#move("right", true);
    else if (matchesKey(data, "shift+up")) this.#move("up", true);
    else if (matchesKey(data, "shift+down")) this.#move("down", true);
    else if (matchesKey(data, "shift+home")) this.#move("home", true);
    else if (matchesKey(data, "shift+end")) this.#move("end", true);
    else if (matchesKey(data, "left")) this.#move("left", false);
    else if (matchesKey(data, "right")) this.#move("right", false);
    else if (matchesKey(data, "up")) this.#move("up", false);
    else if (matchesKey(data, "down")) this.#move("down", false);
    else if (matchesKey(data, "home")) this.#move("home", false);
    else if (matchesKey(data, "end")) this.#move("end", false);
  }

  invalidate(): void {
    this.#codeScroll.invalidate();
  }

  #move(movement: "left" | "right" | "up" | "down" | "home" | "end", extend: boolean): void {
    const next = moveAssistantSelection(this.#selection, movement, extend);
    if (next === this.#selection) return;
    this.#selection = next;
    this.#notice = undefined;
    this.tui.requestRender();
  }

  #finish(result: CodeRangeSelection | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(result);
  }

  #renderLine(
    line: CodeTextLine,
    lineIndex: number,
    cursorLine: number,
    width: number,
    range: AssistantSelectionRange | undefined,
  ): string {
    const current = lineIndex === cursorLine;
    const pieces = displayPieces(line);
    const cursorPiece = pieces.findIndex(piece => piece.start >= this.#selection.cursor);
    const cursorPieceIndex = cursorPiece === -1 ? pieces.length : cursorPiece;
    const prefix = linePrefix(this.theme, line.diffLine, current);
    const prefixWidth = visibleWidth(prefix);
    const caretWidth = current ? 1 : 0;
    const availableWidth = Math.max(1, width - prefixWidth - caretWidth);
    const window = chooseAssistantDisplayWindow(
      pieces.map(piece => piece.width),
      current ? cursorPieceIndex : undefined,
      availableWidth,
    );
    let content = window.start > 0 ? "…" : "";
    for (let index = window.start; index < window.end; index += 1) {
      if (current && index === cursorPieceIndex) content += `${CURSOR_MARKER}${this.theme.fg("accent", "▏")}`;
      content += stylePiece(this.theme, pieces[index]!, range);
    }
    if (current && cursorPieceIndex === window.end) content += `${CURSOR_MARKER}${this.theme.fg("accent", "▏")}`;
    if (window.end < pieces.length) content += "…";
    return truncateToWidth(`${prefix}${content}`, width);
  }

  #scrollOffset(index: number, rowCount: number, height: number): number {
    if (rowCount <= height) return 0;
    return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
  }
}

export function createCodeRangeSelector(
  tui: TUI,
  theme: Theme,
  lines: readonly DiffLine[],
  done: (result: CodeRangeSelection | undefined) => void,
): Component {
  return new CodeRangeSelector(tui, theme, lines, done);
}
