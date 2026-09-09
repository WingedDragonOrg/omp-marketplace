import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
  Editor,
  matchesKey,
  ScrollView,
  TabBar,
  type Component,
  type TabBarTheme,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type {
  AssistantTextEntry,
  CodeSnapshot,
  DiffLine,
  ReviewItem,
} from "./model";
import type { GitCommit } from "./git";
import type { AssistantSelectionRange } from "./assistant-selection";

export type AnnotateTab = "code" | "assistant";
export type AnnotateFocus = "source" | "editor" | "reviews";

export interface CodeSelection {
  filePath: string;
  line: DiffLine;
  commitOid?: string;
}

export type CodeSource =
  | { kind: "working-tree" }
  | { kind: "commit-list" }
  | { kind: "commit"; commit: GitCommit };

export interface CommitSourceSelection {
  kind: "commit";
  commit: GitCommit;
}

export interface BrowseSelection {
  filePath: string;
  label: "binary" | "no selectable patch lines";
  browseOnly: true;
}

export type CodeSourceItem = CodeSelection | BrowseSelection | CommitSourceSelection;

export interface AnnotateViewData {
  codeSnapshot: CodeSnapshot | undefined;
  codeWorkingSnapshot: CodeSnapshot | undefined;
  codeError: string | undefined;
  codeCommits: GitCommit[];
  codeSource: CodeSource;
  codeHistoryError: string | undefined;
  codeSnapshots: ReadonlyMap<string, CodeSnapshot>;
  assistantEntries: AssistantTextEntry[];
  items: ReviewItem[];
  notice: { message: string; level: "info" | "warning" | "error" } | undefined;
  busy: boolean;
}

export interface AnnotateViewCallbacks {
  addCode(selection: CodeSelection, body: string): Promise<boolean>;
  addAssistant(
    entry: AssistantTextEntry,
    body: string,
    selection?: Pick<AssistantSelectionRange, "start" | "end">,
  ): Promise<boolean>;
  selectAssistantPrecise(entry: AssistantTextEntry): Promise<AssistantSelectionRange | undefined>;
  selectCommit(commit: GitCommit): Promise<boolean>;
  selectWorkingTree(): Promise<boolean>;
  deleteItem(item: ReviewItem): Promise<void>;
  refresh(): Promise<void>;
  send(): Promise<void>;
}

export interface AnnotateLayout {
  leftWidth: number;
  dividerWidth: number;
  rightWidth: number;
  bodyHeight: number;
  sourceHeight: number;
  previewHeight: number;
  draftHeight: number;
  reviewHeight: number;
}

const SOURCE_PANEL_CHROME = 2;
const REVIEW_PANEL_CHROME = 4;
const MAX_DRAFT_HEIGHT = 8;
const OVERLAY_MARGIN = 1;

/**
 * Allocate the live overlay to a source column and an annotation column.
 * The source column is intentionally wider because paths, diffs, and assistant
 * messages are the primary navigation surface.
 */
export function resolveAnnotateLayout(width: number, height: number): AnnotateLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
  const dividerWidth = safeWidth >= 3 ? 1 : 0;
  const usableWidth = Math.max(1, safeWidth - dividerWidth);
  let leftWidth = Math.max(1, Math.floor(usableWidth * 0.58));
  let rightWidth = Math.max(0, usableWidth - leftWidth);
  if (rightWidth === 0 && usableWidth > 1) {
    leftWidth = usableWidth - 1;
    rightWidth = 1;
  }

  const bodyHeight = Number.isFinite(height) ? Math.max(1, Math.trunc(height)) : 1;
  const leftContentHeight = Math.max(0, bodyHeight - SOURCE_PANEL_CHROME);
  const sourceHeight = leftContentHeight === 0 ? 0 : Math.max(1, Math.floor(leftContentHeight * 0.55));
  const previewHeight = Math.max(0, leftContentHeight - sourceHeight);
  const compact = bodyHeight < 8;
  const maxDraftHeight = compact
    ? Math.max(0, bodyHeight - REVIEW_PANEL_CHROME - 1)
    : Math.max(3, bodyHeight - REVIEW_PANEL_CHROME - 1);
  const draftHeight = compact
    ? Math.max(0, Math.min(MAX_DRAFT_HEIGHT, Math.floor(bodyHeight * 0.3), maxDraftHeight))
    : Math.max(3, Math.min(MAX_DRAFT_HEIGHT, Math.floor(bodyHeight * 0.3), maxDraftHeight));
  const reviewHeight = compact
    ? Math.max(0, bodyHeight - REVIEW_PANEL_CHROME - draftHeight)
    : Math.max(1, bodyHeight - REVIEW_PANEL_CHROME - draftHeight);

  return {
    leftWidth,
    dividerWidth,
    rightWidth,
    bodyHeight,
    sourceHeight,
    previewHeight,
    draftHeight,
    reviewHeight,
  };
}

function oneLine(value: string, maxLength = 160): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
    if (char === "\r" || char === "\n" || char === "\t") return " ";
    return `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`;
  });
  const normalized = sanitized.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function previewLines(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const rows: string[] = [];
  for (const line of normalized.split("\n")) {
    const wrapped = wrapTextWithAnsi(line, safeWidth);
    if (wrapped.length === 0) rows.push("");
    else rows.push(...wrapped);
  }
  return rows.length > 0 ? rows : [""];
}

function padColumn(value: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const clipped = truncateToWidth(value, safeWidth, "");
  return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

function composeColumns(
  leftRows: readonly string[],
  rightRows: readonly string[],
  leftWidth: number,
  divider: string,
  rightWidth: number,
): string[] {
  const rowCount = Math.max(leftRows.length, rightRows.length);
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(
      `${padColumn(leftRows[index] ?? "", leftWidth)}${divider}${padColumn(rightRows[index] ?? "", rightWidth)}`,
    );
  }
  return rows;
}

function statusLabel(item: ReviewItem): string {
  if (item.status === "stale") return `stale: ${item.staleReason ?? "reference changed"}`;
  return item.status;
}

function statusColor(item: ReviewItem): "accent" | "success" | "warning" {
  if (item.status === "sent") return "success";
  if (item.status === "stale") return "warning";
  return "accent";
}

function codeLineLabel(line: DiffLine): string {
  const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
  const number = line.newLine ?? line.oldLine ?? 0;
  return `${marker}${number}`;
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
          ...(snapshot.commitOid === undefined ? {} : { commitOid: snapshot.commitOid }),
        });
      }
    }
  }
  return selections;
}

type SourceItem = CodeSourceItem | AssistantTextEntry;
function isCommitSourceSelection(item: SourceItem | undefined): item is CommitSourceSelection {
  return item !== undefined && "kind" in item && item.kind === "commit";
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

function tabTheme(theme: Theme): TabBarTheme {
  return {
    label: text => theme.fg("accent", theme.bold(text)),
    activeTab: text => theme.fg("accent", theme.bold(text)),
    inactiveTab: text => theme.fg("muted", text),
    hint: text => theme.fg("dim", text),
  };
}

type DraftTarget =
  | { kind: "code"; selection: CodeSelection }
  | {
      kind: "assistant";
      entry: AssistantTextEntry;
      selection?: Pick<AssistantSelectionRange, "start" | "end">;
    };

function targetForSource(item: SourceItem | undefined): DraftTarget | undefined {
  if (!item || "browseOnly" in item || isCommitSourceSelection(item)) return undefined;
  if ("line" in item) return { kind: "code", selection: item };
  return item.annotationAllowed ? { kind: "assistant", entry: item } : undefined;
}

class AnnotateView implements Component {
  #activeTab: AnnotateTab = "code";
  #focus: AnnotateFocus = "source";
  #sourceIndex = 0;
  #reviewIndex = 0;
  #sourceScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #previewScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #reviewScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #tabBar: TabBar;
  #draftEditor: Editor;
  #draftTarget: DraftTarget | undefined;

  /** The overlay itself receives input; this flag lets the nested editor own the cursor. */
  focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly data: AnnotateViewData,
    private readonly callbacks: AnnotateViewCallbacks,
    private readonly done: () => void,
  ) {
    this.#tabBar = new TabBar(
      "",
      [
        { id: "code", label: "Code" },
        { id: "assistant", label: "Assistant" },
      ],
      tabTheme(theme),
    );
    this.#tabBar.showHint = false;
    this.#tabBar.onTabChange = tab => {
      if (tab.id === "code" || tab.id === "assistant") this.#activeTab = tab.id;
      this.#focus = "source";
      this.#sourceIndex = 0;
      this.#previewScroll.scrollToTop();
      this.tui.requestRender();
    };

    this.#draftEditor = new Editor(getEditorTheme());
    this.#draftEditor.setPromptGutter("> ");
    this.#draftEditor.setScrollbarVisible(true);
    this.#draftEditor.onSubmit = text => this.#submitDraft(text);
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    lines.push(...this.#tabBar.render(safeWidth));
    lines.push(
      this.theme.fg(
        "dim",
        "↑/↓ select  a/Enter draft  p precise  Space lists  h commits  w current  s send  r refresh  Tab view  Esc close",
      ),
    );
    if (this.data.busy) lines.push(this.theme.fg("warning", "Working…"));
    if (this.data.notice) {
      const style = this.data.notice.level === "error" ? "error" : this.data.notice.level === "warning" ? "warning" : "muted";
      lines.push(this.theme.fg(style, oneLine(this.data.notice.message)));
    }

    const terminalRows = Number.isFinite(this.tui.terminal.rows) ? Math.trunc(this.tui.terminal.rows) : 24;
    const availableRows = Math.max(1, terminalRows - OVERLAY_MARGIN * 2);
    const layout = resolveAnnotateLayout(safeWidth, Math.max(1, availableRows - lines.length));
    this.#normalizeIndexes();

    const sourceRows = this.#sourceRows();
    this.#sourceScroll.setLines(sourceRows);
    this.#sourceScroll.setHeight(layout.sourceHeight);
    this.#sourceScroll.setScrollOffset(this.#scrollOffset(this.#sourceIndex, sourceRows.length, layout.sourceHeight));

    const previewRows = this.#sourcePreviewRows(Math.max(1, layout.leftWidth - 1));
    this.#previewScroll.setLines(previewRows);
    this.#previewScroll.setHeight(layout.previewHeight);

    const leftRows = [
      this.#panelHeading(this.#activeTab === "code" ? `Code source · ${this.#codeSourceLabel()}` : "Assistant source"),
      ...this.#sourceScroll.render(layout.leftWidth),
      this.#panelHeading("Preview"),
      ...this.#previewScroll.render(layout.leftWidth),
    ].slice(0, layout.bodyHeight);

    this.#draftEditor.setMaxHeight(layout.draftHeight);
    this.#draftEditor.focused = this.focused && this.#focus === "editor";
    this.#draftEditor.setUseTerminalCursor(false);
    const reviewRows = this.#reviewRows();
    this.#reviewScroll.setLines(reviewRows);
    this.#reviewScroll.setHeight(layout.reviewHeight);
    this.#reviewScroll.setScrollOffset(this.#scrollOffset(this.#reviewIndex, reviewRows.length, layout.reviewHeight));
    const renderedReviewRows = this.#reviewScroll.render(Math.max(1, layout.rightWidth));
    const draftRows = this.#draftEditor.render(Math.max(1, layout.rightWidth));

    const rightRows =
      layout.bodyHeight < 8
        ? this.#compactRightRows(layout, draftRows, renderedReviewRows)
        : [
            this.#panelHeading(this.#focus === "editor" ? "Annotation draft · editing" : "Annotation draft"),
            this.theme.fg(this.#draftTarget ? "accent" : "dim", `Target: ${oneLine(this.#draftTargetLabel())}`),
            ...draftRows,
            this.theme.fg("dim", "Enter add · Alt+Enter newline · Tab source · Shift+Tab history"),
            this.#panelHeading(`Annotations (${this.data.items.length})`),
            ...renderedReviewRows,
          ];

    const divider = layout.dividerWidth > 0 ? this.theme.fg("borderMuted", "│") : "";
    lines.push(...composeColumns(leftRows, rightRows, layout.leftWidth, divider, layout.rightWidth));
    return lines;
  }

  handleInput(data: string): void {
    if (this.#focus === "editor") {
      if (matchesKey(data, "tab")) {
        this.#focus = "source";
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "shift+tab")) {
        this.#focus = "reviews";
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+space")) {
        this.#focus = "reviews";
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "escape")) {
        this.done();
        return;
      }
      this.#draftEditor.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.#tabBar.handleInput(data)) return;
    if (this.#focus === "source" && this.#activeTab === "code") {
      if (matchesKey(data, "h")) {
        this.#showCommitList();
        return;
      }
      if (matchesKey(data, "w")) {
        if (this.data.codeSource.kind !== "working-tree") {
          this.#run(async () => {
            if (await this.callbacks.selectWorkingTree()) {
              this.#sourceIndex = 0;
              this.#previewScroll.scrollToTop();
            }
          });
        }
        return;
      }
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "ctrl+space")) {
      this.#focus = this.#focus === "source" ? "editor" : "source";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      this.#focus = this.#focus === "source" ? "reviews" : "source";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      if (this.#focus === "source") this.#moveSource(delta);
      else this.#moveReview(delta);
      this.tui.requestRender();
      return;
    }
    if (
      this.#focus === "source" &&
      (matchesKey(data, "shift+up") ||
        matchesKey(data, "shift+down") ||
        matchesKey(data, "pageUp") ||
        matchesKey(data, "pageDown"))
    ) {
      if (this.#previewScroll.handleScrollKey(data)) this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "p")) {
      if (this.#focus === "source" && this.#activeTab === "assistant") {
        const selected = this.#sourceItems()[this.#sourceIndex];
        if (selected && "text" in selected) {
          if (!selected.annotationAllowed) {
            this.data.notice = { message: "This assistant text is browse-only.", level: "warning" };
            this.tui.requestRender();
          } else {
            this.#run(async () => {
              const selection = await this.callbacks.selectAssistantPrecise(selected);
              if (!selection) return;
              this.#draftTarget = { kind: "assistant", entry: selected, selection };
              this.#draftEditor.setText("");
              this.#focus = "editor";
            });
          }
        }
      }
      return;
    }
    if (matchesKey(data, "a") || matchesKey(data, "enter")) {
      if (this.#focus === "source") this.#activateSource();
      return;
    }
    if (matchesKey(data, "d")) {
      const selected = this.data.items[this.#reviewIndex];
      if (this.#focus === "reviews" && selected) this.#run(() => this.callbacks.deleteItem(selected));
      return;
    }
    if (matchesKey(data, "s")) {
      this.#run(() => this.callbacks.send());
      return;
    }
    if (matchesKey(data, "r")) {
      this.#run(() => this.callbacks.refresh());
    }
  }

  invalidate(): void {
    this.#sourceScroll.invalidate();
    this.#previewScroll.invalidate();
    this.#reviewScroll.invalidate();
    this.#draftEditor.invalidate();
  }

  #sourceItems(): SourceItem[] {
    return this.#activeTab === "code"
      ? codeSourceItems(this.data.codeSnapshot, this.data.codeSource, this.data.codeCommits)
      : this.data.assistantEntries;
  }

  #normalizeIndexes(): void {
    const sourceCount = this.#sourceItems().length;
    this.#sourceIndex = sourceCount === 0 ? 0 : Math.min(this.#sourceIndex, sourceCount - 1);
    this.#reviewIndex = this.data.items.length === 0 ? 0 : Math.min(this.#reviewIndex, this.data.items.length - 1);
  }

  #selectedSource(): SourceItem | undefined {
    return this.#sourceItems()[this.#sourceIndex];
  }

  #sourceRows(): string[] {
    if (this.#activeTab === "code") {
      if (this.data.codeSource.kind === "commit-list") {
        if (this.data.codeCommits.length === 0) {
          return [
            this.data.codeHistoryError
              ? `Commit history unavailable: ${oneLine(this.data.codeHistoryError)}`
              : "No recent commits.",
          ];
        }
        return this.data.codeCommits.map((commit, index) => {
          const pointer = this.#focus === "source" && index === this.#sourceIndex ? this.theme.fg("accent", "› ") : "  ";
          return `${pointer}${this.theme.fg("accent", commit.shortOid)} ${this.theme.fg("muted", commit.timestamp.slice(0, 10))} ${oneLine(commit.subject)}`;
        });
      }
      if (!this.data.codeSnapshot) {
        return [this.data.codeError ? `Code unavailable: ${oneLine(this.data.codeError)}` : "Code source unavailable."];
      }
      const items = codeSourceItems(this.data.codeSnapshot, this.data.codeSource, this.data.codeCommits);
      if (items.length === 0) {
        return this.data.codeSource.kind === "commit"
          ? ["No changed lines in this commit.", "Press h to choose another recent commit."]
          : ["No staged or unstaged Git changes.", "Press h to browse recent commits."];
      }
      return items.map((item, index) => {
        const pointer = this.#focus === "source" && index === this.#sourceIndex ? this.theme.fg("accent", "› ") : "  ";
        if (isCommitSourceSelection(item)) {
          return `${pointer}${this.theme.fg("accent", item.commit.shortOid)} ${oneLine(item.commit.subject)}`;
        }
        if ("browseOnly" in item) return `${pointer}[${item.label}] ${oneLine(item.filePath)} (browse-only)`;
        const color = item.line.kind === "addition" ? "success" : item.line.kind === "deletion" ? "error" : "muted";
        return `${pointer}${this.theme.fg(color, codeLineLabel(item.line))} ${oneLine(item.filePath)} ${oneLine(item.line.content)}`;
      });
    }

    if (this.data.assistantEntries.length === 0) return ["No visible assistant text in the current branch."];
    return this.data.assistantEntries.map((entry, index) => {
      const pointer = this.#focus === "source" && index === this.#sourceIndex ? this.theme.fg("accent", "› ") : "  ";
      const protection = entry.annotationAllowed ? "" : " [browse-only]";
      return `${pointer}[${oneLine(entry.id)}] ${oneLine(entry.text)}${protection}`;
    });
  }

  #sourcePreviewRows(width: number): string[] {
    const selected = this.#selectedSource();
    if (!selected) {
      return this.data.codeSource.kind === "commit-list" && this.#activeTab === "code"
        ? [this.theme.fg("dim", "Select a recent commit and press Enter to inspect it.")]
        : [this.theme.fg("dim", "Select a source row to preview it here.")];
    }
    if (isCommitSourceSelection(selected)) {
      return [
        this.theme.fg("accent", this.theme.bold(`Commit ${oneLine(selected.commit.shortOid)}`)),
        this.theme.fg("muted", oneLine(selected.commit.timestamp)),
        ...previewLines(selected.commit.subject, width),
        this.theme.fg("dim", "Press Enter to inspect changed lines."),
      ];
    }
    if ("browseOnly" in selected) {
      return [
        this.theme.fg("muted", `${oneLine(selected.filePath)} · ${selected.label}`),
        this.theme.fg("dim", "This source can be browsed but does not have a selectable annotation anchor."),
      ];
    }
    if ("line" in selected) {
      const marker = selected.line.kind === "addition" ? "+" : selected.line.kind === "deletion" ? "-" : " ";
      const color = selected.line.kind === "addition" ? "success" : selected.line.kind === "deletion" ? "error" : "muted";
      const revision = selected.commitOid === undefined ? "" : `Commit ${selected.commitOid.slice(0, 7)} · `;
      return [
        this.theme.fg("accent", this.theme.bold(`${revision}${oneLine(selected.filePath)}:${codeLineLabel(selected.line)}`)),
        ...previewLines(`${marker} ${selected.line.content}`, Math.max(1, width)).map(row => this.theme.fg(color, row)),
      ];
    }

    const protection = selected.annotationAllowed ? "" : " · browse-only";
    return [
      this.theme.fg("accent", this.theme.bold(`Assistant ${oneLine(selected.id)}${protection}`)),
      ...previewLines(selected.text, width),
    ];
  }

  #draftTargetLabel(): string {
    const target = this.#draftTarget;
    if (!target) return "Select a source row and press a";
    if (target.kind === "code") {
      const revision = target.selection.commitOid === undefined ? "" : `commit ${target.selection.commitOid.slice(0, 7)} · `;
      return `Code · ${revision}${target.selection.filePath}:${codeLineLabel(target.selection.line)}`;
    }
    const range = target.selection ? `chars ${target.selection.start}–${target.selection.end}` : "whole message";
    return `Assistant · ${target.entry.id} · ${range}`;
  }

  #reviewRows(): string[] {
    if (this.data.items.length === 0) return ["No annotations yet. Select a source row and press a."];
    return this.data.items.map((item, index) => {
      const pointer = this.#focus === "reviews" && index === this.#reviewIndex ? this.theme.fg("accent", "› ") : "  ";
      const location =
        item.anchor.kind === "code"
          ? `${item.anchor.commitOid === undefined ? "" : `commit ${item.anchor.commitOid.slice(0, 7)} · `}${oneLine(item.anchor.filePath)}:${item.anchor.newStart || item.anchor.oldStart}`
          : `entry ${oneLine(item.anchor.entryId)}:${item.anchor.start}–${item.anchor.end}`;
      const status = this.theme.fg(statusColor(item), statusLabel(item));
      return `${pointer}${this.theme.fg("muted", item.source)} ${status} ${oneLine(location)} — ${oneLine(item.body, 120)}`;
    });
  }
  #codeSourceLabel(): string {
    if (this.data.codeSource.kind === "working-tree") return "Working tree";
    if (this.data.codeSource.kind === "commit-list") return "Recent commits";
    return `Commit ${oneLine(this.data.codeSource.commit.shortOid)} · ${oneLine(this.data.codeSource.commit.subject, 80)}`;
  }

  #showCommitList(): void {
    if (this.data.codeSource.kind === "commit-list") return;
    this.data.codeSource = { kind: "commit-list" };
    this.#sourceIndex = 0;
    this.#previewScroll.scrollToTop();
    this.data.notice = undefined;
    this.tui.requestRender();
  }

  #activateSource(): void {
    const selected = this.#selectedSource();
    if (this.#activeTab === "code" && isCommitSourceSelection(selected)) {
      this.#run(async () => {
        if (!await this.callbacks.selectCommit(selected.commit)) return;
        this.#sourceIndex = 0;
        this.#previewScroll.scrollToTop();
      });
      return;
    }
    this.#beginDraft();
  }


  #panelHeading(value: string): string {
    return this.theme.fg("accent", this.theme.bold(value));
  }

  #compactRightRows(layout: AnnotateLayout, draftRows: readonly string[], reviewRows: readonly string[]): string[] {
    const rows: string[] = [this.#panelHeading(this.#focus === "editor" ? "Annotation draft · editing" : "Annotation draft")];
    if (layout.bodyHeight >= 5) {
      rows.push(this.theme.fg(this.#draftTarget ? "accent" : "dim", `Target: ${oneLine(this.#draftTargetLabel())}`));
    }
    const reviewBudget =
      layout.bodyHeight >= 6
        ? Math.min(layout.reviewHeight, Math.max(0, layout.bodyHeight - rows.length - draftRows.length))
        : 0;
    const draftBudget = Math.max(0, layout.bodyHeight - rows.length - reviewBudget);
    rows.push(...draftRows.slice(0, draftBudget));
    rows.push(...reviewRows.slice(0, reviewBudget));
    return rows.slice(0, layout.bodyHeight);
  }

  #moveSource(delta: -1 | 1): void {
    const count = this.#sourceItems().length;
    if (count === 0) return;
    this.#sourceIndex = Math.max(0, Math.min(this.#sourceIndex + delta, count - 1));
    this.#previewScroll.scrollToTop();
  }

  #moveReview(delta: -1 | 1): void {
    const count = this.data.items.length;
    if (count === 0) return;
    this.#reviewIndex = Math.max(0, Math.min(this.#reviewIndex + delta, count - 1));
  }

  #scrollOffset(index: number, rowCount: number, height: number): number {
    if (rowCount <= height) return 0;
    return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
  }

  #beginDraft(): void {
    const selected = this.#selectedSource();
    const target = targetForSource(selected);
    if (!target) {
      const message =
        selected && "text" in selected && !selected.annotationAllowed
          ? "This assistant text is browse-only."
          : selected && "browseOnly" in selected
            ? "This source is browse-only."
            : isCommitSourceSelection(selected)
              ? "Press Enter to open the commit before annotating a line."
              : "Select an annotatable source row first.";
      this.data.notice = { message, level: "warning" };
      this.tui.requestRender();
      return;
    }
    this.#draftTarget = target;
    this.#draftEditor.setText("");
    this.#focus = "editor";
    this.data.notice = undefined;
    this.tui.requestRender();
  }

  #submitDraft(text: string): void {
    const target = this.#draftTarget;
    if (!target) {
      this.data.notice = { message: "Select a source row and press a before writing an annotation.", level: "warning" };
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
      const added =
        target.kind === "code"
          ? await this.callbacks.addCode(target.selection, text)
          : await this.callbacks.addAssistant(target.entry, text, target.selection);
      if (!added) {
        this.#draftEditor.setText(text);
        return;
      }
      this.#draftTarget = undefined;
      this.#focus = "source";
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

export function renderPreviewLine(value: string, width: number): string {
  return truncateToWidth(oneLine(value), Math.max(1, width));
}
