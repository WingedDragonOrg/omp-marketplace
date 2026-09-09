import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { DiffPane } from "@oh-my-pi/pi-coding-agent/cli/git-tui/diff-pane";
import {
  Editor,
  matchesKey,
  routeSgrMouseInput,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@oh-my-pi/pi-tui";
import type { AssistantTextEntry, DiffFile, DiffLine, ReviewItem } from "../model";
import type { GitCommit } from "../git";
import type { AssistantSelectionRange } from "../assistant-selection";
import {
  annotationRailGlyph,
  buildAnnotateDiffDocument,
  codeAnnotationsForLine,
  codeSelectionForHunkVisualRow,
  codeSelectionForPane,
  nextAnnotateCodeMode,
  type AnnotateDiffDocument,
} from "./code";
import {
  codeLineLabel,
  composeColumns,
  focusHint,
  formatAssistantSourceSummary,
  formatCodeSourceSummary,
  formatCommitSourceSummary,
  formatReviewQueueSummary,
  oneLine,
  panelHeading as renderPanelHeading,
  previewLines,
  reviewItemLocation,
  statusColor,
  statusLabel,
} from "./presentation";
import { resolveAnnotateLayout, sidebarPanelAtRow } from "./layout";
import { HitRow, type UiHit } from "./primitives";
import type {
  AnnotateFocus,
  AnnotateLayout,
  AnnotateTab,
  AnnotateViewCallbacks,
  AnnotateViewData,
  CodeSelection,
  CodeSource,
} from "./types";

type DraftTarget =
  | { kind: "code"; selection: CodeSelection }
  | {
      kind: "assistant";
      entry: AssistantTextEntry;
      selection?: Pick<AssistantSelectionRange, "start" | "end">;
    }
  | { kind: "edit"; item: ReviewItem };

type SidebarSource =
  | { kind: "file"; file: DiffFile }
  | { kind: "commit"; commit: GitCommit }
  | { kind: "assistant"; entry: AssistantTextEntry };

const ANNOTATION_RAIL_WIDTH = 2;

class AnnotateView implements Component {
  #activeTab: AnnotateTab = "code";
  #focus: AnnotateFocus = "source";
  #sourceIndex = 0;
  #reviewIndex = 0;
  #sourceScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #assistantScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #reviewScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #draftEditor: Editor;
  #draftTarget: DraftTarget | undefined;
  #codePane = new DiffPane();
  #codeDocument: AnnotateDiffDocument | undefined;
  #codeDocumentKey = "";
  #assistantEntryId: string | undefined;
  #hoveredAnnotationId: string | undefined;
  #headerHits: UiHit[] = [];
  #toolbarHits: UiHit[] = [];
  #lastLayout: AnnotateLayout = resolveAnnotateLayout(1, 1);
  #lastContentHeight = 1;
  #lastCodePaneWidth = 1;
  #sidebarGeometry = {
    sourceStart: 1,
    sourceHeight: 0,
    draftStart: 0,
    draftHeight: 0,
    reviewStart: 0,
    reviewHeight: 0,
  };

  /** The overlay itself receives input; this flag lets the nested editor own the cursor. */
  focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly data: AnnotateViewData,
    private readonly callbacks: AnnotateViewCallbacks,
    private readonly done: () => void,
  ) {
    this.#draftEditor = new Editor(getEditorTheme());
    this.#draftEditor.setPromptGutter("> ");
    this.#draftEditor.setScrollbarVisible(true);
    this.#draftEditor.onSubmit = text => this.#submitDraft(text);
    this.#codePane.patchTarget = null;
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, width);
    const terminalRows = Number.isFinite(this.tui.terminal.rows) ? Math.trunc(this.tui.terminal.rows) : 24;
    const frameHeight = Math.max(1, terminalRows);
    const header = this.#header(safeWidth);
    const toolbar = this.#toolbar(safeWidth);
    const chromeRows = Math.min(2, frameHeight);
    const contentHeight = Math.max(1, frameHeight - chromeRows);
    const layout = resolveAnnotateLayout(safeWidth, contentHeight);
    this.#lastLayout = layout;
    this.#lastContentHeight = contentHeight;
    this.#normalizeIndexes();
    this.#syncCodePane();

    const leftRows =
      this.#activeTab === "code"
        ? this.#renderCodePane(Math.max(1, layout.leftWidth), contentHeight)
        : this.#renderAssistantPane(Math.max(1, layout.leftWidth), contentHeight);
    const rightRows = this.#renderSidebar(layout);
    const divider = layout.dividerWidth > 0 ? this.theme.fg(this.#focus === "source" ? "accent" : "borderMuted", "│") : "";
    const lines = [header, toolbar, ...composeColumns(leftRows, rightRows, layout.leftWidth, divider, layout.rightWidth)];
    return lines.slice(0, frameHeight);
  }

  handleInput(data: string): void {
    if (this.#handleMouse(data)) return;
    if (this.#focus === "editor") {
      if (matchesKey(data, "tab")) {
        this.#setFocus("source");
        return;
      }
      if (matchesKey(data, "shift+tab") || matchesKey(data, "ctrl+space")) {
        this.#setFocus("reviews");
        return;
      }
      if (matchesKey(data, "escape")) {
        this.#setFocus("source");
        return;
      }
      this.#draftEditor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.#setFocus(this.#focus === "diff" ? "source" : "diff");
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.#setFocus(this.#focus === "source" ? "diff" : "source");
      return;
    }
    if (matchesKey(data, "ctrl+space")) {
      this.#cycleFocus();
      return;
    }
    if (data === "1") {
      this.#setActiveTab("code");
      return;
    }
    if (data === "2") {
      this.#setActiveTab("assistant");
      return;
    }
    if (data === "s") {
      this.#run(() => this.callbacks.send());
      return;
    }
    if (data === "r") {
      this.#run(() => this.callbacks.refresh());
      return;
    }
    if (data === "e") {
      const hovered = this.#hoveredAnnotation();
      const selected = hovered ?? (this.#focus === "reviews" ? this.data.items[this.#reviewIndex] : undefined);
      if (selected) {
        this.#beginEditAnnotation(selected);
        return;
      }
    }

    if (this.#focus === "diff") {
      this.#handleDiffInput(data);
      return;
    }
    if (this.#focus === "source") {
      this.#handleSourceInput(data);
      return;
    }
    this.#handleReviewInput(data);
  }

  invalidate(): void {
    this.#sourceScroll.invalidate();
    this.#assistantScroll.invalidate();
    this.#reviewScroll.invalidate();
    this.#draftEditor.invalidate();
  }

  #setFocus(focus: AnnotateFocus): void {
    this.#focus = focus;
    if (focus !== "diff") this.#hoveredAnnotationId = undefined;
    this.#codePane.focused = this.focused && focus === "diff";
    this.#draftEditor.focused = this.focused && focus === "editor";
    this.tui.requestRender();
  }

  #cycleFocus(): void {
    const order: AnnotateFocus[] = ["diff", "source", "editor", "reviews"];
    const current = order.indexOf(this.#focus);
    for (let step = 1; step <= order.length; step += 1) {
      const next = order[(current + step) % order.length]!;
      if (next !== "editor" || this.#draftTarget !== undefined) {
        this.#setFocus(next);
        return;
      }
    }
  }

  #setActiveTab(tab: AnnotateTab): void {
    if (this.#activeTab === tab) return;
    this.#activeTab = tab;
    this.#sourceIndex = 0;
    this.#reviewIndex = 0;
    this.#hoveredAnnotationId = undefined;
    this.#assistantEntryId = undefined;
    this.#assistantScroll.scrollToTop();
    this.#codeDocumentKey = "";
    this.#setFocus("source");
  }

  #sourceItems(): SidebarSource[] {
    if (this.#activeTab === "assistant") {
      return this.data.assistantEntries.map(entry => ({ kind: "assistant", entry }));
    }
    if (this.data.codeSource.kind === "commit-list") {
      return this.data.codeCommits.map(commit => ({ kind: "commit", commit }));
    }
    return (this.data.codeSnapshot?.files ?? []).map(file => ({ kind: "file", file }));
  }

  #sourceCount(): number {
    return this.#sourceItems().length;
  }

  #normalizeIndexes(): void {
    const sourceCount = this.#sourceCount();
    this.#sourceIndex = sourceCount === 0 ? 0 : Math.min(this.#sourceIndex, sourceCount - 1);
    this.#reviewIndex = this.data.items.length === 0 ? 0 : Math.min(this.#reviewIndex, this.data.items.length - 1);
  }

  #selectedSource(): SidebarSource | undefined {
    return this.#sourceItems()[this.#sourceIndex];
  }

  #selectedCodeFile(): DiffFile | undefined {
    const source = this.#selectedSource();
    return source?.kind === "file" ? source.file : undefined;
  }

  #syncCodePane(): void {
    if (this.#activeTab !== "code") return;
    const file = this.#selectedCodeFile();
    const snapshot = this.data.codeSnapshot;
    const key = `${snapshot?.diffFingerprint ?? ""}\0${file?.path ?? ""}\0${file?.binary ? "binary" : "text"}`;
    if (key === this.#codeDocumentKey) return;
    this.#codeDocumentKey = key;
    this.#codeDocument = undefined;
    if (!file) {
      this.#codePane.emptyMessage =
        this.data.codeSource.kind === "commit-list"
          ? "Select a recent commit to inspect its changed lines"
          : this.data.codeError
            ? oneLine(this.data.codeError)
            : "No changed files";
      this.#codePane.setDocument(null, "empty");
      return;
    }
    if (file.binary || file.hunks.length === 0) {
      this.#codePane.emptyMessage = file.binary ? "Binary file — no text anchors" : "No selectable changed lines";
      this.#codePane.setDocument(null, "empty");
      return;
    }
    this.#codeDocument = buildAnnotateDiffDocument(file);
    this.#codePane.emptyMessage = "";
    this.#codePane.setDocument(this.#codeDocument.document, "ready");
  }
  #renderCodePane(width: number, height: number): string[] {
    const paneWidth = Math.max(1, width - ANNOTATION_RAIL_WIDTH);
    this.#lastCodePaneWidth = paneWidth;
    const diffRows = this.#codePane.render(paneWidth, height);
    const documentRows = this.#documentRowsForPane(diffRows.length);
    const annotationsByRow = this.#codeAnnotationsByRow();
    return diffRows.map((row, index) => {
      const documentRow = documentRows[index];
      const annotations = documentRow === undefined ? [] : annotationsByRow.get(documentRow) ?? [];
      const hasPrevious = documentRow !== undefined && annotationsByRow.has(documentRows[index - 1] ?? -1);
      const hasNext = documentRow !== undefined && annotationsByRow.has(documentRows[index + 1] ?? -1);
      const glyph = annotationRailGlyph(annotations.length, hasPrevious, hasNext);
      const color = annotations.some(item => item.status === "stale") ? "warning" : "accent";
      return truncateToWidth(`${this.theme.fg(color, glyph)} ${row}`, width);
    });
  }

  #codeAnnotationsByRow(): Map<number, ReviewItem[]> {
    const rows = new Map<number, ReviewItem[]>();
    const built = this.#codeDocument;
    const file = this.#selectedCodeFile();
    if (!built || !file || !this.data.codeSnapshot) return rows;
    for (let index = 0; index < built.selections.length; index += 1) {
      const line = built.selections[index]?.line;
      if (!line) continue;
      const annotations = codeAnnotationsForLine(this.data.items, this.data.codeSnapshot, file.path, line);
      if (annotations.length > 0) rows.set(index, annotations);
    }
    return rows;
  }

  #documentRowsForPane(rowCount: number): Array<number | undefined> {
    const built = this.#codeDocument;
    if (built && this.#codePane.mode === "hunk") {
      return Array.from({ length: rowCount }, (_, index) => {
        const selection = codeSelectionForHunkVisualRow(
          built,
          this.#lastCodePaneWidth,
          this.#codePane.wrap,
          this.#codePane.scrollTop + index,
        );
        const documentIndex = selection === undefined ? -1 : built.selections.indexOf(selection);
        return documentIndex >= 0 ? documentIndex : undefined;
      });
    }
    const savedCursor = this.#codePane.cursor;
    const savedAnchor = this.#codePane.anchor;
    const savedScrollTop = this.#codePane.scrollTop;
    const savedScrollLeft = this.#codePane.scrollLeft;
    const savedSelectedHunk = this.#codePane.selectedHunk;
    const rows: Array<number | undefined> = [];
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
    return rows;
  }

  #annotationAtPaneRow(row: number): ReviewItem | undefined {
    if (row < 0 || !this.#codeDocument || !this.#selectedCodeFile() || !this.data.codeSnapshot) return undefined;
    const documentRow = this.#documentRowsForPane(Math.max(1, row + 1))[row];
    const line = documentRow === undefined ? undefined : this.#codeDocument.selections[documentRow]?.line;
    if (!line) return undefined;
    return codeAnnotationsForLine(
      this.data.items,
      this.data.codeSnapshot,
      this.#selectedCodeFile()!.path,
      line,
    )[0];
  }

  #hoveredAnnotation(): ReviewItem | undefined {
    if (!this.#hoveredAnnotationId) return undefined;
    return this.data.items.find(item => item.id === this.#hoveredAnnotationId);
  }

  #setHoveredAnnotation(item: ReviewItem | undefined): void {
    const nextId = item?.id;
    if (nextId === this.#hoveredAnnotationId) return;
    this.#hoveredAnnotationId = nextId;
    this.tui.requestRender();
  }

  #setHoveredCodeRow(row: number): void {
    this.#setHoveredAnnotation(this.#annotationAtPaneRow(row));
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
    const commitOid = this.data.codeSnapshot?.commitOid;
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

  #renderAssistantPane(width: number, height: number): string[] {
    const selected = this.#selectedSource();
    if (!selected || selected.kind !== "assistant") {
      return Array.from({ length: height }, (_, index) =>
        index === Math.floor(height / 2) ? this.theme.fg("dim", "Choose a message in the dock, then press Enter") : "",
      );
    }
    if (this.#assistantEntryId !== selected.entry.id) {
      this.#assistantEntryId = selected.entry.id;
      this.#assistantScroll.scrollToTop();
    }
    const title = truncateToWidth(
      this.theme.fg(
        "accent",
        this.theme.bold(`Assistant output / ${oneLine(selected.entry.id)}${selected.entry.annotationAllowed ? "" : " / browse-only"}`),
      ),
      width,
    );
    const bodyHeight = Math.max(1, height - 1);
    this.#assistantScroll.setLines(previewLines(selected.entry.text, Math.max(1, width - 1)));
    this.#assistantScroll.setHeight(bodyHeight);
    return [title, ...this.#assistantScroll.render(width)].slice(0, height);
  }
  #sourceRows(): string[] {
    const items = this.#sourceItems();
    if (items.length === 0) {
      if (this.#activeTab === "assistant") return ["No visible assistant messages / press 1 for code"];
      if (this.data.codeSource.kind === "commit-list") {
        return [this.data.codeHistoryError ? `History unavailable / ${oneLine(this.data.codeHistoryError)}` : "No recent commits / press w for working tree"];
      }
      if (this.data.codeSource.kind === "commit") {
        return [this.data.codeError ? `Code unavailable / ${oneLine(this.data.codeError)}` : "No changed lines in this commit / press h for history or w for working tree"];
      }
      return [this.data.codeError ? `Code unavailable / ${oneLine(this.data.codeError)}` : "No changed files / refresh with r"];
    }
    return items.map((item, index) => {
      const selected = index === this.#sourceIndex;
      const pointer = selected ? this.theme.fg("accent", "▎") : " ";
      if (item.kind === "commit") {
        return `${pointer}${this.theme.fg("accent", item.commit.shortOid)} ${this.theme.fg("muted", item.commit.timestamp.slice(0, 10))} ${oneLine(item.commit.subject, 80)}`;
      }
      if (item.kind === "assistant") {
        const protection = item.entry.annotationAllowed ? "" : " / browse-only";
        return `${pointer}${this.theme.fg("muted", oneLine(item.entry.id, 18))} ${oneLine(item.entry.text, 120)}${protection}`;
      }
      const file = item.file;
      const additions = file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === "addition").length;
      const deletions = file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === "deletion").length;
      const kind = file.binary ? "B" : file.oldPath && file.oldPath !== file.path ? "R" : "M";
      const color = file.binary ? "warning" : kind === "R" ? "accent" : "muted";
      const stats = additions || deletions ? `${additions ? `+${additions}` : ""}${deletions ? ` / -${deletions}` : ""}` : "";
      return `${pointer}${this.theme.fg(color, kind)} ${oneLine(file.path, 120)}${stats ? ` ${this.theme.fg("dim", stats)}` : ""}`;
    });
  }
  #reviewRows(): string[] {
    if (this.data.items.length === 0) return ["Queue is empty / annotate a line or message"];
    const hoveredIndex =
      this.#hoveredAnnotationId === undefined
        ? -1
        : this.data.items.findIndex(item => item.id === this.#hoveredAnnotationId);
    const activeIndex = hoveredIndex >= 0 ? hoveredIndex : this.#reviewIndex;
    return this.data.items.map((item, index) => {
      const pointer = index === activeIndex ? this.theme.fg("accent", "▎") : " ";
      const status = this.theme.fg(statusColor(item), statusLabel(item));
      return `${pointer}${status} ${oneLine(reviewItemLocation(item), 100)} / ${oneLine(item.body, 100)}`;
    });
  }
  #renderSidebar(layout: AnnotateLayout): string[] {
    const width = Math.max(1, layout.rightWidth);
    const rows: string[] = [];
    const sourceSummary =
      this.data.codeSource.kind === "commit-list"
        ? this.data.codeHistoryError
          ? "History unavailable"
          : formatCommitSourceSummary(this.data.codeCommits.length)
        : this.data.codeError
          ? "Code unavailable"
          : formatCodeSourceSummary(this.data.codeSnapshot);
    const sourceHeading =
      this.#activeTab === "code"
        ? `Sources / ${this.#codeSourceLabel()} / ${sourceSummary}`
        : `Assistant output / ${formatAssistantSourceSummary(this.data.assistantEntries.length)}`;
    rows.push(this.#panelHeading(sourceHeading, this.#focus === "source"));
    this.#sidebarGeometry.sourceStart = rows.length;
    this.#sidebarGeometry.sourceHeight = layout.sourceHeight;
    this.#sourceScroll.setLines(this.#sourceRows());
    this.#sourceScroll.setHeight(Math.max(1, layout.sourceHeight));
    this.#sourceScroll.setScrollOffset(this.#scrollOffset(this.#sourceIndex, this.#sourceCount(), layout.sourceHeight));
    if (layout.sourceHeight > 0) rows.push(...this.#sourceScroll.render(width).slice(0, layout.sourceHeight));

    const draftTitle =
      this.#focus === "editor"
        ? this.#draftTarget?.kind === "edit"
          ? "Draft / edit"
          : "Draft / writing"
        : "Draft";
    const draftTarget = this.#draftTarget
      ? ` / ${oneLine(this.#draftTargetLabel(), Math.max(12, width - draftTitle.length - 4))}`
      : " / choose a source, then a";
    rows.push(this.#panelHeading(truncateToWidth(`${draftTitle}${draftTarget}`, width - 2), this.#focus === "editor"));
    this.#sidebarGeometry.draftStart = rows.length;
    this.#sidebarGeometry.draftHeight = layout.draftHeight;
    this.#draftEditor.setMaxHeight(Math.max(1, layout.draftHeight));
    this.#draftEditor.focused = this.focused && this.#focus === "editor";
    this.#draftEditor.setUseTerminalCursor(false);
    if (layout.draftHeight > 0) rows.push(...this.#draftEditor.render(width).slice(0, layout.draftHeight));

    rows.push(this.#panelHeading(`Queue / ${formatReviewQueueSummary(this.data.items)}`, this.#focus === "reviews"));
    this.#sidebarGeometry.reviewStart = rows.length;
    this.#sidebarGeometry.reviewHeight = layout.reviewHeight;
    const hoveredReviewIndex =
      this.#hoveredAnnotationId === undefined
        ? -1
        : this.data.items.findIndex(item => item.id === this.#hoveredAnnotationId);
    const reviewIndex = hoveredReviewIndex >= 0 ? hoveredReviewIndex : this.#reviewIndex;
    const reviewRows = this.#reviewRows();
    this.#reviewScroll.setLines(reviewRows);
    this.#reviewScroll.setHeight(Math.max(1, layout.reviewHeight));
    this.#reviewScroll.setScrollOffset(this.#scrollOffset(reviewIndex, reviewRows.length, layout.reviewHeight));
    if (layout.reviewHeight > 0) rows.push(...this.#reviewScroll.render(width).slice(0, layout.reviewHeight));
    return rows.slice(0, layout.bodyHeight);
  }

  #panelHeading(value: string, focused = false): string {
    return renderPanelHeading(this.theme, value, focused);
  }

  #codeSourceLabel(): string {
    if (this.data.codeSource.kind === "working-tree") return "Working tree";
    if (this.data.codeSource.kind === "commit-list") return "Recent commits";
    return `Commit ${oneLine(this.data.codeSource.commit.shortOid)}`;
  }

  #headerContext(): string {
    if (this.#activeTab === "assistant") {
      const selected = this.#selectedSource();
      return selected?.kind === "assistant" ? oneLine(selected.entry.id, 32) : "assistant text";
    }
    const file = this.#selectedCodeFile();
    return file ? oneLine(file.path, 100) : this.#codeSourceLabel();
  }

  #hint(): string {
    if (this.#focus === "diff") {
      if (this.#activeTab === "assistant") return "↑↓ scroll  a annotate  p precise";
      return this.#codePane.mode === "hunk"
        ? "↑↓ hunk  a annotate  p precise"
        : "↑↓ move  ⇧↑↓ select  a annotate  p precise";
    }
    if (this.#focus === "source") return "↑↓ choose  Enter open  a annotate  p precise";
    if (this.#focus === "editor") return "Enter save  Alt+Enter newline  Esc keep draft";
    return "↑↓ choose  e edit  d delete  s send";
  }
  #statusText(): string {
    if (this.data.busy) return this.theme.fg("warning", "Working…");
    if (this.data.notice) {
      const style = this.data.notice.level === "error" ? "error" : this.data.notice.level === "warning" ? "warning" : "muted";
      return this.theme.fg(style, oneLine(this.data.notice.message, 160));
    }
    const hovered = this.#hoveredAnnotation();
    if (hovered) return this.theme.fg(statusColor(hovered), `Annotation: ${oneLine(hovered.body, 120)} / e edit`);
    if (this.#focus === "editor") return focusHint(this.theme, true, "Write feedback / Enter save / Alt+Enter newline");
    if (this.#focus === "reviews" && this.data.items.length > 0) {
      return focusHint(this.theme, true, `${formatReviewQueueSummary(this.data.items)} / s send`);
    }
    return focusHint(this.theme, false, this.#hint());
  }
  #header(width: number): string {
    const left = new HitRow()
      .add(" ")
      .add(this.theme.bold("Annotate"))
      .add("  ")
      .add(this.theme.fg("dim", this.#headerContext()));
    const right = new HitRow()
      .add(this.theme.fg("muted", this.#activeTab === "code" ? "Code" : "Assistant"))
      .add("  ")
      .button(this.theme.fg("muted", "✕"), () => this.done())
      .add(" ");
    const free = Math.max(0, width - left.width - right.width);
    const middle = this.#statusText();
    const middleText = truncateToWidth(middle, Math.max(0, free - 2));
    const leftPad = Math.max(1, Math.floor((free - visibleWidth(middleText)) / 2));
    const rightPad = Math.max(1, free - leftPad - visibleWidth(middleText));
    const rightStart = left.width + leftPad + visibleWidth(middleText) + rightPad;
    this.#headerHits = right.hits.map(hit => ({
      ...hit,
      from: hit.from + rightStart,
      to: hit.to + rightStart,
    }));
    return truncateToWidth(`${left.text}${" ".repeat(leftPad)}${middleText}${" ".repeat(rightPad)}${right.text}`, width);
  }
  #toolbar(width: number): string {
    const row = new HitRow().add(" ");
    row.button(
      this.#activeTab === "code" ? this.theme.fg("accent", this.theme.bold("Code")) : this.theme.fg("muted", "Code"),
      () => this.#setActiveTab("code"),
    );
    row.add("  ");
    row.button(
      this.#activeTab === "assistant"
        ? this.theme.fg("accent", this.theme.bold("Assistant"))
        : this.theme.fg("muted", "Assistant"),
      () => this.#setActiveTab("assistant"),
    );
    row.add("  ").add(this.theme.fg("dim", this.#activeTab === "code" ? this.#codeSourceLabel() : "session branch"));
    if (this.#activeTab === "code") {
      row.add("  ").button(
        this.theme.fg("muted", `view ${this.#codePane.mode}`),
        () => this.#cycleCodeMode(),
      );
    }

    const right = new HitRow()
      .add(this.theme.fg("dim", formatReviewQueueSummary(this.data.items)))
      .add("  ");
    right.button(this.theme.fg("muted", "Send"), () => this.#run(() => this.callbacks.send()));
    right.add("  ");
    right.button(this.theme.fg("muted", "Refresh"), () => this.#run(() => this.callbacks.refresh()));
    const pad = Math.max(1, width - row.width - right.width);
    const rightStart = row.width + pad;
    this.#toolbarHits = [
      ...row.hits,
      ...right.hits.map(hit => ({ ...hit, from: hit.from + rightStart, to: hit.to + rightStart })),
    ];
    return truncateToWidth(`${row.text}${" ".repeat(pad)}${right.text}`, width);
  }

  #cycleCodeMode(): void {
    const nextMode = nextAnnotateCodeMode(this.#codePane.mode);
    if (nextMode === "hunk") this.#codePane.selectedHunk = 0;
    this.#codePane.setMode(nextMode);
    this.tui.requestRender();
  }

  #moveSource(delta: number): void {
    const count = this.#sourceCount();
    if (count === 0) return;
    this.#sourceIndex = Math.max(0, Math.min(this.#sourceIndex + delta, count - 1));
    this.#setHoveredAnnotation(undefined);
    if (this.#activeTab === "code") this.#syncCodePane();
    else this.#assistantScroll.scrollToTop();
    this.tui.requestRender();
  }

  #moveReview(delta: -1 | 1): void {
    const count = this.data.items.length;
    if (count === 0) return;
    this.#reviewIndex = Math.max(0, Math.min(this.#reviewIndex + delta, count - 1));
    this.tui.requestRender();
  }

  #moveCodeFile(delta: -1 | 1): void {
    if (this.data.codeSource.kind === "commit-list") return;
    this.#moveSource(delta);
    this.#setFocus("diff");
  }

  #showCommitList(): void {
    if (this.data.codeSource.kind === "commit-list") return;
    this.data.codeSource = { kind: "commit-list" };
    this.#sourceIndex = 0;
    this.#codeDocumentKey = "";
    this.#syncCodePane();
    this.#setFocus("source");
  }

  #selectWorkingTree(): void {
    if (this.data.codeSource.kind === "working-tree") return;
    this.#run(async () => {
      if (!await this.callbacks.selectWorkingTree()) return;
      this.#sourceIndex = 0;
      this.#codeDocumentKey = "";
      this.#setFocus("source");
    });
  }

  #activateSource(): void {
    const selected = this.#selectedSource();
    if (!selected) return;
    if (selected.kind === "commit") {
      this.#run(async () => {
        if (!await this.callbacks.selectCommit(selected.commit)) return;
        this.#sourceIndex = 0;
        this.#codeDocumentKey = "";
        this.#setFocus("diff");
      });
      return;
    }
    if (selected.kind === "file") {
      this.#syncCodePane();
      this.#setFocus("diff");
      return;
    }
    this.#assistantScroll.scrollToTop();
    this.#setFocus("diff");
  }

  #beginEditAnnotation(item: ReviewItem): void {
    if (item.status !== "pending") {
      this.data.notice = { message: "Only pending annotations can be edited.", level: "warning" };
      this.tui.requestRender();
      return;
    }
    this.#draftTarget = { kind: "edit", item };
    this.#draftEditor.setText(item.body);
    this.#setFocus("editor");
  }

  #beginDraftFromSource(): void {
    const selected = this.#selectedSource();
    if (!selected) {
      this.data.notice = { message: "Select a source first.", level: "warning" };
      this.tui.requestRender();
      return;
    }
    if (selected.kind === "assistant") {
      if (!selected.entry.annotationAllowed) {
        this.data.notice = { message: "This assistant text is browse-only.", level: "warning" };
        this.tui.requestRender();
        return;
      }
      this.#draftTarget = { kind: "assistant", entry: selected.entry };
      this.#draftEditor.setText("");
      this.#setFocus("editor");
      return;
    }
    if (selected.kind === "file") {
      this.#beginCodeDraft();
      return;
    }
    this.data.notice = { message: "Press Enter to open the selected commit first.", level: "warning" };
    this.tui.requestRender();
  }

  #beginCodeDraft(): void {
    const selection = this.#selectedCodeSelection();
    if (!selection) {
      this.data.notice = { message: "Select a text line in the diff first.", level: "warning" };
      this.tui.requestRender();
      return;
    }
    this.#draftTarget = { kind: "code", selection };
    this.#draftEditor.setText("");
    this.#setFocus("editor");
  }

  #beginPreciseAssistantDraft(): void {
    const selected = this.#selectedSource();
    if (!selected || selected.kind !== "assistant") return;
    if (!selected.entry.annotationAllowed) {
      this.data.notice = { message: "This assistant text is browse-only.", level: "warning" };
      this.tui.requestRender();
      return;
    }
    this.#run(async () => {
      const selection = await this.callbacks.selectAssistantPrecise(selected.entry);
      if (!selection) return;
      this.#draftTarget = {
        kind: "assistant",
        entry: selected.entry,
        selection: { start: selection.start, end: selection.end },
      };
      this.#draftEditor.setText("");
      this.#setFocus("editor");
    });
  }

  #beginPreciseCodeDraft(): void {
    const file = this.#selectedCodeFile();
    const lines = this.#selectedCodeHunkLines();
    if (!file || lines.length === 0) {
      this.data.notice = { message: "Select a text line in the diff first.", level: "warning" };
      this.tui.requestRender();
      return;
    }
    this.#run(async () => {
      const selection = await this.callbacks.selectCodePrecise(file.path, lines);
      if (!selection) return;
      this.#draftTarget = { kind: "code", selection };
      this.#draftEditor.setText("");
      this.#setFocus("editor");
    });
  }

  #submitDraft(text: string): void {
    const target = this.#draftTarget;
    if (!target) {
      this.data.notice = { message: "Select a source before writing an annotation.", level: "warning" };
      this.#draftEditor.setText(text);
      this.tui.requestRender();
      return;
    }
    if (!text.trim()) {
      this.data.notice = { message: "Annotation text cannot be empty.", level: "warning" };
      this.#draftEditor.setText(text);
      this.tui.requestRender();
      return;
    }
    this.#run(async () => {
      const saved =
        target.kind === "edit"
          ? await this.callbacks.updateItem(target.item, text)
          : target.kind === "code"
            ? await this.callbacks.addCode(target.selection, text)
            : await this.callbacks.addAssistant(target.entry, text, target.selection);
      if (!saved) {
        this.#draftEditor.setText(text);
        return;
      }
      if (target.kind === "edit") {
        const index = this.data.items.findIndex(item => item.id === target.item.id);
        if (index >= 0) this.#reviewIndex = index;
      }
      const nextFocus: AnnotateFocus = target.kind === "edit" ? "reviews" : target.kind === "code" ? "diff" : "source";
      this.#draftTarget = undefined;
      this.#setFocus(nextFocus);
    });
  }

  #draftTargetLabel(): string {
    const target = this.#draftTarget;
    if (!target) return "Select a source and press a";
    if (target.kind === "edit") return `Edit / ${reviewItemLocation(target.item)}`;
    if (target.kind === "code") {
      const revision = target.selection.commitOid === undefined ? "" : `commit ${target.selection.commitOid.slice(0, 7)} / `;
      const lastLine = target.selection.lines[target.selection.lines.length - 1] ?? target.selection.line;
      const lineLabel =
        target.selection.lines.length > 1
          ? `${codeLineLabel(target.selection.line)}–${codeLineLabel(lastLine)}`
          : codeLineLabel(target.selection.line);
      const textRange =
        target.selection.startOffset === undefined || target.selection.endOffset === undefined
          ? ""
          : ` / text ${target.selection.startOffset}–${target.selection.endOffset}`;
      return `Code / ${revision}${target.selection.filePath}:${lineLabel}${textRange}`;
    }
    const range = target.selection ? `chars ${target.selection.start}–${target.selection.end}` : "whole message";
    return `Assistant / ${target.entry.id} / ${range}`;
  }

  #moveHunkSelection(data: string): boolean {
    if (this.#codePane.mode !== "hunk") return false;
    if (
      matchesKey(data, "shift+up") ||
      matchesKey(data, "up") ||
      data === "k" ||
      matchesKey(data, "pageUp")
    ) {
      this.#codePane.jumpHunk(-1);
      return true;
    }
    if (
      matchesKey(data, "shift+down") ||
      matchesKey(data, "down") ||
      data === "j" ||
      matchesKey(data, "pageDown") ||
      data === " "
    ) {
      this.#codePane.jumpHunk(1);
      return true;
    }
    if (matchesKey(data, "home") || data === "g") {
      this.#codePane.seekHunk("first");
      return true;
    }
    if (matchesKey(data, "end") || data === "G") {
      this.#codePane.seekHunk("last");
      return true;
    }
    return false;
  }

  #handleDiffInput(data: string): void {
    if (this.#activeTab === "assistant") {
      if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
        this.#assistantScroll.handleScrollKey(data);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "up") || data === "k") {
        this.#assistantScroll.scroll(-1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "down") || data === "j") {
        this.#assistantScroll.scroll(1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "home") || data === "g") {
        this.#assistantScroll.scrollToTop();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "end") || data === "G") {
        this.#assistantScroll.scrollToBottom();
        this.tui.requestRender();
        return;
      }
      if (data === "p") {
        this.#beginPreciseAssistantDraft();
        return;
      }
      if (data === "a" || matchesKey(data, "enter")) this.#beginDraftFromSource();
      return;
    }

    if (this.#moveHunkSelection(data)) {
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+up")) this.#codePane.moveCursor(-1, true);
    else if (matchesKey(data, "shift+down")) this.#codePane.moveCursor(1, true);
    else if (matchesKey(data, "up") || data === "k") this.#codePane.moveCursor(-1, false);
    else if (matchesKey(data, "down") || data === "j") this.#codePane.moveCursor(1, false);
    else if (matchesKey(data, "pageUp")) this.#codePane.moveCursor(-Math.max(1, this.#lastContentHeight - 2), false);
    else if (matchesKey(data, "pageDown") || data === " ") this.#codePane.moveCursor(Math.max(1, this.#lastContentHeight - 2), false);
    else if (matchesKey(data, "left") || data === "h") this.#codePane.scrollLeftBy(-8);
    else if (matchesKey(data, "right") || data === "l") this.#codePane.scrollLeftBy(8);
    else if (matchesKey(data, "home") || data === "g") this.#codePane.cursorToEdge("start");
    else if (matchesKey(data, "end") || data === "G") this.#codePane.cursorToEdge("end");
    else if (data === "[") this.#moveCodeFile(-1);
    else if (data === "]") this.#moveCodeFile(1);
    else if (data === "v") this.#cycleCodeMode();
    else if (data === "W") this.#codePane.toggleWrap();
    else if (data === "p") this.#beginPreciseCodeDraft();
    else if (data === "a" || matchesKey(data, "enter")) this.#beginCodeDraft();
    else return;
    this.tui.requestRender();
  }

  #handleSourceInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      this.#moveSource(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.#moveSource(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.#moveSource(-Math.max(1, this.#lastLayout.sourceHeight - 1));
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.#moveSource(Math.max(1, this.#lastLayout.sourceHeight - 1));
      return;
    }
    if (matchesKey(data, "enter")) {
      this.#activateSource();
      return;
    }
    if (data === "a") {
      this.#beginDraftFromSource();
      return;
    }
    if (data === "p") {
      if (this.#activeTab === "assistant") this.#beginPreciseAssistantDraft();
      else if (this.#selectedSource()?.kind === "file") this.#beginPreciseCodeDraft();
      return;
    }
    if (data === " ") {
      this.#setFocus("reviews");
      return;
    }
    if (data === "h" && this.#activeTab === "code") {
      this.#showCommitList();
      return;
    }
    if (data === "w" && this.#activeTab === "code") {
      this.#selectWorkingTree();
      return;
    }
    if (matchesKey(data, "shift+up") || matchesKey(data, "shift+down")) {
      this.#sourceScroll.handleScrollKey(data);
      this.tui.requestRender();
    }
  }

  #handleReviewInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      this.#moveReview(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.#moveReview(1);
      return;
    }
    if (data === " ") {
      this.#setFocus("source");
      return;
    }
    if (data === "e") {
      const selected = this.data.items[this.#reviewIndex];
      if (selected) this.#beginEditAnnotation(selected);
      return;
    }
    if (data === "d") {
      const selected = this.data.items[this.#reviewIndex];
      if (selected) this.#run(() => this.callbacks.deleteItem(selected));
    }
  }

  #scrollOffset(index: number, rowCount: number, height: number): number {
    if (height <= 0 || rowCount <= height) return 0;
    return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
  }

  #handleSidebarClick(row: number): void {
    const panel = sidebarPanelAtRow(row, this.#sidebarGeometry);
    if (panel === "sources") {
      const sourceStart = this.#sidebarGeometry.sourceStart;
      if (row >= sourceStart) {
        const index = this.#sourceScroll.getScrollOffset() + row - sourceStart;
        if (index >= 0 && index < this.#sourceCount()) {
          this.#sourceIndex = index;
          this.#activateSource();
        }
      } else {
        this.#setFocus("source");
      }
      return;
    }
    if (panel === "draft") {
      this.#setFocus("editor");
      return;
    }
    if (panel === "reviews") {
      const reviewStart = this.#sidebarGeometry.reviewStart;
      if (row >= reviewStart) {
        const index = this.#reviewScroll.getScrollOffset() + row - reviewStart;
        if (index >= 0 && index < this.data.items.length) this.#reviewIndex = index;
      }
      this.#setFocus("reviews");
    }
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

  #handleMouse(data: string): boolean {
    if (!data.startsWith("\x1b[<")) return false;
    return routeSgrMouseInput(data, event => {
      if (event.row === 0) {
        this.#setHoveredAnnotation(undefined);
        if (event.leftClick) this.#headerHits.find(hit => event.col >= hit.from && event.col < hit.to)?.action();
        return true;
      }
      if (event.row === 1) {
        this.#setHoveredAnnotation(undefined);
        if (event.leftClick) this.#toolbarHits.find(hit => event.col >= hit.from && event.col < hit.to)?.action();
        return true;
      }
      const contentRow = event.row - 2;
      if (contentRow < 0) {
        this.#setHoveredAnnotation(undefined);
        return true;
      }
      const rightStart = this.#lastLayout.leftWidth + this.#lastLayout.dividerWidth;
      const inSidebar = event.col >= rightStart;
      if (event.wheel !== null) {
        if (inSidebar) {
          this.#setHoveredAnnotation(undefined);
          const localRow = contentRow;
          const sourceStart = this.#sidebarGeometry.sourceStart;
          const sourceEnd = sourceStart + this.#sidebarGeometry.sourceHeight;
          if (localRow >= sourceStart && localRow < sourceEnd) this.#sourceScroll.scroll(event.wheel * 3);
          else if (localRow >= this.#sidebarGeometry.reviewStart) this.#reviewScroll.scroll(event.wheel * 3);
        } else if (this.#activeTab === "code") {
          this.#codePane.scrollBy(event.wheel * 3);
          this.#setHoveredCodeRow(contentRow);
        } else {
          this.#setHoveredAnnotation(undefined);
          this.#assistantScroll.scroll(event.wheel * 3);
        }
        this.tui.requestRender();
        return true;
      }
      if (this.#activeTab === "code" && !inSidebar) {
        if (event.motion) {
          this.#setHoveredCodeRow(contentRow);
          return true;
        }
        if (event.leftClick) {
          this.#setHoveredCodeRow(contentRow);
          this.#setFocus("diff");
          this.#syncHunkSelectionFromCursor();
          const selectedHunkAtClick = this.#codePane.selectedHunk;
          this.#codePane.clickAt(Math.max(0, event.col - ANNOTATION_RAIL_WIDTH), contentRow, (event.button & 4) !== 0);
          if (this.#codePane.selectedHunk === selectedHunkAtClick) this.#syncHunkSelectionFromCursor();
          this.#setHoveredCodeRow(contentRow);
          this.tui.requestRender();
          return true;
        }
      }
      if (!event.leftClick) {
        if (this.#activeTab === "code" && !inSidebar) this.#setHoveredCodeRow(contentRow);
        else this.#setHoveredAnnotation(undefined);
        return true;
      }
      if (inSidebar) {
        this.#handleSidebarClick(contentRow);
        this.tui.requestRender();
        return true;
      }
      this.#setFocus("diff");
      this.tui.requestRender();
      return true;
    });
  }

  #run(operation: () => Promise<void>): void {
    if (this.data.busy) return;
    this.data.busy = true;
    this.data.notice = undefined;
    this.tui.requestRender();
    void operation()
      .catch(error => {
        this.data.notice = { message: error instanceof Error ? error.message : String(error), level: "error" };
      })
      .finally(() => {
        this.data.busy = false;
        this.tui.requestRender();
      });
  }
}

export function createAnnotateView(
  tui: TUI,
  theme: Theme,
  data: AnnotateViewData,
  callbacks: AnnotateViewCallbacks,
  done: () => void,
): Component {
  return new AnnotateView(tui, theme, data, callbacks, done);
}

