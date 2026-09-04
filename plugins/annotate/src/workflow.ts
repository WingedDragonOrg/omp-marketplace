import {
  createAssistantAnchor,
  extractAssistantText,
  validateAssistantAnchor,
  validateCodeAnchor,
  type AnchorValidation,
  type AssistantAnchor,
  type AssistantTextEntry,
  type CodeSnapshot,
  type ReviewItem,
} from "./model";
export interface ValidationContext {
  sessionId: string;
  branchEntries: readonly unknown[];
  codeSnapshot: CodeSnapshot | undefined;
  visibleTextByTimestamp?: ReadonlyMap<string, string>;
}

export interface PendingValidation {
  valid: ReviewItem[];
  stale: Array<{ item: ReviewItem; reason: string }>;
}

function staleItem(item: ReviewItem, validation: Extract<AnchorValidation, { kind: "stale" }>): ReviewItem {
  return { ...item, status: "stale", staleReason: validation.reason };
}

export interface AssistantAnnotationDraft {
  anchor: AssistantAnchor;
  body: string;
}

/** Create a direct annotation for the selected assistant message. */
export function createAssistantAnnotationDraft(
  sessionId: string,
  entry: Pick<AssistantTextEntry, "id" | "text">,
  body: string,
): AssistantAnnotationDraft | null {
  const trimmedBody = body.trim();
  if (!sessionId || !entry.id || !entry.text || !trimmedBody) return null;
  const anchor = createAssistantAnchor({
    sessionId,
    entryId: entry.id,
    messageText: entry.text,
    start: 0,
    end: entry.text.length,
  });
  return anchor ? { anchor, body: trimmedBody } : null;
}

/** Validate only pending items and split safe dispatches from stale history. */
export function validatePendingItems(
  items: readonly ReviewItem[],
  context: ValidationContext,
): PendingValidation {
  const valid: ReviewItem[] = [];
  const stale: Array<{ item: ReviewItem; reason: string }> = [];

  for (const item of items) {
    if (item.status !== "pending") continue;
    let validation: AnchorValidation;
    if (item.anchor.kind === "code") {
      validation =
        context.codeSnapshot === undefined
          ? { kind: "stale", reason: "repository-changed" }
          : validateCodeAnchor(item.anchor, context.codeSnapshot);
    } else {
      validation = validateAssistantAnchor(item.anchor, context.branchEntries, context.sessionId, context.visibleTextByTimestamp);
    }

    if (validation.kind === "valid") {
      valid.push(item);
    } else {
      stale.push({ item: staleItem(item, validation), reason: validation.reason });
    }
  }

  return { valid, stale };
}

export function isDispatchConfirmation(content: unknown, expected: string): boolean {
  return extractAssistantText(content) === expected;
}

export function carryMissingReviewItems(
  current: readonly ReviewItem[],
  previous: readonly ReviewItem[],
  deletedIds?: ReadonlySet<string>,
): ReviewItem[] {
  const ids = new Set(current.map(item => item.id));
  const result = [...current];
  for (const item of previous) {
    if (ids.has(item.id) || deletedIds?.has(item.id)) continue;
    result.push({ ...item, status: "stale", staleReason: "entry-not-in-current-branch" });
    ids.add(item.id);
  }
  return result;
}
