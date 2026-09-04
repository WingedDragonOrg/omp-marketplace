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
  splitAssistantTextLines,
  type AssistantSelectionRange,
  type AssistantSelectionState,
  type AssistantTextLine,
} from "./assistant-selection";

const MESSAGE_HEIGHT = 14;


type DisplayPiece = {
  start: number;
  end: number;
  text: string;
  width: number;
};

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


function lineIndexAtCursor(lines: readonly AssistantTextLine[], cursor: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (cursor <= line.end || index === lines.length - 1) return index;
  }
  return Math.max(0, lines.length - 1);
}

function displayPieces(line: AssistantTextLine): DisplayPiece[] {
  const pieces: DisplayPiece[] = [];
  for (const segment of getSegmenter().segment(line.text)) {
    const start = line.start + segment.index;
    const end = start + segment.segment.length;
    const displayText = safeDisplayText(segment.segment);
    pieces.push({ start, end, text: displayText, width: visibleWidth(displayText) });
  }
  return pieces;
}
function stylePiece(theme: Theme, piece: DisplayPiece, range: AssistantSelectionRange | undefined): string {
  if (!range || piece.end <= range.start || piece.start >= range.end) return piece.text;
  const selectedText = theme.fgOnBg("text", "selectedBg", piece.text);
  return theme.bgFill("selectedBg", selectedText);
}

class AssistantRangeSelector implements Component {
  #selection: AssistantSelectionState;
  #notice: string | undefined;
  #messageScroll = new ScrollView([], { height: MESSAGE_HEIGHT, scrollbar: "auto" });
  #closed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    text: string,
    private readonly done: (result: AssistantSelectionRange | undefined) => void,
  ) {
    this.#selection = createAssistantSelectionState(text);
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.trunc(width));
    const range = selectedAssistantRange(this.#selection);
    const lines: string[] = [
      truncateToWidth(this.theme.fg("accent", this.theme.bold("Assistant precise range")), safeWidth),
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
    if (this.#notice) lines.push(truncateToWidth(this.theme.fg("warning", this.#notice), safeWidth));
    lines.push(this.theme.fg("dim", ""));

    const messageData = splitAssistantTextLines(this.#selection.text);
    const cursorLine = lineIndexAtCursor(messageData, this.#selection.cursor);
    const sourceWidth = messageData.length > MESSAGE_HEIGHT ? Math.max(1, safeWidth - 1) : safeWidth;
    const sourceLines = messageData.map((line, index) => this.#renderLine(line, index, cursorLine, sourceWidth, range));
    this.#messageScroll.setLines(sourceLines);
    this.#messageScroll.setHeight(MESSAGE_HEIGHT);
    this.#messageScroll.setScrollOffset(this.#scrollOffset(cursorLine, sourceLines.length, MESSAGE_HEIGHT));
    lines.push(...this.#messageScroll.render(safeWidth));
    lines.push(truncateToWidth(this.theme.fg("dim", "The assistant message is read-only; only the highlighted range is saved."), safeWidth));
    return lines;
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
      this.#finish(range);
      return;
    }

    if (matchesKey(data, "shift+left")) {
      this.#move("left", true);
    } else if (matchesKey(data, "shift+right")) {
      this.#move("right", true);
    } else if (matchesKey(data, "shift+up")) {
      this.#move("up", true);
    } else if (matchesKey(data, "shift+down")) {
      this.#move("down", true);
    } else if (matchesKey(data, "shift+home")) {
      this.#move("home", true);
    } else if (matchesKey(data, "shift+end")) {
      this.#move("end", true);
    } else if (matchesKey(data, "left")) {
      this.#move("left", false);
    } else if (matchesKey(data, "right")) {
      this.#move("right", false);
    } else if (matchesKey(data, "up")) {
      this.#move("up", false);
    } else if (matchesKey(data, "down")) {
      this.#move("down", false);
    } else if (matchesKey(data, "home")) {
      this.#move("home", false);
    } else if (matchesKey(data, "end")) {
      this.#move("end", false);
    }
  }

  invalidate(): void {
    this.#messageScroll.invalidate();
  }

  #move(movement: "left" | "right" | "up" | "down" | "home" | "end", extend: boolean): void {
    const next = moveAssistantSelection(this.#selection, movement, extend);
    if (next === this.#selection) return;
    this.#selection = next;
    this.#notice = undefined;
    this.tui.requestRender();
  }

  #finish(result: AssistantSelectionRange | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(result);
  }

  #renderLine(
    line: AssistantTextLine,
    lineIndex: number,
    cursorLine: number,
    width: number,
    range: AssistantSelectionRange | undefined,
  ): string {
    const current = lineIndex === cursorLine;
    const pieces = displayPieces(line);
    const cursorOffset = this.#selection.cursor;
    const cursorPiece = pieces.findIndex(piece => piece.start >= cursorOffset);
    const cursorPieceIndex = cursorPiece === -1 ? pieces.length : cursorPiece;
    const pointer = current ? this.theme.fg("accent", "› ") : "  ";
    const prefixWidth = 2;
    const caretWidth = current ? 1 : 0;
    const availableWidth = Math.max(1, width - prefixWidth - caretWidth);
    const window = chooseAssistantDisplayWindow(
      pieces.map(piece => piece.width),
      current ? cursorPieceIndex : undefined,
      availableWidth,
    );
    const firstPiece = window.start;
    const lastPiece = window.end;
    const clippedLeft = firstPiece > 0;
    const clippedRight = lastPiece < pieces.length;
    let content = clippedLeft ? "…" : "";
    for (let index = firstPiece; index < lastPiece; index += 1) {
      if (current && index === cursorPieceIndex) content += `${CURSOR_MARKER}${this.theme.fg("accent", "▏")}`;
      content += stylePiece(this.theme, pieces[index]!, range);
    }
    if (current && cursorPieceIndex === lastPiece) content += `${CURSOR_MARKER}${this.theme.fg("accent", "▏")}`;
    if (clippedRight) content += "…";
    return truncateToWidth(`${pointer}${content}`, width);
  }

  #scrollOffset(index: number, rowCount: number, height: number): number {
    if (rowCount <= height) return 0;
    return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
  }
}

export function createAssistantRangeSelector(
  tui: TUI,
  theme: Theme,
  text: string,
  done: (result: AssistantSelectionRange | undefined) => void,
): Component {
  const selector = new AssistantRangeSelector(tui, theme, text, done);
  return selector;
}
