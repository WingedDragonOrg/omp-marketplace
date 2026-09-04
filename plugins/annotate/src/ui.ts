import type { Theme } from "@oh-my-pi/pi-coding-agent";
import {
  matchesKey,
  ScrollView,
  TabBar,
  type Component,
  type TabBarTheme,
  type TUI,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type {
  AssistantTextEntry,
  CodeSnapshot,
  DiffLine,
  ReviewItem,
} from "./model";

export type AnnotateTab = "code" | "assistant";
export type AnnotateFocus = "source" | "reviews";

export interface CodeSelection {
  filePath: string;
  line: DiffLine;
}

export interface AnnotateViewData {
  codeSnapshot: CodeSnapshot | undefined;
  codeError: string | undefined;
  assistantEntries: AssistantTextEntry[];
  items: ReviewItem[];
  notice: { message: string; level: "info" | "warning" | "error" } | undefined;
  busy: boolean;
}

export interface AnnotateViewCallbacks {
  addCode(selection: CodeSelection): Promise<void>;
  addAssistant(entry: AssistantTextEntry): Promise<void>;
  deleteItem(item: ReviewItem): Promise<void>;
  refresh(): Promise<void>;
  send(): Promise<void>;
}

const SOURCE_HEIGHT = 12;
const REVIEW_HEIGHT = 8;

function oneLine(value: string, maxLength = 160): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
    if (char === "\r" || char === "\n" || char === "\t") return " ";
    return `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`;
  });
  const normalized = sanitized.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function statusLabel(item: ReviewItem): string {
  if (item.status === "stale") return `stale: ${item.staleReason ?? "reference changed"}`;
  return item.status;
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
      for (const line of hunk.lines) selections.push({ filePath: file.path, line });
    }
  }
  return selections;
}

interface BrowseSelection {
  filePath: string;
  label: "binary" | "no selectable patch lines";
  browseOnly: true;
}

type SourceItem = CodeSelection | BrowseSelection | AssistantTextEntry;

function codeSourceItems(snapshot: CodeSnapshot | undefined): Array<CodeSelection | BrowseSelection> {
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

class AnnotateView implements Component {
  #activeTab: AnnotateTab = "code";
  #focus: AnnotateFocus = "source";
  #sourceIndex = 0;
  #reviewIndex = 0;
  #sourceScroll = new ScrollView([], { height: SOURCE_HEIGHT, scrollbar: "auto" });
  #reviewScroll = new ScrollView([], { height: REVIEW_HEIGHT, scrollbar: "auto" });
  #tabBar: TabBar;

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
      this.tui.requestRender();
    };
  }

  render(width: number): readonly string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    lines.push(...this.#tabBar.render(safeWidth));
    lines.push(
      this.theme.fg(
        "dim",
        "↑/↓ select  a/Enter annotate  Space focus list  d delete  s send  r refresh  Esc close",
      ),
    );
    if (this.data.busy) lines.push(this.theme.fg("warning", "Working…"));
    if (this.data.notice) {
      const style = this.data.notice.level === "error" ? "error" : this.data.notice.level === "warning" ? "warning" : "muted";
      lines.push(this.theme.fg(style, oneLine(this.data.notice.message)));
    }

    const sourceRows = this.#sourceRows();
    this.#sourceScroll.setLines(sourceRows);
    this.#sourceScroll.setHeight(SOURCE_HEIGHT);
    this.#sourceScroll.setScrollOffset(this.#scrollOffset(this.#sourceIndex, sourceRows.length, SOURCE_HEIGHT));
    lines.push(this.theme.fg("accent", this.theme.bold(`${this.#activeTab === "code" ? "Code" : "Assistant"} source`)));
    lines.push(...this.#sourceScroll.render(safeWidth));

    const reviewRows = this.#reviewRows();
    this.#reviewScroll.setLines(reviewRows);
    this.#reviewScroll.setHeight(REVIEW_HEIGHT);
    this.#reviewScroll.setScrollOffset(this.#scrollOffset(this.#reviewIndex, reviewRows.length, REVIEW_HEIGHT));
    lines.push(this.theme.fg("accent", this.theme.bold(`Annotations (${this.data.items.length})`)));
    lines.push(...this.#reviewScroll.render(safeWidth));
    return lines;
  }

  handleInput(data: string): void {
    if (this.#tabBar.handleInput(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "space")) {
      this.#focus = this.#focus === "source" ? "reviews" : "source";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      if (this.#focus === "source") {
        const count = this.#sourceItems().length;
        this.#sourceIndex = Math.max(0, Math.min(this.#sourceIndex + delta, Math.max(0, count - 1)));
      } else {
        const count = this.data.items.length;
        this.#reviewIndex = Math.max(0, Math.min(this.#reviewIndex + delta, Math.max(0, count - 1)));
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "a") || matchesKey(data, "enter")) {
      if (this.#focus === "source") {
        const selected = this.#sourceItems()[this.#sourceIndex];
        if (selected && this.#activeTab === "code" && "line" in selected) {
          this.#run(() => this.callbacks.addCode(selected));
        } else if (selected && this.#activeTab === "assistant" && "text" in selected) {
          this.#run(() => this.callbacks.addAssistant(selected));
        }
      }
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
    this.#reviewScroll.invalidate();
  }

  #sourceItems(): SourceItem[] {
    return this.#activeTab === "code" ? codeSourceItems(this.data.codeSnapshot) : this.data.assistantEntries;
  }

  #sourceRows(): string[] {
    if (this.#activeTab === "code") {
      if (!this.data.codeSnapshot) return [this.data.codeError ? `Code unavailable: ${oneLine(this.data.codeError)}` : "Code source unavailable."];
      const items = codeSourceItems(this.data.codeSnapshot);
      if (items.length === 0) return ["No staged or unstaged Git changes."];
      return items.map((item, index) => {
        const pointer = this.#focus === "source" && index === this.#sourceIndex ? this.theme.fg("accent", "› ") : "  ";
        if ("browseOnly" in item) return `${pointer}[${item.label}] ${oneLine(item.filePath)} (browse-only)`;
        return `${pointer}${oneLine(item.filePath)}:${codeLineLabel(item.line)} ${oneLine(item.line.content)}`;
      });
    }

    if (this.data.assistantEntries.length === 0) return ["No visible assistant text in the current branch."];
    return this.data.assistantEntries.map((entry, index) => {
      const pointer = this.#focus === "source" && index === this.#sourceIndex ? this.theme.fg("accent", "› ") : "  ";
      const protection = entry.annotationAllowed ? "" : " [secret-protected; browse-only]";
      return `${pointer}[${oneLine(entry.id)}] ${oneLine(entry.text)}${protection}`;
    });
  }

  #reviewRows(): string[] {
    if (this.data.items.length === 0) return ["No annotations yet. Select a source row and press a."];
    return this.data.items.map((item, index) => {
      const pointer = this.#focus === "reviews" && index === this.#reviewIndex ? this.theme.fg("accent", "› ") : "  ";
      const location = item.anchor.kind === "code"
        ? `${oneLine(item.anchor.filePath)}:${item.anchor.newStart || item.anchor.oldStart}`
        : `entry ${oneLine(item.anchor.entryId)}`;
      return `${pointer}${item.source} ${oneLine(statusLabel(item))} ${location} — ${oneLine(item.body, 120)}`;
    });
  }

  #scrollOffset(index: number, rowCount: number, height: number): number {
    if (rowCount <= height) return 0;
    return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
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
