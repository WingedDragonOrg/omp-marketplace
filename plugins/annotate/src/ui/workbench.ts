import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
  routeSgrMouseInput,
  ScrollView,
  truncateToWidth,
  type Component,
  type SgrMouseEvent,
  type TUI,
} from "@oh-my-pi/pi-tui";
import type { AssistantTextEntry, DiffFile, ReviewItem } from "../model";
import type { AssistantSelectionRange } from "../assistant-selection";
import { AnnotationCard, type AnnotationCardHit } from "./annotation-card";
import { AnnotatedCodePane, ANNOTATION_RAIL_WIDTH } from "./code-pane";
import { renderHeader, renderToolbar } from "./chrome";
import { AnnotateDock } from "./dock";
import { renderHelpSheet } from "./help";
import {
  annotateHints,
  annotateKeySections,
  resolveAnnotateAction,
  type AnnotateAction,
  type AnnotateScope,
} from "./keymap";
import { resolveAnnotateLayout } from "./layout";
import { activeNotice, createNotice, noticeRepaintDelay, type NoticeLevel } from "./notice";
import { PointerTracker, type PointerGesture } from "./pointer";
import {
  composeColumns,
  compactPath,
  formatAssistantSourceSummary,
  formatAssistantTarget,
  formatCodeSelectionTarget,
  formatCodeSourceSummary,
  formatCommitSourceSummary,
  formatReviewQueueSummary,
  oneLine,
  previewLines,
  renderKeyHints,
  reviewItemLocation,
  statusColor,
} from "./presentation";
import { renderSidebarRow, reviewRowModel, sourceRowModel, type SidebarSource } from "./sidebar";
import type { UiHit } from "./primitives";
import type {
  AnnotateFocus,
  AnnotateLayout,
  AnnotateTab,
  AnnotateViewCallbacks,
  AnnotateViewData,
  CodeSelection,
} from "./types";

type DraftTarget =
  | { kind: "code"; selection: CodeSelection }
  | {
      kind: "assistant";
      entry: AssistantTextEntry;
      selection?: Pick<AssistantSelectionRange, "start" | "end">;
    }
  | { kind: "edit"; item: ReviewItem };

const CHROME_ROWS = 2;
/** Pick a source, read it, write the note, check the queue. */
const FOCUS_ORDER: readonly AnnotateFocus[] = ["source", "diff", "editor", "reviews"];

class AnnotateView implements Component {
  #activeTab: AnnotateTab = "code";
  #focus: AnnotateFocus = "source";
  #sourceIndex = 0;
  #reviewIndex = 0;
  /** The dock lists revisions instead of the current revision's files. */
  #revisions = false;
  #helpOpen = false;
  #dockCollapsed = false;
  #assistantScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #helpScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #dock = new AnnotateDock();
  #pane: AnnotatedCodePane;
  #card = new AnnotationCard();
  #pointer = new PointerTracker();
  #draftTarget: DraftTarget | undefined;
  #assistantEntryId: string | undefined;
  #hoveredAnnotationId: string | undefined;
  /** Evidence row the open card explains; undefined while no card is open. */
  #cardRow: number | undefined;
  #cardIndex = 0;
  #cardTop = 0;
  #cardHeight = 0;
  #cardHits: readonly AnnotationCardHit[] = [];
  /** A press landed on the diff, so motion extends its selection. */
  #dragging = false;
  #headerHits: UiHit[] = [];
  #toolbarHits: UiHit[] = [];
  #lastLayout: AnnotateLayout = resolveAnnotateLayout(1, 1);
  #lastContentHeight = 1;
  #noticeDeadline: number | undefined;

  /** The overlay itself receives input; this flag lets the nested editor own the cursor. */
  focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly data: AnnotateViewData,
    private readonly callbacks: AnnotateViewCallbacks,
    private readonly done: () => void,
  ) {
    this.#pane = new AnnotatedCodePane(theme);
    this.#dock.editor.onSubmit = text => this.#submitDraft(text);
    this.data.onChange = () => this.tui.requestRender();
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, width);
    const terminalRows = Number.isFinite(this.tui.terminal.rows) ? Math.trunc(this.tui.terminal.rows) : 24;
    const frameHeight = Math.max(1, terminalRows);
    const contentHeight = Math.max(1, frameHeight - Math.min(CHROME_ROWS, frameHeight));
    const layout = resolveAnnotateLayout(safeWidth, contentHeight, this.#dockCollapsed);
    this.#lastLayout = layout;
    this.#lastContentHeight = contentHeight;
    this.#normalizeIndexes();
    this.#syncPane();
    this.#scheduleNoticeExpiry();

    const header = renderHeader(this.theme, safeWidth, {
      context: this.#headerContext(),
      status: budget => this.#statusText(budget),
      onHelp: () => this.#toggleHelp(),
      onClose: () => this.#close(),
    });
    this.#headerHits = header.hits;
    const toolbar = renderToolbar(this.theme, safeWidth, {
      tab: this.#activeTab,
      sourceLabel: this.#activeTab === "code" ? compactPath(this.#codeSourceLabel(), 40) : "session branch",
      revisionsOpen: this.#revisions,
      viewLabel: this.#activeTab === "code" ? this.#pane.mode : undefined,
      pendingCount: this.data.items.filter(item => item.status === "pending").length,
      staleCount: this.data.items.filter(item => item.status === "stale").length,
      onTab: tab => this.#setActiveTab(tab),
      onRevisions: () => this.#toggleRevisions(),
      onView: () => this.#cycleCodeMode(),
      onSend: () => this.#run(() => this.callbacks.send()),
      onRefresh: () => this.#run(() => this.callbacks.refresh()),
    });
    this.#toolbarHits = toolbar.hits;

    const evidenceWidth = Math.max(1, layout.leftWidth);
    const leftRows = this.#evidenceRows(evidenceWidth, contentHeight);
    const rightRows = this.#dockCollapsed ? [] : this.#dock.render(this.theme, layout, this.#dockModel(layout));
    const divider = layout.dividerWidth > 0 ? this.theme.fg("borderMuted", "│") : "";
    const lines = [
      header.text,
      toolbar.text,
      ...composeColumns(leftRows, rightRows, layout.leftWidth, divider, layout.rightWidth),
    ];
    return lines.slice(0, frameHeight);
  }

  #evidenceRows(width: number, height: number): readonly string[] {
    if (this.#helpOpen) {
      this.#helpScroll.setLines(renderHelpSheet(this.theme, width, annotateKeySections(this.#scope())));
      this.#helpScroll.setHeight(height);
      return this.#helpScroll.render(width);
    }
    if (this.#activeTab !== "code") return this.#renderAssistantPane(width, height);
    return this.#overlayCard(this.#pane.render(width, height), width, height);
  }

  /**
   * Float the card next to the row it explains, below when there is room and
   * above otherwise, so the marked line itself stays readable.
   */
  #overlayCard(rows: string[], width: number, height: number): string[] {
    const anchor = this.#cardRow;
    if (anchor === undefined) return rows;
    const items = this.#pane.annotationsAtRow(anchor);
    if (items.length === 0) {
      this.#cardRow = undefined;
      this.#cardHits = [];
      return rows;
    }
    this.#cardIndex = Math.min(this.#cardIndex, items.length - 1);
    const frame = this.#card.render(this.theme, width, Math.max(3, height - 1), {
      target: this.#cardTargetLabel(anchor, Math.max(8, width - 24)),
      items,
      index: this.#cardIndex,
      onAnnotateAgain: () => this.#beginDraft(),
      onEdit: () => this.#editFocusedAnnotation(),
      onDelete: () => this.#deleteFocusedAnnotation(),
      onClose: () => this.#closeCard(),
    });
    if (frame.rows.length === 0) return rows;
    let top = anchor + 1;
    if (top + frame.rows.length > height) top = anchor - frame.rows.length;
    if (top < 0) top = Math.max(0, height - frame.rows.length);
    this.#cardTop = top;
    this.#cardHeight = frame.rows.length;
    this.#cardHits = frame.hits;
    const merged = rows.slice();
    while (merged.length < top + frame.rows.length) merged.push("");
    frame.rows.forEach((row, index) => {
      merged[top + index] = row;
    });
    return merged;
  }

  /** Name the annotated line the way the draft heading names a target. */
  #cardTargetLabel(row: number, maxWidth: number): string {
    const selection = this.#pane.selectionAtRow(row);
    if (!selection) return "this line";
    const { commitOid, ...current } = selection;
    return formatCodeSelectionTarget(
      commitOid === this.data.codeSnapshot?.commitOid ? current : selection,
      maxWidth,
    );
  }

  handleInput(data: string): void {
    if (this.#handleMouse(data)) return;
    const action = resolveAnnotateAction(data, this.#scope());
    if (action !== undefined) {
      this.#runAction(action);
      return;
    }
    if (this.#focus === "editor") {
      this.#dock.editor.handleInput(data);
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.#assistantScroll.invalidate();
    this.#helpScroll.invalidate();
    this.#pane.invalidate();
    this.#card.invalidate();
    this.#dock.invalidate();
  }

  #scope(): AnnotateScope {
    return {
      focus: this.#focus,
      tab: this.#activeTab,
      codeMode: this.#pane.mode,
      hasDraft: this.#draftTarget !== undefined,
      revisions: this.#revisions,
      dockCollapsed: this.#dockCollapsed,
      helpOpen: this.#helpOpen,
      cardOpen: this.#cardRow !== undefined,
    };
  }

  #runAction(action: AnnotateAction): void {
    switch (action) {
      case "help":
      case "closeHelp":
        this.#toggleHelp();
        return;
      case "close":
        this.#close();
        return;
      case "focusNext":
        this.#cycleFocus(1);
        return;
      case "focusPrev":
        this.#cycleFocus(-1);
        return;
      case "leaveEditor":
        this.#leaveEditor();
        return;
      case "tabCode":
        this.#setActiveTab("code");
        return;
      case "tabAssistant":
        this.#setActiveTab("assistant");
        return;
      case "send":
        this.#run(() => this.callbacks.send());
        return;
      case "refresh":
        this.#run(() => this.callbacks.refresh());
        return;
      case "toggleDock":
        this.#toggleDock();
        return;
      case "toggleRevisions":
        this.#toggleRevisions();
        return;
      case "cycleView":
        this.#cycleCodeMode();
        return;
      case "toggleWrap":
        this.#closeCard();
        this.#pane.toggleWrap();
        this.tui.requestRender();
        return;
      case "inspect":
        this.#inspectCurrentLine();
        return;
      case "closeCard":
        this.#closeCard();
        return;
      case "annotate":
        this.#beginDraft();
        return;
      case "annotatePrecise":
        this.#beginPreciseDraft();
        return;
      case "openSource":
        this.#activateSource();
        return;
      case "edit":
        this.#editFocusedAnnotation();
        return;
      case "discardDraft":
        this.#discardDraft();
        return;
      case "deleteAnnotation":
        this.#deleteFocusedAnnotation();
        return;
      case "revealAnnotation":
        this.#revealSelectedAnnotation();
        return;
      case "prevFile":
        this.#moveCodeFile(-1);
        return;
      case "nextFile":
        this.#moveCodeFile(1);
        return;
      default:
        this.#move(action);
        return;
    }
  }

  #notice(message: string, level: NoticeLevel): void {
    this.data.notice = createNotice(message, level);
    this.tui.requestRender();
  }

  /** Repaint once when the current notice expires so the hint line comes back. */
  #scheduleNoticeExpiry(): void {
    const expiresAt = this.data.notice?.expiresAt;
    if (expiresAt === undefined || expiresAt === this.#noticeDeadline) return;
    this.#noticeDeadline = expiresAt;
    const delay = noticeRepaintDelay(this.data.notice);
    if (delay === undefined) return;
    const timer = setTimeout(() => this.tui.requestRender(), delay);
    timer.unref?.();
  }

  #close(): void {
    this.data.onChange = undefined;
    this.done();
  }

  /** Open the card on a marked evidence row, or do nothing when it is bare. */
  #openCard(row: number): void {
    if (this.#activeTab !== "code") return;
    if (this.#pane.annotationsAtRow(row).length === 0) {
      this.#notice("Nothing is annotated on that line yet. Press a to add one.", "info");
      return;
    }
    this.#cardRow = row;
    this.#cardIndex = 0;
    this.#setFocus("diff");
    this.tui.requestRender();
  }

  #closeCard(): void {
    if (this.#cardRow === undefined) return;
    this.#cardRow = undefined;
    this.#cardHits = [];
    this.tui.requestRender();
  }

  /** Open the card on the line the cursor is reading, for keyboard users. */
  #inspectCurrentLine(): void {
    this.#syncPane();
    const row = this.#pane.cursorRow();
    if (row === undefined) {
      this.#notice("Move to a changed line first.", "warning");
      return;
    }
    this.#openCard(row);
  }

  /** The card owns the annotation the footer keys act on, so `e`/`d` are precise. */
  #cardItems(): readonly ReviewItem[] {
    return this.#cardRow === undefined ? [] : this.#pane.annotationsAtRow(this.#cardRow);
  }

  #moveCard(delta: -1 | 1): void {
    const items = this.#cardItems();
    if (items.length === 0) return;
    this.#cardIndex = Math.max(0, Math.min(this.#cardIndex + delta, items.length - 1));
    this.tui.requestRender();
  }

  #toggleHelp(): void {
    this.#helpOpen = !this.#helpOpen;
    if (this.#helpOpen) this.#helpScroll.scrollToTop();
    this.tui.requestRender();
  }

  #toggleDock(): void {
    this.#closeCard();
    this.#dockCollapsed = !this.#dockCollapsed;
    if (this.#dockCollapsed) this.#setFocus("diff");
    else this.tui.requestRender();
  }

  #setFocus(focus: AnnotateFocus): void {
    this.#focus = this.#dockCollapsed && focus !== "diff" ? "diff" : focus;
    if (this.#focus !== "diff") {
      this.#hoveredAnnotationId = undefined;
      this.#closeCard();
    }
    this.#pane.focused = this.focused && this.#focus === "diff";
    this.#dock.editor.focused = this.focused && this.#focus === "editor";
    this.tui.requestRender();
  }

  #cycleFocus(step: 1 | -1): void {
    const current = FOCUS_ORDER.indexOf(this.#focus);
    for (let offset = 1; offset <= FOCUS_ORDER.length; offset += 1) {
      const index = (((current + step * offset) % FOCUS_ORDER.length) + FOCUS_ORDER.length) % FOCUS_ORDER.length;
      const next = FOCUS_ORDER[index]!;
      if (next === "editor" && this.#draftTarget === undefined) continue;
      if (this.#dockCollapsed && next !== "diff") continue;
      this.#setFocus(next);
      return;
    }
  }

  #setActiveTab(tab: AnnotateTab): void {
    if (this.#activeTab === tab) return;
    this.#activeTab = tab;
    this.#sourceIndex = 0;
    this.#reviewIndex = 0;
    this.#revisions = false;
    this.#hoveredAnnotationId = undefined;
    this.#assistantEntryId = undefined;
    this.#assistantScroll.scrollToTop();
    this.#setFocus("source");
  }

  #toggleRevisions(): void {
    if (this.#activeTab !== "code") {
      this.#setActiveTab("code");
      return;
    }
    this.#revisions = !this.#revisions;
    this.#sourceIndex = 0;
    this.#setFocus("source");
  }

  #cycleCodeMode(): void {
    this.#closeCard();
    this.#pane.cycleMode();
    this.tui.requestRender();
  }

  #sourceItems(): SidebarSource[] {
    if (this.#activeTab === "assistant") {
      return this.data.assistantEntries.map(entry => ({ kind: "assistant", entry }));
    }
    if (this.#revisions) {
      return [
        { kind: "working-tree", summary: formatCodeSourceSummary(this.data.codeWorkingSnapshot) },
        ...this.data.codeCommits.map(commit => ({ kind: "commit" as const, commit })),
      ];
    }
    return (this.data.codeSnapshot?.files ?? []).map(file => ({ kind: "file", file }));
  }

  #normalizeIndexes(): void {
    const sourceCount = this.#sourceItems().length;
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

  #syncPane(): void {
    if (this.#activeTab !== "code") return;
    const file = this.#selectedCodeFile();
    this.#pane.setContext({
      file,
      snapshot: this.data.codeSnapshot,
      items: this.data.items,
      emptyMessage: this.#paneEmptyMessage(file),
    });
  }

  #paneEmptyMessage(file: DiffFile | undefined): string {
    if (this.#revisions) return "Choose a revision in the dock, then press Enter";
    if (!file) return this.data.codeError ? oneLine(this.data.codeError) : "No changed files";
    if (file.binary) return "Binary file, so there is nothing to anchor to";
    if (file.hunks.length === 0) return "No selectable changed lines";
    return "";
  }

  #renderAssistantPane(width: number, height: number): string[] {
    const selected = this.#selectedSource();
    if (!selected || selected.kind !== "assistant") {
      return Array.from({ length: height }, (_, index) =>
        index === Math.floor(height / 2)
          ? this.theme.fg("dim", "Choose a message in the dock, then press Enter")
          : "",
      );
    }
    if (this.#assistantEntryId !== selected.entry.id) {
      this.#assistantEntryId = selected.entry.id;
      this.#assistantScroll.scrollToTop();
    }
    const suffix = selected.entry.annotationAllowed ? "" : ", browse only";
    const title = truncateToWidth(
      this.theme.fg("accent", this.theme.bold(`Assistant message ${oneLine(selected.entry.id, 32)}${suffix}`)),
      width,
    );
    this.#assistantScroll.setLines(previewLines(selected.entry.text, Math.max(1, width - 1)));
    this.#assistantScroll.setHeight(Math.max(1, height - 1));
    return [title, ...this.#assistantScroll.render(width)].slice(0, height);
  }

  /** The toolbar already names the revision, so the heading counts what is listed. */
  #sourceHeading(): string {
    if (this.#activeTab === "assistant") {
      return `Sources: ${formatAssistantSourceSummary(this.data.assistantEntries.length).toLowerCase()}`;
    }
    if (this.#revisions) {
      return this.data.codeHistoryError === undefined
        ? `Revisions: ${formatCommitSourceSummary(this.data.codeCommits.length).toLowerCase()}`
        : "Revisions: history unavailable";
    }
    return this.data.codeError === undefined
      ? `Sources: ${formatCodeSourceSummary(this.data.codeSnapshot).toLowerCase()}`
      : "Sources: code unavailable";
  }

  #sourceRows(width: number): string[] {
    const items = this.#sourceItems();
    if (items.length === 0) return [truncateToWidth(this.theme.fg("dim", this.#emptySourceMessage()), Math.max(1, width), "")];
    return items.map((item, index) =>
      renderSidebarRow(this.theme, width, sourceRowModel(this.theme, item), {
        selected: index === this.#sourceIndex,
        focused: this.#focus === "source",
      }),
    );
  }

  #emptySourceMessage(): string {
    if (this.#activeTab === "assistant") return "No visible messages. Press 1 for code.";
    if (this.#revisions) {
      return this.data.codeHistoryError === undefined
        ? "No recent commits."
        : `History unavailable: ${oneLine(this.data.codeHistoryError)}`;
    }
    if (this.data.codeError !== undefined) return `Code unavailable: ${oneLine(this.data.codeError)}`;
    return this.data.codeSource.kind === "commit"
      ? "No changed lines in this commit. Press H for another revision."
      : "No changed files. Press r to refresh or H to browse revisions.";
  }

  #queueRows(width: number): string[] {
    if (this.data.items.length === 0) {
      return [truncateToWidth(this.theme.fg("dim", "Queue is empty. Annotate a line or a message."), width, "")];
    }
    const activeIndex = this.#activeQueueIndex();
    return this.data.items.map((item, index) =>
      renderSidebarRow(this.theme, width, reviewRowModel(this.theme, item), {
        selected: index === activeIndex,
        focused: this.#focus === "reviews",
      }),
    );
  }

  /** Hovering a rail annotation points the queue at it without moving the selection. */
  #activeQueueIndex(): number {
    if (this.#hoveredAnnotationId === undefined) return this.#reviewIndex;
    const hovered = this.data.items.findIndex(item => item.id === this.#hoveredAnnotationId);
    return hovered >= 0 ? hovered : this.#reviewIndex;
  }

  #dockModel(layout: AnnotateLayout) {
    const width = Math.max(1, layout.rightWidth);
    const sources = this.#sourceItems();
    this.#dock.editor.focused = this.focused && this.#focus === "editor";
    return {
      sources: {
        heading: this.#sourceHeading(),
        rows: this.#sourceRows(width),
        index: this.#sourceIndex,
        count: sources.length,
        focused: this.#focus === "source",
      },
      draft: {
        heading: `Draft: ${this.#draftTargetLabel(Math.max(8, width - 10))}`,
        focused: this.#focus === "editor",
        hasTarget: this.#draftTarget !== undefined,
        onDiscard: () => this.#discardDraft(),
      },
      queue: {
        heading: `Queue: ${formatReviewQueueSummary(this.data.items)}`,
        rows: this.#queueRows(width),
        index: this.#activeQueueIndex(),
        count: this.data.items.length,
        focused: this.#focus === "reviews",
      },
    };
  }

  #codeSourceLabel(): string {
    if (this.data.codeSource.kind === "working-tree") return "Working tree";
    return `Commit ${oneLine(this.data.codeSource.commit.shortOid)}`;
  }

  #headerContext(): string {
    if (this.#helpOpen) return "keys";
    if (this.#activeTab === "assistant") {
      const selected = this.#selectedSource();
      return selected?.kind === "assistant" ? compactPath(selected.entry.id, 32) : "assistant output";
    }
    if (this.#revisions) return "revisions";
    const file = this.#selectedCodeFile();
    return file ? compactPath(file.path, 48) : this.#codeSourceLabel();
  }

  #statusText(budget: number): string {
    if (this.data.busy) return this.theme.fg("warning", "Working…");
    const notice = activeNotice(this.data.notice);
    if (notice) {
      const style = notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "muted";
      return this.theme.fg(style, oneLine(notice.message, 160));
    }
    const hovered = this.#hoveredAnnotation();
    if (hovered && this.#cardRow === undefined) {
      return this.theme.fg(statusColor(hovered), `${oneLine(hovered.body, 96)} — click to read all`);
    }
    return renderKeyHints(this.theme, annotateHints(this.#scope()), budget);
  }

  #hoveredAnnotation(): ReviewItem | undefined {
    if (this.#hoveredAnnotationId === undefined) return undefined;
    return this.data.items.find(item => item.id === this.#hoveredAnnotationId);
  }

  #setHoveredAnnotation(item: ReviewItem | undefined): void {
    if (item?.id === this.#hoveredAnnotationId) return;
    this.#hoveredAnnotationId = item?.id;
    this.tui.requestRender();
  }

  #move(action: AnnotateAction): void {
    if (this.#helpOpen) {
      this.#moveScroll(this.#helpScroll, action);
      return;
    }
    if (this.#cardRow !== undefined) {
      if (action === "moveUp") this.#moveCard(-1);
      else if (action === "moveDown") this.#moveCard(1);
      else if (action === "pageUp") this.#card.scroll(-3);
      else if (action === "pageDown") this.#card.scroll(3);
      else return;
      this.tui.requestRender();
      return;
    }
    if (this.#focus === "diff") {
      if (this.#activeTab === "assistant") {
        this.#moveScroll(this.#assistantScroll, action);
        return;
      }
      this.#moveCode(action);
      this.tui.requestRender();
      return;
    }
    if (this.#focus === "source") {
      this.#moveList(action, this.#sourceItems().length, Math.max(1, this.#lastLayout.sourceHeight - 1), index => {
        this.#sourceIndex = index;
        this.#setHoveredAnnotation(undefined);
        if (this.#activeTab === "code") this.#syncPane();
        else this.#assistantScroll.scrollToTop();
      });
      return;
    }
    if (this.#focus === "reviews") {
      this.#moveList(action, this.data.items.length, Math.max(1, this.#lastLayout.reviewHeight - 1), index => {
        this.#reviewIndex = index;
      });
    }
  }

  #moveCode(action: AnnotateAction): void {
    if (this.#pane.mode === "hunk") {
      if (action === "moveUp" || action === "pageUp" || action === "extendUp") this.#pane.jumpHunk(-1);
      else if (action === "moveDown" || action === "pageDown" || action === "extendDown") this.#pane.jumpHunk(1);
      else if (action === "toTop") this.#pane.seekHunk("first");
      else if (action === "toBottom") this.#pane.seekHunk("last");
      else if (action === "scrollLeft") this.#pane.scrollLeftBy(-8);
      else if (action === "scrollRight") this.#pane.scrollLeftBy(8);
      return;
    }
    const page = Math.max(1, this.#lastContentHeight - 2);
    if (action === "moveUp") this.#pane.moveCursor(-1, false);
    else if (action === "moveDown") this.#pane.moveCursor(1, false);
    else if (action === "extendUp") this.#pane.moveCursor(-1, true);
    else if (action === "extendDown") this.#pane.moveCursor(1, true);
    else if (action === "pageUp") this.#pane.moveCursor(-page, false);
    else if (action === "pageDown") this.#pane.moveCursor(page, false);
    else if (action === "toTop") this.#pane.cursorToEdge("start");
    else if (action === "toBottom") this.#pane.cursorToEdge("end");
    else if (action === "scrollLeft") this.#pane.scrollLeftBy(-8);
    else if (action === "scrollRight") this.#pane.scrollLeftBy(8);
  }

  /** Read-only panes (assistant text, the help sheet) move by scrolling. */
  #moveScroll(scroll: ScrollView, action: AnnotateAction): void {
    const page = Math.max(1, this.#lastContentHeight - 2);
    if (action === "moveUp") scroll.scroll(-1);
    else if (action === "moveDown") scroll.scroll(1);
    else if (action === "pageUp") scroll.scroll(-page);
    else if (action === "pageDown") scroll.scroll(page);
    else if (action === "toTop") scroll.scrollToTop();
    else if (action === "toBottom") scroll.scrollToBottom();
    else return;
    this.tui.requestRender();
  }

  #moveList(action: AnnotateAction, count: number, page: number, apply: (index: number) => void): void {
    if (count === 0) return;
    const current = this.#focus === "source" ? this.#sourceIndex : this.#reviewIndex;
    let next = current;
    if (action === "moveUp") next = current - 1;
    else if (action === "moveDown") next = current + 1;
    else if (action === "pageUp") next = current - page;
    else if (action === "pageDown") next = current + page;
    else if (action === "toTop") next = 0;
    else if (action === "toBottom") next = count - 1;
    else return;
    apply(Math.max(0, Math.min(next, count - 1)));
    this.tui.requestRender();
  }

  #moveCodeFile(delta: -1 | 1): void {
    if (this.#activeTab !== "code" || this.#revisions) return;
    this.#closeCard();
    const count = this.#sourceItems().length;
    if (count === 0) return;
    this.#sourceIndex = Math.max(0, Math.min(this.#sourceIndex + delta, count - 1));
    this.#setHoveredAnnotation(undefined);
    this.#syncPane();
    this.#setFocus("diff");
  }

  #activateSource(): void {
    this.#closeCard();
    const selected = this.#selectedSource();
    if (!selected) return;
    if (selected.kind === "commit") {
      this.#run(async () => {
        if (!await this.callbacks.selectCommit(selected.commit)) return;
        this.#revisions = false;
        this.#sourceIndex = 0;
        this.#setFocus("diff");
      });
      return;
    }
    if (selected.kind === "working-tree") {
      if (this.data.codeSource.kind === "working-tree") {
        this.#revisions = false;
        this.#sourceIndex = 0;
        this.#setFocus("diff");
        return;
      }
      this.#run(async () => {
        if (!await this.callbacks.selectWorkingTree()) return;
        this.#revisions = false;
        this.#sourceIndex = 0;
        this.#setFocus("diff");
      });
      return;
    }
    if (selected.kind === "file") {
      this.#syncPane();
      this.#setFocus("diff");
      return;
    }
    this.#assistantScroll.scrollToTop();
    this.#setFocus("diff");
  }

  /**
   * Point the draft at a new target without throwing away typed words; only an
   * edit draft is replaced, because its text belongs to another annotation.
   */
  #retargetDraft(target: DraftTarget): void {
    const previous = this.#draftTarget;
    const kept = previous !== undefined && previous.kind !== "edit" && this.#dock.editor.getText().trim().length > 0;
    if (previous?.kind === "edit") this.#dock.editor.setText("");
    this.#draftTarget = target;
    this.#setFocus("editor");
    if (kept) this.#notice("Draft kept and pointed at the new selection.", "info");
  }

  #beginDraft(): void {
    if (this.#activeTab === "assistant") {
      this.#beginAssistantDraft(undefined);
      return;
    }
    if (this.#revisions) {
      this.#notice("Open a revision with Enter before annotating it.", "warning");
      return;
    }
    // The card opens on a marked line, so `a` there means "mark this line
    // again" — a second annotation on content that already carries one.
    const cardRow = this.#cardRow;
    this.#syncPane();
    const selection = cardRow === undefined ? this.#pane.selection() : this.#pane.selectionAtRow(cardRow);
    if (!selection) {
      this.#notice("Select a changed line in the evidence pane first.", "warning");
      return;
    }
    this.#closeCard();
    this.#retargetDraft({ kind: "code", selection });
  }

  #beginAssistantDraft(selection: Pick<AssistantSelectionRange, "start" | "end"> | undefined): void {
    const selected = this.#selectedSource();
    if (selected?.kind !== "assistant") {
      this.#notice("Choose a message in the dock first.", "warning");
      return;
    }
    if (!selected.entry.annotationAllowed) {
      this.#notice("This assistant text is browse-only.", "warning");
      return;
    }
    this.#retargetDraft({
      kind: "assistant",
      entry: selected.entry,
      ...(selection === undefined ? {} : { selection }),
    });
  }

  #beginPreciseDraft(): void {
    if (this.#activeTab === "assistant") {
      const selected = this.#selectedSource();
      if (selected?.kind !== "assistant") {
        this.#notice("Choose a message in the dock first.", "warning");
        return;
      }
      if (!selected.entry.annotationAllowed) {
        this.#notice("This assistant text is browse-only.", "warning");
        return;
      }
      this.#run(async () => {
        const range = await this.callbacks.selectAssistantPrecise(selected.entry);
        if (!range) return;
        this.#beginAssistantDraft({ start: range.start, end: range.end });
      });
      return;
    }
    this.#syncPane();
    const file = this.#selectedCodeFile();
    const lines = this.#pane.hunkLines();
    if (!file || lines.length === 0) {
      this.#notice("Select a changed line in the evidence pane first.", "warning");
      return;
    }
    this.#run(async () => {
      const selection = await this.callbacks.selectCodePrecise(file.path, lines);
      if (!selection) return;
      this.#retargetDraft({ kind: "code", selection });
    });
  }

  #editFocusedAnnotation(): void {
    const item = this.#focusedAnnotation();
    if (!item) {
      this.#notice("Choose an annotation to edit it.", "warning");
      return;
    }
    if (item.status !== "pending") {
      this.#notice("Only pending annotations can be edited.", "warning");
      return;
    }
    this.#closeCard();
    this.#draftTarget = { kind: "edit", item };
    this.#dock.editor.setText(item.body);
    this.#setFocus("editor");
  }

  /** Jump the evidence to the queued annotation so it can be read and edited in place. */
  #revealSelectedAnnotation(): void {
    const item = this.data.items[this.#reviewIndex];
    if (!item) {
      this.#setFocus("reviews");
      return;
    }
    this.#revealAnnotation(item);
    this.tui.requestRender();
  }

  #revealAnnotation(item: ReviewItem): void {
    const anchor = item.anchor;
    if (anchor.kind === "assistant") {
      const index = this.data.assistantEntries.findIndex(entry => entry.id === anchor.entryId);
      if (index < 0) {
        this.#notice("That assistant message is not in this session anymore.", "warning");
        this.#setFocus("reviews");
        return;
      }
      this.#activeTab = "assistant";
      this.#revisions = false;
      this.#sourceIndex = index;
      this.#assistantEntryId = undefined;
      this.#assistantScroll.scrollToTop();
      // Keep the queue focused so e/d act on the item the reader just opened.
      this.#setFocus("reviews");
      return;
    }
    this.#activeTab = "code";
    this.#revisions = false;
    if (anchor.commitOid !== this.data.codeSnapshot?.commitOid) {
      this.#notice("This annotation is on another revision. Press H to open it.", "warning");
      this.#setFocus("reviews");
      return;
    }
    const files = this.data.codeSnapshot?.files ?? [];
    const index = files.findIndex(file => file.path === anchor.filePath);
    if (index < 0) {
      this.#notice("The annotated file is not in the current changes.", "warning");
      this.#setFocus("reviews");
      return;
    }
    this.#sourceIndex = index;
    this.#syncPane();
    const paneRow = this.#pane.revealItem(item);
    if (paneRow === undefined) {
      this.#notice("Could not find that line in the current view.", "warning");
      this.#setFocus("diff");
      return;
    }
    this.#openCard(paneRow);
    const items = this.#pane.annotationsAtRow(paneRow);
    const cardIndex = items.findIndex(candidate => candidate.id === item.id);
    if (cardIndex >= 0) this.#cardIndex = cardIndex;
  }

  /** The annotation the queue keys act on: the card's, the hovered, or the selected. */
  #focusedAnnotation(): ReviewItem | undefined {
    if (this.#cardRow !== undefined) return this.#cardItems()[this.#cardIndex];
    const hovered = this.#hoveredAnnotation();
    return hovered ?? (this.#focus === "reviews" ? this.data.items[this.#reviewIndex] : undefined);
  }

  #deleteFocusedAnnotation(): void {
    const item = this.#cardRow !== undefined ? this.#cardItems()[this.#cardIndex] : this.data.items[this.#reviewIndex];
    if (!item) return;
    if (this.#cardRow !== undefined && this.#cardItems().length <= 1) this.#closeCard();
    this.#run(() => this.callbacks.deleteItem(item));
  }

  #discardDraft(): void {
    if (this.#draftTarget === undefined) return;
    this.#draftTarget = undefined;
    this.#dock.editor.setText("");
    this.#setFocus(this.#focus === "editor" ? "source" : this.#focus);
    this.#notice("Draft discarded.", "info");
  }

  /** Esc leaves the editor; an empty draft has nothing to keep, so its target goes too. */
  #leaveEditor(): void {
    if (this.#dock.editor.getText().trim().length === 0) {
      this.#draftTarget = undefined;
      this.#dock.editor.setText("");
    }
    this.#setFocus("source");
  }

  #submitDraft(text: string): void {
    const target = this.#draftTarget;
    if (!target) {
      this.#dock.editor.setText(text);
      this.#notice("Select a source before saving an annotation.", "warning");
      return;
    }
    if (!text.trim()) {
      this.#dock.editor.setText(text);
      this.#notice("An annotation needs a comment.", "warning");
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
        this.#dock.editor.setText(text);
        return;
      }
      if (target.kind === "edit") {
        const index = this.data.items.findIndex(item => item.id === target.item.id);
        if (index >= 0) this.#reviewIndex = index;
      }
      this.#draftTarget = undefined;
      this.#dock.editor.setText("");
      this.#setFocus(target.kind === "edit" ? "reviews" : target.kind === "code" ? "diff" : "source");
    });
  }

  #draftTargetLabel(maxWidth: number): string {
    const target = this.#draftTarget;
    if (!target) return "press a to start";
    if (target.kind === "edit") {
      const prefix = "edit ";
      return maxWidth <= prefix.length + 4
        ? reviewItemLocation(target.item, maxWidth)
        : `${prefix}${reviewItemLocation(target.item, maxWidth - prefix.length)}`;
    }
    if (target.kind === "code") {
      const prefix = "code ";
      // The toolbar already names the open revision; repeating its oid here
      // costs the path characters the reader actually needs.
      const { commitOid, ...current } = target.selection;
      const selection = commitOid === this.data.codeSnapshot?.commitOid ? current : target.selection;
      return maxWidth <= prefix.length + 6
        ? formatCodeSelectionTarget(selection, maxWidth)
        : `${prefix}${formatCodeSelectionTarget(selection, maxWidth - prefix.length)}`;
    }
    const prefix = "assistant ";
    return maxWidth <= prefix.length + 8
      ? formatAssistantTarget(target.entry, target.selection, maxWidth)
      : `${prefix}${formatAssistantTarget(target.entry, target.selection, maxWidth - prefix.length)}`;
  }

  #handleMouse(data: string): boolean {
    if (!data.startsWith("\x1b[<")) return false;
    return routeSgrMouseInput(data, event => {
      const gesture = this.#pointer.gesture(event);
      if (gesture.kind === "release") {
        this.#dragging = false;
        return true;
      }
      if (event.row < CHROME_ROWS) return this.#mouseChrome(event, gesture);
      const contentRow = event.row - CHROME_ROWS;
      const dockStart = this.#lastLayout.leftWidth + this.#lastLayout.dividerWidth;
      const inDock = !this.#dockCollapsed && event.col >= dockStart;
      if (inDock) return this.#mouseDock(contentRow, event.col - dockStart, gesture);
      if (this.#helpOpen) return this.#mouseScrollOnly(this.#helpScroll, gesture);
      if (this.#cardRow !== undefined && this.#mouseCard(contentRow, event.col, gesture)) return true;
      if (this.#activeTab === "code") return this.#mouseEvidence(contentRow, event.col, gesture);
      if (gesture.kind === "wheel") return this.#mouseScrollOnly(this.#assistantScroll, gesture);
      if (gesture.kind === "press") this.#setFocus("diff");
      return true;
    });
  }

  #mouseChrome(event: SgrMouseEvent, gesture: PointerGesture): boolean {
    this.#setHoveredAnnotation(undefined);
    if (gesture.kind === "press" && gesture.button === "left") {
      const hits = event.row === 0 ? this.#headerHits : this.#toolbarHits;
      hits.find(hit => event.col >= hit.from && event.col < hit.to)?.action();
    }
    return true;
  }

  #mouseDock(contentRow: number, column: number, gesture: PointerGesture): boolean {
    this.#setHoveredAnnotation(undefined);
    if (gesture.kind === "wheel") {
      this.#dock.scrollAt(contentRow, gesture.delta * 3);
      this.tui.requestRender();
      return true;
    }
    if (gesture.kind === "press" && gesture.button === "left") {
      this.#clickDock(contentRow, column);
      this.tui.requestRender();
    }
    return true;
  }

  #mouseScrollOnly(scroll: ScrollView, gesture: PointerGesture): boolean {
    this.#setHoveredAnnotation(undefined);
    if (gesture.kind === "wheel") {
      scroll.scroll(gesture.delta * 3);
      this.tui.requestRender();
    }
    return true;
  }

  /** Route a mouse event that fell inside the open card; false = not on the card. */
  #mouseCard(contentRow: number, column: number, gesture: PointerGesture): boolean {
    const cardRow = contentRow - this.#cardTop;
    if (cardRow < 0 || cardRow >= this.#cardHeight) return false;
    if (gesture.kind === "wheel") {
      this.#card.scroll(gesture.delta * 3);
      this.tui.requestRender();
      return true;
    }
    if (gesture.kind !== "press" || gesture.button !== "left") return true;
    const hit = this.#cardHits.find(
      candidate => candidate.row === cardRow && column >= candidate.from && column < candidate.to,
    );
    if (hit) {
      hit.action();
      return true;
    }
    const index = this.#card.itemIndexAt(cardRow);
    if (index !== undefined) {
      this.#cardIndex = index;
      this.tui.requestRender();
    }
    return true;
  }

  #mouseEvidence(contentRow: number, column: number, gesture: PointerGesture): boolean {
    if (gesture.kind === "wheel") {
      this.#pane.scrollBy(gesture.delta * 3);
      this.#syncEvidenceHover(contentRow);
      this.tui.requestRender();
      return true;
    }
    if (gesture.kind === "hover") {
      this.#syncEvidenceHover(contentRow);
      return true;
    }
    if (gesture.kind === "drag") {
      if (gesture.button !== "left" || !this.#dragging) return true;
      this.#pane.clickAt(Math.max(0, column - ANNOTATION_RAIL_WIDTH), contentRow, true);
      this.#syncEvidenceHover(contentRow);
      this.tui.requestRender();
      return true;
    }
    if (gesture.kind !== "press" || gesture.button !== "left") return true;
    // A mark carries the only openable thing on the row; clicking it, or
    // clicking a marked line twice, opens what is already written there.
    const marked = this.#pane.annotationsAtRow(contentRow).length > 0;
    const onRail = column < ANNOTATION_RAIL_WIDTH;
    if (marked && (onRail || gesture.clicks >= 2)) {
      this.#openCard(contentRow);
      return true;
    }
    this.#setFocus("diff");
    this.#pane.clickAt(Math.max(0, column - ANNOTATION_RAIL_WIDTH), contentRow, false);
    this.#dragging = true;
    // A double click on a bare changed line is the fast path to annotating it.
    if (!marked && gesture.clicks >= 2) {
      this.#beginDraft();
      this.#pointer.reset();
      return true;
    }
    this.#syncEvidenceHover(contentRow);
    this.tui.requestRender();
    return true;
  }

  /** Point the header and the rail highlight at the annotation under the pointer. */
  #syncEvidenceHover(contentRow: number): void {
    const annotation = this.#pane.annotationsAtRow(contentRow)[0];
    this.#setHoveredAnnotation(annotation);
    if (this.#pane.setHoverRow(annotation ? contentRow : undefined)) this.tui.requestRender();
  }

  #clickDock(row: number, column: number): void {
    const hit = this.#dock.hitAt(row, column);
    if (hit) {
      hit();
      return;
    }
    const panel = this.#dock.panelAt(row);
    if (panel === "sources") {
      const index = this.#dock.sourceIndexAt(row, this.#sourceItems().length);
      if (index === undefined) {
        this.#setFocus("source");
        return;
      }
      this.#sourceIndex = index;
      this.#activateSource();
      return;
    }
    if (panel === "draft") {
      this.#setFocus("editor");
      return;
    }
    if (panel === "reviews") {
      const index = this.#dock.queueIndexAt(row, this.data.items.length);
      if (index === undefined) {
        this.#setFocus("reviews");
        return;
      }
      this.#reviewIndex = index;
      this.#revealSelectedAnnotation();
    }
  }

  #run(operation: () => Promise<void>): void {
    if (this.data.busy) return;
    this.data.busy = true;
    this.data.notice = undefined;
    this.tui.requestRender();
    void operation()
      .catch(error => {
        this.data.notice = createNotice(error instanceof Error ? error.message : String(error), "error");
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
