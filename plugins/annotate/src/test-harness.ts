import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { ensureTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { AssistantSelectionRange } from "./assistant-selection";
import {
  createCodeAnchor,
  parseUnifiedDiff,
  type AssistantTextEntry,
  type CodeSnapshot,
  type DiffFile,
  type DiffLine,
  type ReviewItem,
} from "./model";
import {
  createAnnotateView,
  type AnnotateViewCallbacks,
  type AnnotateViewData,
  type CodeSelection,
} from "./ui";

const SAMPLE_DIFF = `diff --git a/src/review-target.ts b/src/review-target.ts
index 1111111..2222222 100644
--- a/src/review-target.ts
+++ b/src/review-target.ts
@@ -1,5 +1,6 @@
 const title = "Annotate";
-const removedEvidence = "legacy line";
+const added = "evidence";
 const contextValue = "kept context";
+const addedContext = "another added line";
 const footer = "footer";
-const oldTail = "old tail";
+const newTail = "new tail";
@@ -10,3 +11,4 @@ function buildReview()
   const start = true;
-  return "old result";
+  return "added result from second hunk";
   return start;
+  // hunk two context follows the change
diff --git a/docs/old-review.md b/docs/new-review.md
similarity index 100%
rename from docs/old-review.md
rename to docs/new-review.md
diff --git a/assets/icon.png b/assets/icon.png
new file mode 100644
index 0000000..3333333
Binary files /dev/null and b/assets/icon.png differ`;

const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI, "");
}

export interface FakeTui extends TUI {
  readonly renderRequests: number;
  setSize(columns: number, rows: number): void;
}

export function createFakeTui(options: { columns?: number; rows?: number } = {}): FakeTui {
  let columns = options.columns ?? 120;
  let rows = options.rows ?? 30;
  let renderRequests = 0;
  const terminal = {
    get columns(): number {
      return columns;
    },
    get rows(): number {
      return rows;
    },
  };
  const fake = {
    terminal,
    requestRender(): void {
      renderRequests += 1;
    },
    get renderRequests(): number {
      return renderRequests;
    },
    setSize(nextColumns: number, nextRows: number): void {
      columns = nextColumns;
      rows = nextRows;
    },
  };
  return fake as unknown as FakeTui;
}

export async function loadTheme(): Promise<Theme> {
  await ensureTheme();
  return theme;
}

export function sampleDiffFiles(): DiffFile[] {
  return parseUnifiedDiff(SAMPLE_DIFF);
}

export interface HarnessCalls {
  addCode: Array<{ selection: CodeSelection; body: string }>;
  addAssistant: Array<{
    entry: AssistantTextEntry;
    body: string;
    selection: Pick<AssistantSelectionRange, "start" | "end"> | undefined;
  }>;
  selectAssistantPrecise: AssistantTextEntry[];
  selectCodePrecise: Array<{ filePath: string; lines: readonly DiffLine[] }>;
  selectCommit: unknown[];
  selectWorkingTree: number;
  deleteItem: ReviewItem[];
  updateItem: Array<{ item: ReviewItem; body: string }>;
  refresh: number;
  send: number;
}

export interface AnnotateHarness {
  view: Component & { focused: boolean; handleInput(data: string): void };
  data: AnnotateViewData;
  callbacks: AnnotateViewCallbacks;
  tui: FakeTui;
  done: () => void;
  readonly doneCalls: number;
  calls: HarnessCalls;
  frame(): string[];
  lines(): string[];
  press(data: string): void;
}

export async function createHarness(overrides: Partial<AnnotateViewData> = {}): Promise<AnnotateHarness> {
  const files = sampleDiffFiles();
  const firstFile = files[0];
  const secondHunk = firstFile?.hunks[1];
  const firstAddition = firstFile?.hunks[0]?.lines.find(line => line.kind === "addition");
  const secondAddition = secondHunk?.lines.find(line => line.kind === "addition");
  if (!firstFile || !firstAddition || !secondAddition) {
    throw new Error("The sample diff must include two selectable additions in separate hunks.");
  }

  const snapshot: CodeSnapshot = {
    root: "/tmp/annotate-harness-repository",
    repositoryId: "/tmp/annotate-harness-repository/.git",
    headOid: "1111111111111111111111111111111111111111",
    diffFingerprint: "2222222222222222222222222222222222222222",
    commitOid: "3333333333333333333333333333333333333333",
    files,
  };
  const codeAnchor = createCodeAnchor(snapshot, firstFile.path, [firstAddition]);
  const staleAnchor = createCodeAnchor(snapshot, firstFile.path, [secondAddition]);
  if (!codeAnchor || !staleAnchor) throw new Error("The sample diff did not produce code anchors.");

  const assistantEntries: AssistantTextEntry[] = [
    {
      id: "assistant-entry-1",
      timestamp: "2026-01-02T03:04:05.000Z",
      text: "Assistant evidence: review the empty queue before sending.",
      annotationAllowed: true,
    },
    {
      id: "assistant-entry-2",
      timestamp: "2026-01-02T03:05:05.000Z",
      text: "Assistant note: this browse-only response cannot be annotated.",
      annotationAllowed: false,
    },
  ];
  const makeReviewItem = (id: string, anchor: ReviewItem["anchor"], status: ReviewItem["status"], body: string): ReviewItem => ({
    schemaVersion: 1,
    id,
    source: "code",
    anchor,
    body,
    createdAt: "2026-01-02T03:06:05.000Z",
    status,
    ...(status === "stale" ? { staleReason: "The source revision changed." } : {}),
  });
  const baseData: AnnotateViewData = {
    codeSnapshot: snapshot,
    codeWorkingSnapshot: snapshot,
    codeError: undefined,
    codeCommits: [],
    codeSource: { kind: "working-tree" },
    codeHistoryError: undefined,
    codeSnapshots: new Map([[snapshot.commitOid!, snapshot]]),
    assistantEntries,
    items: [
      makeReviewItem("review-pending", codeAnchor, "pending", "Check the added evidence line."),
      makeReviewItem("review-stale", staleAnchor, "stale", "Revisit the second hunk result."),
    ],
    notice: undefined,
    busy: false,
  };
  const data = { ...baseData, ...overrides };
  const calls: HarnessCalls = {
    addCode: [],
    addAssistant: [],
    selectAssistantPrecise: [],
    selectCodePrecise: [],
    selectCommit: [],
    selectWorkingTree: 0,
    deleteItem: [],
    updateItem: [],
    refresh: 0,
    send: 0,
  };
  const callbacks: AnnotateViewCallbacks = {
    addCode: async (selection, body) => {
      calls.addCode.push({ selection, body });
      return true;
    },
    addAssistant: async (entry, body, selection) => {
      calls.addAssistant.push({ entry, body, selection });
      return true;
    },
    selectAssistantPrecise: async entry => {
      calls.selectAssistantPrecise.push(entry);
      const end = Math.max(1, Math.min(entry.text.length, 8));
      return { start: 0, end, text: entry.text.slice(0, end) };
    },
    selectCodePrecise: async (filePath, lines) => {
      calls.selectCodePrecise.push({ filePath, lines });
      const line = lines[0];
      return line === undefined ? undefined : { filePath, line, lines };
    },
    selectCommit: async commit => {
      calls.selectCommit.push(commit);
      return true;
    },
    selectWorkingTree: async () => {
      calls.selectWorkingTree += 1;
      return true;
    },
    deleteItem: async item => {
      calls.deleteItem.push(item);
    },
    updateItem: async (item, body) => {
      calls.updateItem.push({ item, body });
      return true;
    },
    refresh: async () => {
      calls.refresh += 1;
    },
    send: async () => {
      calls.send += 1;
    },
  };
  const tui = createFakeTui();
  let doneCalls = 0;
  const done = (): void => {
    doneCalls += 1;
  };
  const view = createAnnotateView(tui, await loadTheme(), data, callbacks, done) as Component & {
    focused: boolean;
    handleInput(data: string): void;
  };
  view.focused = true;

  return {
    view,
    data,
    callbacks,
    tui,
    done,
    get doneCalls(): number {
      return doneCalls;
    },
    calls,
    frame(): string[] {
      return Array.from(view.render(tui.terminal.columns)).map(stripAnsi);
    },
    lines(): string[] {
      return Array.from(view.render(tui.terminal.columns));
    },
    press(data: string): void {
      view.handleInput(data);
    },
  };
}

