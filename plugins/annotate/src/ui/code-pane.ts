import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { DiffPane } from "@oh-my-pi/pi-coding-agent/cli/git-tui/diff-pane";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import type { CodeSnapshot, DiffFile, DiffLine, ReviewItem } from "../model";
import {
  annotationRailGlyph,
  buildAnnotateDiffDocument,
  codeAnnotationsForLine,
  codeSelectionForHunkVisualRow,
  codeSelectionForPane,
  nextAnnotateCodeMode,
  type AnnotateCodePaneMode,
  type AnnotateDiffDocument,
} from "./code";
import type { CodeSelection } from "./types";

export const ANNOTATION_RAIL_WIDTH = 2;

export interface CodePaneContext {
  file: DiffFile | undefined;
  snapshot: CodeSnapshot | undefined;
  items: readonly ReviewItem[];
  /** Shown centred by DiffPane when there is nothing selectable to read. */
  emptyMessage: string;
}

type DocumentRowsCache = {
  document: AnnotateDiffDocument | undefined;
  mode: AnnotateCodePaneMode;
  wrap: boolean;
  scrollTop: number;
  paneWidth: number;
  selectedHunk: number;
  rowCount: number;
  rows: Array<number | undefined>;
};

type AnnotationRowsCache = {
  document: AnnotateDiffDocument;
  filePath: string;
  commitOid: string | undefined;
  itemReferences: readonly ReviewItem[];
  itemSignature: string;
  rows: Map<number, ReviewItem[]>;
};

export class AnnotatedCodePane {
  #theme: Theme;
  #codePane = new DiffPane();
  #file: DiffFile | undefined;
  #snapshot: CodeSnapshot | undefined;
  #items: readonly ReviewItem[] = [];
  #codeDocument: AnnotateDiffDocument | undefined;
  #codeDocumentKey = "";
  #lastCodePaneWidth = 1;
  #lastRowCount = 1;
  #hoverRow: number | undefined;
  #documentRowsCache: DocumentRowsCache | undefined;
  #annotationRowsCache: AnnotationRowsCache | undefined;

  constructor(theme: Theme) {
    this.#theme = theme;
    this.#codePane.patchTarget = null;
  }

  get focused(): boolean {
    return this.#codePane.focused;
  }

  set focused(value: boolean) {
    this.#codePane.focused = value;
  }

  get mode(): AnnotateCodePaneMode {
    return this.#codePane.mode;
  }

  get wrap(): boolean {
    return this.#codePane.wrap;
  }

  setContext(context: CodePaneContext): void {
    this.#file = context.file;
    this.#snapshot = context.snapshot;
    this.#items = context.items;
    this.#codePane.emptyMessage = context.emptyMessage;

    const key = `${context.snapshot?.diffFingerprint ?? ""}\0${context.file?.path ?? ""}\0${context.file?.binary ? "binary" : "text"}`;
    if (key === this.#codeDocumentKey) return;

    this.#codeDocumentKey = key;
    this.#codeDocument = undefined;
    if (!context.file) {
      this.#codePane.setDocument(null, "empty");
      return;
    }
    if (context.file.binary || context.file.hunks.length === 0) {
      this.#codePane.setDocument(null, "empty");
      return;
    }
    this.#codeDocument = buildAnnotateDiffDocument(context.file);
    this.#codePane.setDocument(this.#codeDocument.document, "ready");
    // A file that is open always has a current line, so `a` never dead-ends on
    // an empty selection and the reader can see what an annotation would target.
    this.#codePane.cursor = 0;
    this.#codePane.anchor = null;
    this.#codePane.selectedHunk = 0;
  }

  render(width: number, height: number): string[] {
    const paneWidth = Math.max(1, width - ANNOTATION_RAIL_WIDTH);
    this.#lastCodePaneWidth = paneWidth;
    const diffRows = this.#codePane.render(paneWidth, height);
    this.#lastRowCount = diffRows.length;
    const documentRows = this.#documentRowsForPane(diffRows.length);
    const annotationsByRow = this.#codeAnnotationsByRow();
    return diffRows.map((row, index) => {
      const documentRow = documentRows[index];
      const annotations = documentRow === undefined ? [] : annotationsByRow.get(documentRow) ?? [];
      const hasPrevious = documentRow !== undefined && annotationsByRow.has(documentRows[index - 1] ?? -1);
      const hasNext = documentRow !== undefined && annotationsByRow.has(documentRows[index + 1] ?? -1);
      const glyph = annotationRailGlyph(this.#theme, annotations.length, hasPrevious, hasNext);
      const color = annotations.some(item => item.status === "stale") ? "warning" : "accent";
      // The mark is the only thing on the row that opens something, so under
      // the pointer it lights up as the target it is.
      const mark =
        annotations.length > 0 && index === this.#hoverRow
          ? this.#theme.bgFill("selectedBg", this.#theme.fg(color, glyph))
          : this.#theme.fg(color, glyph);
      return truncateToWidth(`${mark} ${row}`, width);
    });
  }

  /** Light the rail mark the pointer is over; `undefined` clears it. */
  setHoverRow(row: number | undefined): boolean {
    if (row === this.#hoverRow) return false;
    this.#hoverRow = row;
    return true;
  }

  cycleMode(): void {
    const nextMode = nextAnnotateCodeMode(this.#codePane.mode);
    if (nextMode === "hunk") this.#codePane.selectedHunk = 0;
    this.#codePane.setMode(nextMode);
  }

  toggleWrap(): void {
    this.#codePane.toggleWrap();
  }

  moveCursor(delta: number, extend: boolean): void {
    this.#codePane.moveCursor(delta, extend);
  }

  jumpHunk(delta: -1 | 1): void {
    this.#codePane.jumpHunk(delta);
  }

  seekHunk(edge: "first" | "last"): void {
    this.#codePane.seekHunk(edge);
  }

  cursorToEdge(edge: "start" | "end"): void {
    this.#codePane.cursorToEdge(edge);
  }

  scrollLeftBy(delta: number): void {
    this.#codePane.scrollLeftBy(delta);
  }

  scrollBy(delta: number): void {
    this.#codePane.scrollBy(delta);
  }

  clickAt(column: number, row: number, extend: boolean): void {
    this.#syncHunkSelectionFromCursor();
    const selectedHunkAtClick = this.#codePane.selectedHunk;
    this.#codePane.clickAt(column, row, extend);
    if (this.#codePane.selectedHunk === selectedHunkAtClick) this.#syncHunkSelectionFromCursor();
  }

  selection(): CodeSelection | undefined {
    return this.#selectedCodeSelection();
  }

  hunkLines(): readonly DiffLine[] {
    return this.#selectedCodeHunkLines();
  }

  /** Every annotation shown at a rendered pane row, in queue order. */
  annotationsAtRow(row: number): readonly ReviewItem[] {
    if (row < 0 || row >= this.#lastRowCount) return [];
    const documentRow = this.#documentRowsForPane(this.#lastRowCount)[row];
    if (documentRow === undefined) return [];
    return this.#codeAnnotationsByRow().get(documentRow) ?? [];
  }

  /** What a rendered pane row would annotate, without moving the cursor. */
  selectionAtRow(row: number): CodeSelection | undefined {
    const built = this.#codeDocument;
    if (!built || row < 0 || row >= this.#lastRowCount) return undefined;
    const documentRow = this.#documentRowsForPane(this.#lastRowCount)[row];
    const selection = documentRow === undefined ? undefined : built.selections[documentRow];
    if (!selection) return undefined;
    const commitOid = this.#snapshot?.commitOid;
    return commitOid === undefined ? selection : { ...selection, commitOid };
  }

  /** Where the cursor sits on screen, so the keyboard can open a card there. */
  cursorRow(): number | undefined {
    if (!this.#codeDocument) return undefined;
    const rows = this.#documentRowsForPane(this.#lastRowCount);
    if (this.#codePane.mode === "hunk") {
      const row = this.#codePane.cursor - this.#codePane.scrollTop;
      return row >= 0 && row < rows.length ? row : undefined;
    }
    const row = rows.indexOf(this.#codePane.cursor);
    return row >= 0 ? row : undefined;
  }

  /**
   * Scroll the pane until the line carrying `item` is visible and centred, then
   * return its rendered row so the caller can open the annotation card on it.
   * Undefined when the item is not anchored to a line in the current document.
   */
  revealItem(item: ReviewItem): number | undefined {
    if (!this.#codeDocument) return undefined;
    const annotationsByRow = this.#codeAnnotationsByRow();
    let targetDoc: number | undefined;
    for (const [documentRow, items] of annotationsByRow) {
      if (items.some(candidate => candidate.id === item.id)) {
        targetDoc = documentRow;
        break;
      }
    }
    if (targetDoc === undefined) return undefined;

    const height = Math.max(1, this.#lastRowCount);
    // Diff rows appear in document order, so paging toward the target always
    // narrows the gap; the guard bounds a document with no visible line rows.
    for (let guard = 0; guard < 1000; guard += 1) {
      const rows = this.#documentRowsForPane(this.#lastRowCount);
      if (rows.indexOf(targetDoc) >= 0) break;
      const visible = rows.filter((value): value is number => value !== undefined);
      if (visible.length === 0) return undefined;
      const before = this.#codePane.scrollTop;
      if (targetDoc > Math.max(...visible)) this.#codePane.scrollBy(height);
      else if (targetDoc < Math.min(...visible)) this.#codePane.scrollBy(-height);
      else break;
      if (this.#codePane.scrollTop === before) break;
    }

    const windowRows = this.#documentRowsForPane(this.#lastRowCount);
    const found = windowRows.indexOf(targetDoc);
    if (found < 0) return undefined;
    // Centre the line and land the cursor on it so keyboard reading continues
    // from the revealed annotation.
    const visual = this.#codePane.scrollTop + found;
    this.#codePane.cursor = visual;
    this.#codePane.anchor = null;
    this.#codePane.seekTo(visual);
    const centered = this.#documentRowsForPane(this.#lastRowCount).indexOf(targetDoc);
    return centered >= 0 ? centered : found;
  }

  invalidate(): void {
    this.#documentRowsCache = undefined;
    this.#annotationRowsCache = undefined;
  }

  #codeAnnotationsByRow(): Map<number, ReviewItem[]> {
    const built = this.#codeDocument;
    const file = this.#file;
    const snapshot = this.#snapshot;
    if (!built || !file || !snapshot) return new Map();

    const itemSignature = this.#annotationItemSignature();
    const commitOid = snapshot.commitOid;
    const cached = this.#annotationRowsCache;
    if (
      cached &&
      cached.document === built &&
      cached.filePath === file.path &&
      cached.commitOid === commitOid &&
      cached.itemSignature === itemSignature &&
      cached.itemReferences.length === this.#items.length &&
      cached.itemReferences.every((item, index) => item === this.#items[index])
    ) {
      return cached.rows;
    }

    const rows = new Map<number, ReviewItem[]>();
    for (let index = 0; index < built.selections.length; index += 1) {
      const line = built.selections[index]?.line;
      if (!line) continue;
      const annotations = codeAnnotationsForLine(this.#items, snapshot, file.path, line);
      if (annotations.length > 0) rows.set(index, annotations);
    }
    this.#annotationRowsCache = {
      document: built,
      filePath: file.path,
      commitOid,
      itemReferences: this.#items.slice(),
      itemSignature,
      rows,
    };
    return rows;
  }

  #annotationItemSignature(): string {
    return JSON.stringify(
      this.#items.map(item => {
        const anchor = item.anchor;
        if (anchor.kind !== "code") return [item.id, item.source, item.status, anchor.kind];
        return [
          item.id,
          item.source,
          item.status,
          anchor.kind,
          anchor.filePath,
          anchor.commitOid,
          anchor.oldStart,
          anchor.oldEnd,
          anchor.newStart,
          anchor.newEnd,
        ];
      }),
    );
  }

  #documentRowsForPane(rowCount: number): Array<number | undefined> {
    const built = this.#codeDocument;
    const mode = this.#codePane.mode;
    const wrap = this.#codePane.wrap;
    const scrollTop = this.#codePane.scrollTop;
    const paneWidth = this.#lastCodePaneWidth;
    const selectedHunk = this.#codePane.selectedHunk;
    const cached = this.#documentRowsCache;
    if (
      cached &&
      cached.document === built &&
      cached.mode === mode &&
      cached.wrap === wrap &&
      cached.scrollTop === scrollTop &&
      cached.paneWidth === paneWidth &&
      cached.selectedHunk === selectedHunk &&
      cached.rowCount === rowCount
    ) {
      return cached.rows;
    }

    let rows: Array<number | undefined>;
    if (built && mode === "hunk") {
      rows = Array.from({ length: rowCount }, (_, index) => {
        const selection = codeSelectionForHunkVisualRow(built, paneWidth, wrap, scrollTop + index);
        const documentIndex = selection === undefined ? -1 : built.selections.indexOf(selection);
        return documentIndex >= 0 ? documentIndex : undefined;
      });
    } else {
      const savedCursor = this.#codePane.cursor;
      const savedAnchor = this.#codePane.anchor;
      const savedScrollTop = this.#codePane.scrollTop;
      const savedScrollLeft = this.#codePane.scrollLeft;
      const savedSelectedHunk = this.#codePane.selectedHunk;
      rows = [];
      try {
        for (let index = 0; index < rowCount; index += 1) {
          this.#codePane.cursor = -1;
          this.#codePane.anchor = null;
          this.#codePane.clickAt(0, index, false);
          const selection = this.#codePane.selection;
          rows.push(selection && selection.from === selection.to ? selection.from : undefined);
        }
      } finally {
        this.#codePane.cursor = savedCursor;
        this.#codePane.anchor = savedAnchor;
        this.#codePane.scrollTop = savedScrollTop;
        this.#codePane.scrollLeft = savedScrollLeft;
        this.#codePane.selectedHunk = savedSelectedHunk;
      }
    }

    this.#documentRowsCache = {
      document: built,
      mode,
      wrap,
      scrollTop,
      paneWidth,
      selectedHunk,
      rowCount,
      rows,
    };
    return rows;
  }

  #selectedCodeSelection(): CodeSelection | undefined {
    const built = this.#codeDocument;
    if (!built) return undefined;
    const paneSelection = codeSelectionForPane(
      built,
      this.#codePane.selection,
      this.#codePane.mode,
      this.#codePane.selectedHunk,
    );
    const cursorSelection =
      this.#codePane.mode === "hunk"
        ? codeSelectionForHunkVisualRow(
            built,
            this.#lastCodePaneWidth,
            this.#codePane.wrap,
            this.#codePane.cursor,
          )
        : undefined;
    const selection =
      this.#codePane.mode === "hunk"
        ? (cursorSelection !== undefined &&
            (built.hunkSelections[this.#codePane.selectedHunk] ?? []).includes(cursorSelection)
            ? cursorSelection
            : paneSelection)
        : paneSelection;
    if (!selection) return undefined;
    const commitOid = this.#snapshot?.commitOid;
    return commitOid === undefined ? selection : { ...selection, commitOid };
  }

  #selectedCodeHunkLines(): readonly DiffLine[] {
    const selected = this.#selectedCodeSelection();
    if (!selected || !this.#codeDocument) return [];
    const hunk = this.#codeDocument.hunkSelections.find(candidate =>
      candidate.some(item => item.line === selected.line),
    );
    return hunk?.map(item => item.line) ?? [selected.line];
  }

  #syncHunkSelectionFromCursor(): void {
    if (this.#codePane.mode !== "hunk" || !this.#codeDocument) return;
    const targetCursor = this.#codePane.cursor;
    if (targetCursor < 0) return;
    const targetScrollTop = this.#codePane.scrollTop;
    const targetScrollLeft = this.#codePane.scrollLeft;
    const targetAnchor = this.#codePane.anchor;

    this.#codePane.seekHunk("first");
    let selectedHunk = this.#codePane.selectedHunk;
    while (selectedHunk < this.#codeDocument.document.hunks.length - 1 && this.#codePane.cursor < targetCursor) {
      const previousHunk = selectedHunk;
      this.#codePane.jumpHunk(1);
      if (this.#codePane.cursor > targetCursor) {
        this.#codePane.selectedHunk = previousHunk;
        break;
      }
      selectedHunk = this.#codePane.selectedHunk;
    }

    this.#codePane.cursor = targetCursor;
    this.#codePane.scrollTop = targetScrollTop;
    this.#codePane.scrollLeft = targetScrollLeft;
    this.#codePane.anchor = targetAnchor;
  }
}
