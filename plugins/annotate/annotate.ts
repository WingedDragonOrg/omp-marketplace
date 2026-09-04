import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  buildReviewMessage,
  collectAssistantTextEntries,
  createAssistantAnchor,
  createCodeAnchor,
  extractAssistantText,
  findUniqueTextRange,
  restoreReviewItems,
  deletedReviewItemIds,
  REVIEW_CUSTOM_TYPE,
  type AssistantAnchor,
  type AssistantTextEntry,
  type CodeAnchor,
  type ReviewEvent,
  type ReviewItem,
} from "./src/model";
import { readGitSnapshot, type GitExecutor } from "./src/git";
import {
  carryMissingReviewItems,
  isDispatchConfirmation,
  validatePendingItems,
  type PendingValidation,
} from "./src/workflow";
import {
  createAnnotateView,
  type AnnotateViewCallbacks,
  type AnnotateViewData,
  type CodeSelection,
} from "./src/ui";

interface OverlayHandle {
  setHidden(hidden: boolean): void;
}

interface PendingDispatch {
  sessionId: string;
  baseLeafId: string | null;
  content: string;
  itemIds: string[];
  data: AnnotateViewData;
}

interface RuntimeState {
  activeData: AnnotateViewData | undefined;
  overlayHandle: OverlayHandle | undefined;
  pendingDispatch: PendingDispatch | undefined;
  visibleAssistantTextByTimestamp: Map<string, string>;
  visibleAssistantSessionId: string | undefined;
  lastItems: ReviewItem[];
  lastSessionId: string | undefined;
  lastLeafId: string | null | undefined;
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.mode !== "tui") {
    console.error(message);
    return;
  }
  try {
    ctx.ui.notify(message, level);
  } catch {
    console.error(message);
  }
}

function appendReviewEvent(pi: ExtensionAPI, event: ReviewEvent): void {
  pi.appendEntry(REVIEW_CUSTOM_TYPE, event);
}

function replaceItem(items: ReviewItem[], updated: ReviewItem): ReviewItem[] {
  return items.map(item => item.id === updated.id ? updated : item);
}

function currentBranch(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch();
}

interface RestoredBranchItems {
  items: ReviewItem[];
  invalidCount: number;
}

function restoreBranchItems(
  pi: ExtensionAPI,
  branchEntries: readonly unknown[],
  previousItems: readonly ReviewItem[],
): RestoredBranchItems {
  let invalidCount = 0;
  const restored = restoreReviewItems(branchEntries, () => {
    invalidCount += 1;
  });
  const items = carryMissingReviewItems(restored, previousItems, deletedReviewItemIds(branchEntries));
  for (let index = restored.length; index < items.length; index += 1) {
    const item = items[index];
    if (item) appendReviewEvent(pi, { action: "upsert", item });
  }
  return { items, invalidCount };
}

function syncReviewState(state: RuntimeState, ctx: ExtensionContext, items: readonly ReviewItem[]): void {
  state.lastItems = [...items];
  state.lastSessionId = ctx.sessionManager.getSessionId();
  state.lastLeafId = ctx.sessionManager.getLeafId();
}

function persistStaleItems(pi: ExtensionAPI, data: AnnotateViewData, staleItems: PendingValidation["stale"]): void {
  for (const stale of staleItems) {
    appendReviewEvent(pi, { action: "upsert", item: stale.item });
    data.items = replaceItem(data.items, stale.item);
  }
}


function markDispatchSent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pending: PendingDispatch,
  state: RuntimeState,
): void {
  let sentCount = 0;
  for (const itemId of pending.itemIds) {
    const item = pending.data.items.find(candidate => candidate.id === itemId);
    if (!item || item.status !== "pending") continue;
    const sent = { ...item, status: "sent" as const, staleReason: undefined };
    appendReviewEvent(pi, { action: "upsert", item: sent });
    pending.data.items = replaceItem(pending.data.items, sent);
    sentCount += 1;
  }
  syncReviewState(state, ctx, pending.data.items);
  if (sentCount > 0) {
    notify(ctx, `Sent ${sentCount} annotation${sentCount === 1 ? "" : "s"} to the current agent.`);
  }
}
async function withOverlayHidden<T>(state: RuntimeState, operation: () => Promise<T>): Promise<T> {
  state.overlayHandle?.setHidden(true);
  try {
    return await operation();
  } finally {
    state.overlayHandle?.setHidden(false);
  }
}

async function refreshData(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: AnnotateViewData,
  exec: GitExecutor,
  visibleTextByTimestamp: ReadonlyMap<string, string>,
  previousItems: readonly ReviewItem[] = [],
): Promise<boolean> {
  const sessionId = ctx.sessionManager.getSessionId();
  const leafId = ctx.sessionManager.getLeafId();
  const cwd = ctx.sessionManager.getCwd();
  const branchEntries = currentBranch(ctx);
  const result = await readGitSnapshot(exec, cwd);
  if (
    sessionId !== ctx.sessionManager.getSessionId() ||
    leafId !== ctx.sessionManager.getLeafId() ||
    cwd !== ctx.sessionManager.getCwd()
  ) return false;
  const restored = restoreBranchItems(pi, branchEntries, previousItems);
  data.items = restored.items;
  data.assistantEntries = collectAssistantTextEntries(branchEntries, visibleTextByTimestamp);
  if (result.kind === "ok") {
    data.codeSnapshot = result.snapshot;
    data.codeError = undefined;
  } else {
    data.codeSnapshot = undefined;
    data.codeError = result.detail;
  }
  const validation = validatePendingItems(data.items, {
    sessionId: ctx.sessionManager.getSessionId(),
    branchEntries,
    codeSnapshot: data.codeSnapshot,
    visibleTextByTimestamp,
  });
  persistStaleItems(pi, data, validation.stale);
  if (restored.invalidCount > 0) {
    notify(
      ctx,
      `Skipped ${restored.invalidCount} invalid Annotate record${restored.invalidCount === 1 ? "" : "s"}.`,
      "warning",
    );
  }
  return true;
}

type NewItemInput =
  | { source: "code"; anchor: CodeAnchor }
  | { source: "assistant"; anchor: AssistantAnchor };

function newItem(input: NewItemInput, body: string): ReviewItem {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    ...input,
    body,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

async function addCodeAnnotation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: AnnotateViewData,
  state: RuntimeState,
  selection: CodeSelection,
): Promise<void> {
  if (!data.codeSnapshot) {
    notify(ctx, data.codeError ?? "Code source is unavailable.", "error");
    return;
  }
  const body = await withOverlayHidden(state, () => ctx.ui.editor("Code annotation", ""));
  if (body === undefined) return;
  if (body.trim().length === 0) {
    notify(ctx, "Annotation text cannot be empty.", "warning");
    return;
  }
  const anchor = createCodeAnchor(data.codeSnapshot, selection.filePath, [selection.line]);
  if (!anchor) {
    notify(ctx, "The selected code does not have a stable location.", "warning");
    return;
  }
  const item = newItem({ source: "code", anchor }, body.trim());
  appendReviewEvent(pi, { action: "upsert", item });
  data.items = [...data.items, item];
  syncReviewState(state, ctx, data.items);
  notify(ctx, "Code annotation added.");
}

async function addAssistantAnnotation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: AnnotateViewData,
  state: RuntimeState,
  entry: AssistantTextEntry,
): Promise<void> {
  if (!entry.annotationAllowed) {
    notify(ctx, "This assistant text is secret-protected and cannot be persisted as an annotation.", "warning");
    return;
  }
  const selected = await withOverlayHidden(
    state,
    () => ctx.ui.editor("Assistant excerpt (keep only the text to annotate)", entry.text),
  );
  if (selected === undefined) return;
  const excerpt = selected.trim();
  const range = findUniqueTextRange(entry.text, excerpt);
  if (!range) {
    notify(ctx, "Select one unique excerpt; include more context when the text repeats.", "warning");
    return;
  }
  const body = await withOverlayHidden(state, () => ctx.ui.editor("Assistant annotation", ""));
  if (body === undefined) return;
  if (body.trim().length === 0) {
    notify(ctx, "Annotation text cannot be empty.", "warning");
    return;
  }
  const anchor = createAssistantAnchor({
    sessionId: ctx.sessionManager.getSessionId(),
    entryId: entry.id,
    messageText: entry.text,
    start: range.start,
    end: range.end,
  });
  if (!anchor) {
    notify(ctx, "The selected assistant text does not have a stable location.", "warning");
    return;
  }
  const item = newItem({ source: "assistant", anchor }, body.trim());
  appendReviewEvent(pi, { action: "upsert", item });
  data.items = [...data.items, item];
  syncReviewState(state, ctx, data.items);
  notify(ctx, "Assistant annotation added.");
}

async function deleteAnnotation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: AnnotateViewData,
  state: RuntimeState,
  item: ReviewItem,
): Promise<void> {
  if (item.status !== "pending") {
    notify(ctx, "Only pending annotations can be deleted.", "warning");
    return;
  }
  appendReviewEvent(pi, { action: "delete", id: item.id });
  data.items = data.items.filter(candidate => candidate.id !== item.id);
  syncReviewState(state, ctx, data.items);
  notify(ctx, "Annotation deleted.");
}

async function reconcilePendingDispatch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<boolean> {
  const pending = state.pendingDispatch;
  if (!pending) return false;
  if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
    state.pendingDispatch = undefined;
    notify(ctx, "The pending annotation delivery belongs to another session; annotations remain pending.", "warning");
    return false;
  }
  await ctx.waitForIdle();
  if (state.pendingDispatch !== pending) return false;
  if (pending.sessionId !== ctx.sessionManager.getSessionId()) {
    state.pendingDispatch = undefined;
    notify(ctx, "The pending annotation delivery belongs to another session; annotations remain pending.", "warning");
    return false;
  }
  const branchEntries = currentBranch(ctx);
  const baseStillPresent =
    pending.baseLeafId === null || branchEntries.some(entry => entry.id === pending.baseLeafId);
  const delivered = branchEntries.some(
    entry =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      isDispatchConfirmation(entry.message.content, pending.content),
  );
  const branchItems = restoreReviewItems(branchEntries);
  const allItemsPending = pending.itemIds.every(
    itemId => branchItems.some(item => item.id === itemId && item.status === "pending"),
  );
  if (baseStillPresent && delivered && allItemsPending) {
    pending.data.items = branchItems;
    state.pendingDispatch = undefined;
    markDispatchSent(pi, ctx, pending, state);
    return true;
  }
  if (state.pendingDispatch === pending) state.pendingDispatch = undefined;
  return false;
}
async function sendAnnotations(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  data: AnnotateViewData,
  state: RuntimeState,
  exec: GitExecutor,
): Promise<void> {
  if (!ctx.isIdle()) {
    notify(ctx, "The agent is busy; pending annotations were kept for later.", "warning");
    return;
  }
  if (state.pendingDispatch && await reconcilePendingDispatch(pi, ctx, state)) return;

  const refreshed = await refreshData(pi, ctx, data, exec, state.visibleAssistantTextByTimestamp);
  if (!refreshed) {
    notify(ctx, "The session changed while loading annotations; refresh and retry.", "warning");
    return;
  }
  syncReviewState(state, ctx, data.items);
  const branchEntries = currentBranch(ctx);
  const validation = validatePendingItems(data.items, {
    sessionId: ctx.sessionManager.getSessionId(),
    branchEntries,
    codeSnapshot: data.codeSnapshot,
    visibleTextByTimestamp: state.visibleAssistantTextByTimestamp,
  });

  persistStaleItems(pi, data, validation.stale);
  syncReviewState(state, ctx, data.items);
  if (!ctx.isIdle()) {
    notify(ctx, "The agent became busy; pending annotations were kept for later.", "warning");
    return;
  }
  if (state.pendingDispatch) {
    notify(ctx, "A previous annotation delivery is still awaiting confirmation.", "warning");
    return;
  }
  if (validation.valid.length === 0) {
    notify(ctx, "No valid pending annotations to send.", "warning");
    return;
  }

  const content = buildReviewMessage(validation.valid);
  state.pendingDispatch = {
    sessionId: ctx.sessionManager.getSessionId(),
    baseLeafId: ctx.sessionManager.getLeafId(),
    content,
    itemIds: validation.valid.map(item => item.id),
    data,
  };
  try {
    pi.sendUserMessage(content, { deliverAs: "aside" });
  } catch (error) {
    state.pendingDispatch = undefined;
    notify(ctx, `Sending annotations failed: ${messageForError(error)}`, "error");
    return;
  }
  notify(ctx, `Sending ${validation.valid.length} annotation${validation.valid.length === 1 ? "" : "s"} to the current agent.`);
}

async function openAnnotate(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: RuntimeState, exec: GitExecutor): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    notify(ctx, "/annotate requires the interactive TUI.", "warning");
    return;
  }

  const data: AnnotateViewData = {
    codeSnapshot: undefined,
    codeError: undefined,
    assistantEntries: [],
    items: restoreReviewItems(currentBranch(ctx)),
    notice: undefined,
    busy: false,
  };
  const refreshed = await refreshData(pi, ctx, data, exec, state.visibleAssistantTextByTimestamp);
  if (!refreshed) {
    notify(ctx, "The session changed while loading annotations; refresh and retry.", "warning");
    return;
  }
  syncReviewState(state, ctx, data.items);
  state.activeData = data;

  const callbacks: AnnotateViewCallbacks = {
    addCode: selection => addCodeAnnotation(pi, ctx, data, state, selection),
    addAssistant: entry => addAssistantAnnotation(pi, ctx, data, state, entry),
    deleteItem: item => deleteAnnotation(pi, ctx, data, state, item),
    refresh: async () => {
      if (await refreshData(pi, ctx, data, exec, state.visibleAssistantTextByTimestamp)) {
        syncReviewState(state, ctx, data.items);
      }
    },
    send: () => sendAnnotations(pi, ctx, data, state, exec),
  };

  try {
    await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
      return createAnnotateView(tui, theme, data, callbacks, () => done(undefined));
    }, {
      overlay: true,
      overlayOptions: {
        fullscreen: true,
        margin: 1,
      },
      onHandle: handle => {
        state.overlayHandle = handle;
      },
    });
  } finally {
    if (state.activeData === data) state.activeData = undefined;
    state.overlayHandle = undefined;
  }
}

export default function annotateExtension(pi: ExtensionAPI): void {
  pi.setLabel("Annotate");
  const state: RuntimeState = {
    activeData: undefined,
    overlayHandle: undefined,
    pendingDispatch: undefined,
    visibleAssistantTextByTimestamp: new Map(),
    visibleAssistantSessionId: undefined,
    lastItems: [],
    lastSessionId: undefined,
    lastLeafId: undefined,
  };
  const exec: GitExecutor = async (cwd, args) => pi.exec("git", args, { cwd });

  const restoreActiveBranch = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (state.visibleAssistantSessionId !== sessionId) {
      state.visibleAssistantTextByTimestamp.clear();
      state.visibleAssistantSessionId = sessionId;
    }
    const leafId = ctx.sessionManager.getLeafId();
    let eventType: unknown;
    if (typeof _event === "object" && _event !== null && "type" in _event) {
      eventType = _event.type;
    }
    const carryAcrossTransition =
      eventType === "session_branch"
        ? state.lastSessionId !== undefined
        : eventType === "session_tree" && state.lastSessionId === sessionId;
    const previousItems = carryAcrossTransition ? state.lastItems : [];
    const pending = state.pendingDispatch;
    if (pending && (pending.sessionId !== sessionId || pending.baseLeafId !== leafId)) {
      state.pendingDispatch = undefined;
      notify(ctx, "The pending annotation delivery was cancelled by a session branch change.", "warning");
    }
    if (!state.activeData) {
      const restored = restoreBranchItems(pi, currentBranch(ctx), previousItems);
      syncReviewState(state, ctx, restored.items);
      if (restored.invalidCount > 0) {
        notify(
          ctx,
          `Skipped ${restored.invalidCount} invalid Annotate record${restored.invalidCount === 1 ? "" : "s"}.`,
          "warning",
        );
      }
      return;
    }
    if (await refreshData(pi, ctx, state.activeData, exec, state.visibleAssistantTextByTimestamp, previousItems)) {
      syncReviewState(state, ctx, state.activeData.items);
    }

  };
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const text = extractAssistantText(event.message.content);
    const timestamp = event.message.timestamp;
    if (text === undefined || (typeof timestamp !== "number" && typeof timestamp !== "string")) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (state.visibleAssistantSessionId !== sessionId) {
      state.visibleAssistantTextByTimestamp.clear();
      state.visibleAssistantSessionId = sessionId;
    }
    state.visibleAssistantTextByTimestamp.set(String(timestamp), text);
    const activeData = state.activeData;
    if (!activeData) return;
    ctx.setTimeout(() => {
      if (state.activeData !== activeData) return;
      void refreshData(pi, ctx, activeData, exec, state.visibleAssistantTextByTimestamp).then(refreshed => {
        if (refreshed) syncReviewState(state, ctx, activeData.items);
      }).catch(error => {
        notify(ctx, `Unable to refresh assistant text: ${messageForError(error)}`, "error");
      });
    }, 0);
  });
  pi.on("message_start", (event, ctx) => {
    const pending = state.pendingDispatch;
    if (!pending || event.message.role !== "user") return;
    if (pending.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (!isDispatchConfirmation(event.message.content, pending.content)) return;
    const branchEntries = currentBranch(ctx);
    if (pending.baseLeafId !== null && !branchEntries.some(entry => entry.id === pending.baseLeafId)) {
      state.pendingDispatch = undefined;
      notify(ctx, "Annotation delivery reached a different branch; annotations remain pending.", "error");
      return;
    }
    const branchItems = restoreReviewItems(branchEntries);
    if (!pending.itemIds.every(itemId => branchItems.some(item => item.id === itemId && item.status === "pending"))) {
      state.pendingDispatch = undefined;
      notify(ctx, "Annotation delivery reached a different branch; annotations remain pending.", "error");
      return;
    }
    pending.data.items = branchItems;
    state.pendingDispatch = undefined;
    markDispatchSent(pi, ctx, pending, state);
  });
  pi.on("agent_end", (event, ctx) => {
    const pending = state.pendingDispatch;
    if (!pending || event.willContinue === true) return;
    if (pending.sessionId !== ctx.sessionManager.getSessionId()) return;
    state.pendingDispatch = undefined;
    notify(ctx, "Annotation delivery did not reach the current agent; annotations remain pending.", "error");
  });
  pi.on("session_start", restoreActiveBranch);
  pi.on("session_tree", restoreActiveBranch);
  pi.on("session_branch", restoreActiveBranch);
  pi.on("session_switch", restoreActiveBranch);
  pi.registerCommand("annotate", {
    description: "Review Git changes and assistant text with annotations",
    handler: async (_args, ctx) => openAnnotate(pi, ctx, state, exec),
  });
}
