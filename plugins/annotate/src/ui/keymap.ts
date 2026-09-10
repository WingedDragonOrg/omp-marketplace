import { matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import type { AnnotateCodePaneMode } from "./code";
import type { AnnotateFocus, AnnotateTab } from "./types";

/**
 * `saveDraft` and `insertLineBreak` belong to the nested editor, which handles
 * those keys itself; they exist here so the hint line and help sheet describe
 * the draft pane from the same table as everything else.
 */
export type AnnotateAction =
  | "help"
  | "closeHelp"
  | "close"
  | "focusNext"
  | "focusPrev"
  | "leaveEditor"
  | "saveDraft"
  | "insertLineBreak"
  | "tabCode"
  | "tabAssistant"
  | "send"
  | "refresh"
  | "toggleDock"
  | "toggleRevisions"
  | "cycleView"
  | "toggleWrap"
  | "annotate"
  | "annotatePrecise"
  | "openSource"
  | "inspect"
  | "closeCard"
  | "edit"
  | "discardDraft"
  | "deleteAnnotation"
  | "revealAnnotation"
  | "prevFile"
  | "nextFile"
  | "moveUp"
  | "moveDown"
  | "pageUp"
  | "pageDown"
  | "toTop"
  | "toBottom"
  | "extendUp"
  | "extendDown"
  | "scrollLeft"
  | "scrollRight";

export type AnnotateKeyGroup = "read" | "annotate" | "queue" | "sources" | "session";

const GROUP_TITLES: Record<AnnotateKeyGroup, string> = {
  read: "Read the evidence",
  annotate: "Write an annotation",
  queue: "Check the queue",
  sources: "Change what you read",
  session: "Session",
};

const GROUP_ORDER: readonly AnnotateKeyGroup[] = ["read", "annotate", "queue", "sources", "session"];

/** Everything a binding may depend on; the view passes its current state. */
export interface AnnotateScope {
  focus: AnnotateFocus;
  tab: AnnotateTab;
  codeMode: AnnotateCodePaneMode;
  /** A draft target is set, so the draft pane and discard are reachable. */
  hasDraft: boolean;
  /** The dock lists revisions (working tree plus recent commits) instead of files. */
  revisions: boolean;
  dockCollapsed: boolean;
  helpOpen: boolean;
  /** The annotation card is open over the evidence, so it owns the keys. */
  cardOpen: boolean;
}

interface AnnotateBinding {
  action: AnnotateAction;
  /** Literal input bytes, matched before named keys. */
  chars?: readonly string[];
  /** Named keys resolved with `matchesKey`. */
  keys?: readonly KeyId[];
  /** How the key reads in hints and help. */
  display: string;
  label: string | ((scope: AnnotateScope) => string);
  group: AnnotateKeyGroup;
  when?: (scope: AnnotateScope) => boolean;
  /** Lower sorts earlier in the header hint; omitted keeps it in help only. */
  hint?: number;
}

const editing = (scope: AnnotateScope): boolean => scope.focus === "editor";
const inspecting = (scope: AnnotateScope): boolean => scope.cardOpen && !scope.helpOpen;
const reading = (scope: AnnotateScope): boolean => !editing(scope) && !scope.helpOpen && !scope.cardOpen;
const code = (scope: AnnotateScope): boolean => scope.tab === "code";
/** Movement works while reading, inside the card, and on the help sheet. */
const browsing = (scope: AnnotateScope): boolean => !editing(scope);
const codeEvidence = (scope: AnnotateScope): boolean =>
  reading(scope) && scope.tab === "code" && scope.focus === "diff";

/**
 * The one place Annotate states what a key does. Dispatch, the header hint and
 * the help sheet all read this table, so a key cannot mean one thing and
 * document another.
 */
const ANNOTATE_BINDINGS: readonly AnnotateBinding[] = [
  {
    action: "closeHelp",
    chars: ["?", "q"],
    keys: ["escape"],
    display: "esc",
    label: "close keys",
    group: "session",
    when: scope => scope.helpOpen,
    hint: 10,
  },
  {
    action: "moveDown",
    display: "up / down",
    label: "scroll the sheet",
    group: "session",
    when: scope => scope.helpOpen,
    hint: 20,
  },
  {
    action: "annotate",
    chars: ["a"],
    display: "a",
    label: "annotate this line again",
    group: "annotate",
    when: inspecting,
    hint: 10,
  },
  {
    action: "edit",
    chars: ["e"],
    keys: ["enter"],
    display: "e",
    label: "edit this annotation",
    group: "queue",
    when: inspecting,
    hint: 20,
  },
  {
    action: "deleteAnnotation",
    chars: ["d"],
    display: "d",
    label: "delete this annotation",
    group: "queue",
    when: inspecting,
    hint: 30,
  },
  {
    action: "closeCard",
    chars: ["q", "i"],
    keys: ["escape"],
    display: "esc",
    label: "close the annotation",
    group: "queue",
    when: inspecting,
    hint: 40,
  },
  {
    action: "leaveEditor",
    keys: ["escape"],
    display: "esc",
    label: scope => (scope.hasDraft ? "keep draft" : "leave draft"),
    group: "annotate",
    when: editing,
    hint: 30,
  },
  {
    action: "close",
    chars: ["q"],
    keys: ["escape"],
    display: "q / esc",
    label: "close Annotate",
    group: "session",
    when: scope => !editing(scope),
  },
  { action: "focusNext", keys: ["tab"], display: "tab", label: "next pane", group: "session", hint: 70 },
  { action: "focusPrev", keys: ["shift+tab"], display: "shift+tab", label: "previous pane", group: "session" },
  {
    action: "annotate",
    chars: ["a"],
    display: "a",
    label: "annotate selection",
    group: "annotate",
    when: scope => reading(scope) && !(code(scope) && scope.revisions),
    hint: 10,
  },
  {
    action: "annotate",
    keys: ["enter"],
    display: "enter",
    label: "annotate selection",
    group: "annotate",
    when: scope => reading(scope) && scope.focus === "diff" && !(code(scope) && scope.revisions),
  },
  {
    action: "annotatePrecise",
    chars: ["p"],
    display: "p",
    label: "pick exact text",
    group: "annotate",
    when: scope => reading(scope) && !(code(scope) && scope.revisions),
    hint: 20,
  },
  {
    action: "saveDraft",
    display: "enter",
    label: "save annotation",
    group: "annotate",
    when: editing,
    hint: 10,
  },
  {
    action: "insertLineBreak",
    display: "alt+enter",
    label: "line break",
    group: "annotate",
    when: editing,
    hint: 20,
  },
  {
    action: "openSource",
    keys: ["enter"],
    display: "enter",
    label: scope => (code(scope) && scope.revisions ? "read this revision" : "read this source"),
    group: "sources",
    when: scope => reading(scope) && scope.focus === "source",
    hint: 15,
  },
  {
    action: "inspect",
    chars: ["i"],
    display: "i",
    label: "read the marks here",
    group: "queue",
    when: codeEvidence,
    hint: 35,
  },
  {
    action: "edit",
    chars: ["e"],
    display: "e",
    label: "edit annotation",
    group: "queue",
    when: reading,
    hint: 40,
  },
  {
    action: "discardDraft",
    chars: ["x"],
    display: "x",
    label: "discard draft",
    group: "annotate",
    when: scope => reading(scope) && scope.hasDraft,
    hint: 45,
  },
  {
    action: "deleteAnnotation",
    chars: ["d"],
    display: "d",
    label: "delete annotation",
    group: "queue",
    when: scope => reading(scope) && scope.focus === "reviews",
    hint: 30,
  },
  {
    action: "revealAnnotation",
    keys: ["enter"],
    display: "enter",
    label: "show in evidence",
    group: "queue",
    when: scope => reading(scope) && scope.focus === "reviews",
    hint: 25,
  },
  { action: "send", chars: ["s"], display: "s", label: "send to agent", group: "queue", when: reading, hint: 50 },
  { action: "tabCode", chars: ["1"], display: "1", label: "code changes", group: "sources", when: reading },
  { action: "tabAssistant", chars: ["2"], display: "2", label: "assistant output", group: "sources", when: reading },
  {
    action: "toggleRevisions",
    chars: ["H"],
    display: "H",
    label: scope => (scope.revisions ? "back to changed files" : "browse revisions"),
    group: "sources",
    when: scope => reading(scope) && code(scope),
    hint: 60,
  },
  {
    action: "prevFile",
    chars: ["["],
    display: "[",
    label: "previous file",
    group: "sources",
    when: scope => reading(scope) && code(scope) && !scope.revisions,
  },
  {
    action: "nextFile",
    chars: ["]"],
    display: "]",
    label: "next file",
    group: "sources",
    when: scope => reading(scope) && code(scope) && !scope.revisions,
  },
  { action: "refresh", chars: ["r"], display: "r", label: "refresh sources", group: "sources", when: reading },
  {
    action: "cycleView",
    chars: ["v"],
    display: "v",
    label: scope => `view: ${scope.codeMode}`,
    group: "read",
    when: scope => reading(scope) && code(scope),
    hint: 55,
  },
  {
    action: "toggleWrap",
    chars: ["w"],
    display: "w",
    label: "wrap long lines",
    group: "read",
    when: scope => reading(scope) && code(scope),
  },
  {
    action: "toggleDock",
    chars: ["f"],
    display: "f",
    label: scope => (scope.dockCollapsed ? "show the dock" : "full-width evidence"),
    group: "read",
    when: reading,
    hint: 65,
  },
  { action: "help", chars: ["?"], display: "?", label: "keys", group: "session", when: reading, hint: 90 },
  {
    action: "extendUp",
    keys: ["shift+up"],
    display: "shift+up",
    label: "extend selection up",
    group: "annotate",
    when: codeEvidence,
  },
  {
    action: "extendDown",
    keys: ["shift+down"],
    display: "shift+down",
    label: "extend selection down",
    group: "annotate",
    when: codeEvidence,
  },
  {
    action: "moveUp",
    chars: ["k"],
    keys: ["up"],
    display: "up / k",
    label: scope => (codeEvidence(scope) && scope.codeMode === "hunk" ? "previous hunk" : "move up"),
    group: "read",
    when: browsing,
  },
  {
    action: "moveDown",
    chars: ["j"],
    keys: ["down"],
    display: "down / j",
    label: scope => (codeEvidence(scope) && scope.codeMode === "hunk" ? "next hunk" : "move down"),
    group: "read",
    when: browsing,
  },
  { action: "pageUp", keys: ["pageUp"], display: "page up", label: "page up", group: "read", when: browsing },
  {
    action: "pageUp",
    keys: ["shift+up"],
    display: "shift+up",
    label: "page up",
    group: "read",
    when: scope => browsing(scope) && !codeEvidence(scope),
  },
  {
    action: "pageDown",
    chars: [" "],
    keys: ["pageDown"],
    display: "page down / space",
    label: "page down",
    group: "read",
    when: browsing,
  },
  {
    action: "pageDown",
    keys: ["shift+down"],
    display: "shift+down",
    label: "page down",
    group: "read",
    when: scope => browsing(scope) && !codeEvidence(scope),
  },
  { action: "toTop", chars: ["g"], keys: ["home"], display: "g", label: "jump to start", group: "read", when: browsing },
  { action: "toBottom", chars: ["G"], keys: ["end"], display: "G", label: "jump to end", group: "read", when: browsing },
  {
    action: "scrollLeft",
    chars: ["h"],
    keys: ["left"],
    display: "h",
    label: "scroll left",
    group: "read",
    when: codeEvidence,
  },
  {
    action: "scrollRight",
    chars: ["l"],
    keys: ["right"],
    display: "l",
    label: "scroll right",
    group: "read",
    when: codeEvidence,
  },
];

function bindingApplies(binding: AnnotateBinding, scope: AnnotateScope): boolean {
  return binding.when === undefined || binding.when(scope);
}

function bindingLabel(binding: AnnotateBinding, scope: AnnotateScope): string {
  return typeof binding.label === "string" ? binding.label : binding.label(scope);
}

/** Resolve one keypress in the current scope; unbound input falls through to the pane. */
export function resolveAnnotateAction(data: string, scope: AnnotateScope): AnnotateAction | undefined {
  for (const binding of ANNOTATE_BINDINGS) {
    if (!bindingApplies(binding, scope)) continue;
    if (binding.chars?.includes(data)) return binding.action;
    if (binding.keys?.some(key => matchesKey(data, key)) === true) return binding.action;
  }
  return undefined;
}

export interface AnnotateKeyHint {
  key: string;
  label: string;
}

/** Header hints, most useful first, so trimming drops the least useful pair. */
export function annotateHints(scope: AnnotateScope): AnnotateKeyHint[] {
  return ANNOTATE_BINDINGS.filter(binding => binding.hint !== undefined && bindingApplies(binding, scope))
    .sort((left, right) => (left.hint ?? 0) - (right.hint ?? 0))
    .map(binding => ({ key: binding.display, label: bindingLabel(binding, scope) }));
}

export interface AnnotateKeySection {
  title: string;
  rows: AnnotateKeyHint[];
}

/**
 * Grouped keys for the help sheet, including keys the header never has room
 * for. Keys that share a label collapse into one row, keeping the two most
 * memorable spellings so the key column stays narrow enough to read.
 */
export function annotateKeySections(scope: AnnotateScope): AnnotateKeySection[] {
  const helpScope: AnnotateScope = { ...scope, helpOpen: false };
  const sections: AnnotateKeySection[] = [];
  for (const group of GROUP_ORDER) {
    const rows: AnnotateKeyHint[] = [];
    for (const binding of ANNOTATE_BINDINGS) {
      if (binding.group !== group || !bindingApplies(binding, helpScope)) continue;
      const label = bindingLabel(binding, helpScope);
      const existing = rows.find(row => row.label === label);
      if (existing === undefined) {
        rows.push({ key: binding.display, label });
        continue;
      }
      const spellings = existing.key.split(" / ");
      if (spellings.length < 2 && !spellings.includes(binding.display)) {
        existing.key = `${existing.key} / ${binding.display}`;
      }
    }
    if (rows.length > 0) sections.push({ title: GROUP_TITLES[group], rows });
  }
  return sections;
}
