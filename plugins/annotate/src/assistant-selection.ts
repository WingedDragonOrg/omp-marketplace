export type AssistantSelectionMovement = "left" | "right" | "up" | "down" | "home" | "end";

export interface AssistantSelectionState {
  readonly text: string;
  readonly anchor: number;
  readonly cursor: number;
  readonly preferredColumn?: number;
}

export interface AssistantSelectionRange {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface AssistantDisplayWindow {
  readonly start: number;
  readonly end: number;
}

function displayPieceWidth(widths: readonly number[], index: number): number {
  const width = widths[index] ?? 0;
  return Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
}

function widthOfPieces(widths: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index < end; index += 1) total += displayPieceWidth(widths, index);
  return total;
}

/** Choose a visible piece window that keeps clipping markers within its cell budget. */
export function chooseAssistantDisplayWindow(
  widths: readonly number[],
  cursorIndex: number | undefined,
  budget: number,
): AssistantDisplayWindow {
  const normalizedBudget = Math.max(1, Math.trunc(budget));
  const pieceCount = widths.length;
  const totalWidth = widthOfPieces(widths, 0, pieceCount);
  if (pieceCount === 0 || totalWidth <= normalizedBudget) return { start: 0, end: pieceCount };

  const pieceBudget = Math.max(1, normalizedBudget - 2);
  const cursor = cursorIndex === undefined
    ? 0
    : Math.max(0, Math.min(pieceCount, Math.trunc(cursorIndex)));
  let first = cursorIndex === undefined ? 0 : cursor;
  let last = first;
  let leftWidth = 0;
  let rightWidth = 0;

  if (cursorIndex === undefined) {
    while (last < pieceCount) {
      const nextWidth = displayPieceWidth(widths, last);
      if (rightWidth > 0 && rightWidth + nextWidth > pieceBudget) break;
      if (rightWidth === 0 && nextWidth > pieceBudget) break;
      rightWidth += nextWidth;
      last += 1;
    }
  } else {
    const rightBudget = Math.ceil(pieceBudget / 2);
    const leftBudget = pieceBudget - rightBudget;
    while (last < pieceCount) {
      const nextWidth = displayPieceWidth(widths, last);
      if (rightWidth > 0 && rightWidth + nextWidth > rightBudget) break;
      if (rightWidth === 0 && nextWidth > rightBudget) break;
      rightWidth += nextWidth;
      last += 1;
    }
    while (first > 0) {
      const nextWidth = displayPieceWidth(widths, first - 1);
      if (leftWidth > 0 && leftWidth + nextWidth > leftBudget) break;
      if (leftWidth === 0 && nextWidth > leftBudget) break;
      leftWidth += nextWidth;
      first -= 1;
    }

    let usedWidth = leftWidth + rightWidth;
    while (last < pieceCount) {
      const nextWidth = displayPieceWidth(widths, last);
      if (usedWidth + nextWidth > pieceBudget) break;
      usedWidth += nextWidth;
      last += 1;
    }
    while (first > 0) {
      const nextWidth = displayPieceWidth(widths, first - 1);
      if (usedWidth + nextWidth > pieceBudget) break;
      usedWidth += nextWidth;
      first -= 1;
    }
  }
  return { start: first, end: last };
}

export interface AssistantTextLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Split assistant text while keeping CRLF as one line-break grapheme. */
export function splitAssistantTextLines(text: string): AssistantTextLine[] {
  const lines: AssistantTextLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    lines.push({ start, end, text: text.slice(start, end) });
    start = index + 1;
  }
  lines.push({ start, end: text.length, text: text.slice(start) });
  return lines;
}

interface LineInfo extends AssistantTextLine {
  readonly boundaries: readonly number[];
}

interface SelectionMetadata {
  readonly boundaries: readonly number[];
  readonly lines: readonly LineInfo[];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const metadataByState = new WeakMap<AssistantSelectionState, SelectionMetadata>();

function graphemeBoundaries(text: string, offset = 0): number[] {
  const boundaries = [offset];
  for (const segment of segmenter.segment(text)) {
    const boundary = offset + segment.index;
    if (boundary !== boundaries[boundaries.length - 1]) boundaries.push(boundary);
  }
  const end = offset + text.length;
  if (end !== boundaries[boundaries.length - 1]) boundaries.push(end);
  return boundaries;
}

function selectionMetadata(text: string): SelectionMetadata {
  const boundaries = graphemeBoundaries(text);
  const lines: LineInfo[] = [];
  for (const line of splitAssistantTextLines(text)) {
    lines.push({
      ...line,
      boundaries: graphemeBoundaries(line.text, line.start),
    });
  }
  return { boundaries, lines };
}

function metadataFor(state: AssistantSelectionState): SelectionMetadata {
  const existing = metadataByState.get(state);
  if (existing) return existing;
  const metadata = selectionMetadata(state.text);
  metadataByState.set(state, metadata);
  return metadata;
}

function boundaryIndex(boundaries: readonly number[], position: number): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = boundaries[middle]!;
    if (value === position) return middle;
    if (value < position) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, Math.min(low, boundaries.length - 1));
}

function moveBoundary(boundaries: readonly number[], position: number, delta: -1 | 1): number {
  const index = boundaryIndex(boundaries, position);
  const nextIndex = Math.max(0, Math.min(boundaries.length - 1, index + delta));
  return boundaries[nextIndex]!;
}

function lineIndexAtCursor(lines: readonly LineInfo[], cursor: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (cursor <= line.end || index === lines.length - 1) return index;
  }
  return Math.max(0, lines.length - 1);
}

function lineColumn(line: LineInfo, cursor: number): number {
  const index = boundaryIndex(line.boundaries, cursor);
  return Math.max(0, Math.min(index, line.boundaries.length - 1));
}

function transition(
  state: AssistantSelectionState,
  anchor: number,
  cursor: number,
  preferredColumn?: number,
): AssistantSelectionState {
  if (anchor === state.anchor && cursor === state.cursor && preferredColumn === state.preferredColumn) return state;
  const next = { text: state.text, anchor, cursor, preferredColumn };
  metadataByState.set(next, metadataFor(state));
  return next;
}

/** Create a precise-selection state with a collapsed caret at the message start. */
export function createAssistantSelectionState(text: string): AssistantSelectionState {
  const state: AssistantSelectionState = { text, anchor: 0, cursor: 0 };
  metadataByState.set(state, selectionMetadata(text));
  return state;
}

/** Move the caret, optionally preserving the selection anchor like a text editor. */
export function moveAssistantSelection(
  state: AssistantSelectionState,
  movement: AssistantSelectionMovement,
  extend = false,
): AssistantSelectionState {
  const metadata = metadataFor(state);
  if (state.text.length === 0) return state;

  let cursor = state.cursor;
  let preferredColumn: number | undefined;
  if (movement === "left") {
    cursor = !extend && state.anchor !== state.cursor
      ? Math.min(state.anchor, state.cursor)
      : moveBoundary(metadata.boundaries, state.cursor, -1);
  } else if (movement === "right") {
    cursor = !extend && state.anchor !== state.cursor
      ? Math.max(state.anchor, state.cursor)
      : moveBoundary(metadata.boundaries, state.cursor, 1);
  } else if (movement === "home" || movement === "end") {
    const line = metadata.lines[lineIndexAtCursor(metadata.lines, state.cursor)]!;
    cursor = movement === "home" ? line.start : line.end;
  } else {
    const currentLineIndex = lineIndexAtCursor(metadata.lines, state.cursor);
    const currentLine = metadata.lines[currentLineIndex]!;
    const desiredColumn = state.preferredColumn ?? lineColumn(currentLine, state.cursor);
    const targetLineIndex = currentLineIndex + (movement === "up" ? -1 : 1);
    const targetLine = metadata.lines[targetLineIndex];
    if (!targetLine) {
      cursor = state.cursor;
    } else {
      const targetColumn = Math.min(desiredColumn, targetLine.boundaries.length - 1);
      cursor = targetLine.boundaries[targetColumn]!;
      preferredColumn = desiredColumn;
    }
  }

  const anchor = extend ? state.anchor : cursor;
  return transition(state, anchor, cursor, preferredColumn);
}

/** Return the current half-open selection, or undefined while the caret is collapsed. */
export function selectedAssistantRange(state: AssistantSelectionState): AssistantSelectionRange | undefined {
  if (state.anchor === state.cursor) return undefined;
  const start = Math.min(state.anchor, state.cursor);
  const end = Math.max(state.anchor, state.cursor);
  return { start, end, text: state.text.slice(start, end) };
}
