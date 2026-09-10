import type { AssistantSelectionRange } from "../assistant-selection";
import type { AssistantTextEntry, CodeSnapshot, DiffLine, ReviewItem } from "../model";
import type { GitCommit } from "../git";
import type { Notice } from "./notice";

export type AnnotateTab = "code" | "assistant";
export type AnnotateFocus = "diff" | "source" | "editor" | "reviews";

export interface CodeSelection {
  filePath: string;
  line: DiffLine;
  lines: readonly DiffLine[];
  startOffset?: number;
  endOffset?: number;
  commitOid?: string;
}

/** The revision being read. Browsing revisions is view state, not a source. */
export type CodeSource = { kind: "working-tree" } | { kind: "commit"; commit: GitCommit };

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
  notice: Notice | undefined;
  busy: boolean;
  /** Set by the view so work finishing outside the input loop repaints. */
  onChange?: () => void;
}

export interface AnnotateViewCallbacks {
  addCode(selection: CodeSelection, body: string): Promise<boolean>;
  addAssistant(
    entry: AssistantTextEntry,
    body: string,
    selection?: Pick<AssistantSelectionRange, "start" | "end">,
  ): Promise<boolean>;
  selectAssistantPrecise(entry: AssistantTextEntry): Promise<AssistantSelectionRange | undefined>;
  selectCodePrecise(filePath: string, lines: readonly DiffLine[]): Promise<CodeSelection | undefined>;
  selectCommit(commit: GitCommit): Promise<boolean>;
  selectWorkingTree(): Promise<boolean>;
  deleteItem(item: ReviewItem): Promise<void>;
  updateItem(item: ReviewItem, body: string): Promise<boolean>;
  refresh(): Promise<void>;
  send(): Promise<void>;
}

export interface AnnotateLayout {
  leftWidth: number;
  dividerWidth: number;
  rightWidth: number;
  bodyHeight: number;
  sourceHeight: number;
  draftHeight: number;
  reviewHeight: number;
}
