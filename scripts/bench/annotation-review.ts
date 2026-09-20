/**
 * Offline benchmark cases for two production review hot paths.
 *
 * annotate: unified-diff parsing with code-anchor validation, and long session-branch annotation
 * restore with assistant-anchor validation over Unicode messages.
 * octo-developer: review snapshot reduction (stale-head approvals, approval withdrawal, change
 * requests) with whole-state fingerprints.
 *
 * Fixtures are index arithmetic over fixed constants: no clock input, no randomness, no I/O and no
 * adaptive bounds, so every round runs identical work and returns an identical checksum folded from
 * the real outputs of the measured code. Assertions live in verify(), never in the timed run.
 */
import {
  REVIEW_CUSTOM_TYPE,
  REVIEW_SCHEMA_VERSION,
  collectAssistantTextEntries,
  createAssistantAnchor,
  createCodeAnchor,
  deletedReviewItemIds,
  parseUnifiedDiff,
  restoreReviewItems,
  validateAssistantAnchor,
  validateCodeAnchor,
} from "../../plugins/annotate/src/model";
import type { AnchorValidation, CodeSnapshot, DiffLineKind, ReviewItem } from "../../plugins/annotate/src/model";
import { applyReviewSnapshot, createReviewState, reviewStateFingerprint } from "../../plugins/octo-developer/src/review";
import type { ReviewRecord, ReviewSnapshot, ReviewState } from "../../plugins/octo-developer/src/review";
import type { BenchmarkCase } from "./types";

function assertSame(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, received ${left}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Wrap one persisted review event so every entry in the log has the same shape. */
function customEvent(data: unknown): unknown {
  return { type: "custom", customType: REVIEW_CUSTOM_TYPE, data };
}

const CHECKSUM_SEED = 0x811c9dc5;

/** FNV-1a fold; one mixing constant shared by every case's checksum. */
function foldNumber(hash: number, value: number): number {
  return Math.imul(hash ^ (value >>> 0), 0x01000193) >>> 0;
}

function foldText(hash: number, text: string): number {
  let next = foldNumber(hash, text.length);
  for (let index = 0; index < text.length; index += 1) next = foldNumber(next, text.charCodeAt(index));
  return next;
}

/** Stride a long string so folding a whole state stays cheaper than the work it measures. */
function foldTextSampled(hash: number, text: string, stride: number): number {
  let next = foldNumber(hash, text.length);
  for (let index = 0; index < text.length; index += stride) next = foldNumber(next, text.charCodeAt(index));
  return foldNumber(next, text.length === 0 ? 0 : text.charCodeAt(text.length - 1));
}

function foldValidation(hash: number, validation: AnchorValidation): number {
  return validation.kind === "valid" ? foldNumber(hash, 0x9e3779b9) : foldText(foldNumber(hash, 0x85ebca6b), validation.reason);
}

function isoTimestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 8, 11, 0, 0, 0) + offsetSeconds * 1000).toISOString();
}

// ============================================================================================
// annotate: unified diff parsing + code anchor creation/validation
// ============================================================================================

const DIFF_FILE_COUNT = 150;
const DIFF_HUNK_GAP = 7;
const DIFF_ANCHOR_SPAN = 6;
const DIFF_HEAD_OID = "8f3c1d0e5a4b2c9f7e6d5c4b3a2918070605040302010ffeeddccbbaa998877";
/** One hunk body: twelve context lines, three deletions, five additions, eighteen trailing context. */
const DIFF_HUNK_BODY: readonly DiffLineKind[] = [
  ...Array<DiffLineKind>(12).fill("context"),
  ...Array<DiffLineKind>(3).fill("deletion"),
  ...Array<DiffLineKind>(5).fill("addition"),
  ...Array<DiffLineKind>(18).fill("context"),
];

/** [oldLine, newLine, content] per emitted diff line; 0 marks the side the line does not exist on. */
type GeneratedLine = [number, number, string];

interface DiffFixture {
  text: string;
  lineCount: number;
  files: Array<{ path: string; lines: GeneratedLine[] }>;
  snapshot: CodeSnapshot;
}

function buildDiffFixture(): DiffFixture {
  const chunks: string[] = [];
  const files: Array<{ path: string; lines: GeneratedLine[] }> = [];
  let lineCount = 0;
  const emit = (line: string): void => {
    chunks.push(line);
    lineCount += 1;
  };

  for (let fileIndex = 0; fileIndex < DIFF_FILE_COUNT; fileIndex += 1) {
    const path = `src/feature-${fileIndex}/module-${fileIndex}.ts`;
    emit(`diff --git a/${path} b/${path}`);
    emit(`--- a/${path}`);
    emit(`+++ b/${path}`);
    const lines: GeneratedLine[] = [];
    let oldCursor = 1;
    let newCursor = 1;
    for (let hunkIndex = 0; hunkIndex < 4; hunkIndex += 1) {
      oldCursor += DIFF_HUNK_GAP;
      newCursor += DIFF_HUNK_GAP;
      const oldStart = oldCursor;
      const newStart = newCursor;
      const body: string[] = [];
      for (const kind of DIFF_HUNK_BODY) {
        const onOldSide = kind !== "addition";
        const number = onOldSide ? oldCursor : newCursor;
        const content = `export const ${kind === "addition" ? "added" : "value"}_${fileIndex}_${number} = ${(number * 37 + fileIndex * 11) % 997};`;
        lines.push([onOldSide ? oldCursor : 0, kind === "deletion" ? 0 : newCursor, content]);
        body.push(`${kind === "context" ? " " : kind === "addition" ? "+" : "-"}${content}`);
        if (onOldSide) oldCursor += 1;
        if (kind !== "deletion") newCursor += 1;
      }
      emit(`@@ -${oldStart},${oldCursor - oldStart} +${newStart},${newCursor - newStart} @@ function feature${fileIndex}Step${hunkIndex}()`);
      for (const line of body) emit(line);
    }
    files.push({ path, lines });
  }

  const text = chunks.join("\n");
  return {
    text,
    lineCount,
    files,
    snapshot: { root: "/repo/omp-marketplace", repositoryId: "repo-bench", headOid: DIFF_HEAD_OID, diffFingerprint: "diff-fingerprint-7ac1", files: parseUnifiedDiff(text) },
  };
}

let diffFixtureCache: DiffFixture | undefined;

function diffFixture(): DiffFixture {
  diffFixtureCache ??= buildDiffFixture();
  return diffFixtureCache;
}

const LITERAL_DIFF = [
  "diff --git a/app.ts b/app.ts",
  "index 1111111..2222222 100644",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,3 +1,4 @@ function boot() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
].join("\n");

const diffCase: BenchmarkCase = {
  name: "annotate_unified_diff_anchor_validation",
  get operations(): number {
    return diffFixture().lineCount;
  },
  setup(): void {
    diffFixture();
  },
  run(): number {
    const fixture = diffFixture();
    const parsed = parseUnifiedDiff(fixture.text);
    const byPath = new Map(parsed.map(file => [file.path, file]));
    const moved: CodeSnapshot = { ...fixture.snapshot, diffFingerprint: "diff-fingerprint-moved" };
    let hash = foldNumber(CHECKSUM_SEED, parsed.length);

    for (let index = 0; index < fixture.files.length; index += 1) {
      const record = fixture.files[index]!;
      const file = byPath.get(record.path);
      if (!file) {
        hash = foldNumber(hash, 0x5bf03635);
        continue;
      }
      hash = foldText(hash, file.path);
      for (const hunk of file.hunks) {
        hash = foldNumber(hash, hunk.oldStart + hunk.newStart * 31 + hunk.oldCount * 131 + hunk.newCount * 271);
        hash = foldNumber(hash, hunk.lines.length);
        for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex += 1) {
          const line = hunk.lines[lineIndex]!;
          hash = foldNumber(hash, (line.oldLine ?? 0) + (line.newLine ?? 0) * 7 + line.content.length * 13);
          if (lineIndex % 8 === 0) hash = foldText(hash, line.content);
        }
      }
      const last = file.hunks[file.hunks.length - 1]!;
      const offset = 3 + (index % 8);
      const anchor = createCodeAnchor(
        fixture.snapshot,
        file.path,
        last.lines.slice(offset, offset + DIFF_ANCHOR_SPAN),
        index % 3 === 0 ? { startOffset: 2, endOffset: 2 + DIFF_ANCHOR_SPAN * 20 } : undefined,
      );
      if (!anchor) {
        hash = foldNumber(hash, 0x27d4eb2f);
        continue;
      }
      hash = foldValidation(hash, validateCodeAnchor(anchor, fixture.snapshot));
      hash = foldValidation(hash, validateCodeAnchor(anchor, moved));
      hash = foldValidation(hash, validateCodeAnchor({ ...anchor, selectedText: `${anchor.selectedText}!` }, fixture.snapshot));
      hash = foldNumber(hash, anchor.oldStart * 3 + anchor.oldEnd * 5 + anchor.newStart * 7 + anchor.newEnd * 11);
      hash = foldText(hash, anchor.selectedText);
    }
    return hash >>> 0;
  },
  verify(): void {
    const fixture = diffFixture();
    const literal = parseUnifiedDiff(LITERAL_DIFF);
    const hunk = literal[0]!.hunks[0]!;
    const literalSnapshot: CodeSnapshot = { ...fixture.snapshot, files: literal };
    const anchor = createCodeAnchor(literalSnapshot, "app.ts", hunk.lines.slice(1, 4));
    assert(anchor !== null, "the selected deletion plus additions produce an anchor");
    assertSame(
      {
        numbering: { oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount, header: hunk.header },
        lines: hunk.lines.map(line => [line.kind, line.content, line.oldLine ?? null, line.newLine ?? null]),
        anchor: { oldStart: anchor.oldStart, oldEnd: anchor.oldEnd, newStart: anchor.newStart, newEnd: anchor.newEnd, selectedText: anchor.selectedText },
        valid: validateCodeAnchor(anchor, literalSnapshot).kind,
        tampered: validateCodeAnchor({ ...anchor, selectedText: "const b = 9;" }, literalSnapshot),
        movedHead: validateCodeAnchor({ ...anchor, headOid: "0".repeat(40) }, literalSnapshot),
      },
      {
        numbering: { oldStart: 1, oldCount: 3, newStart: 1, newCount: 4, header: "function boot() {" },
        lines: [["context", "const a = 1;", 1, 1], ["deletion", "const b = 2;", 2, null], ["addition", "const b = 3;", null, 2], ["addition", "const c = 4;", null, 3], ["context", "export { a };", 3, 4]],
        anchor: { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3, selectedText: "const b = 2;\nconst b = 3;\nconst c = 4;" },
        valid: "valid",
        tampered: { kind: "stale", reason: "text-mismatch" },
        movedHead: { kind: "stale", reason: "snapshot-changed" },
      },
      "a hand-checked diff yields exact hunk numbering, line numbers, line content, selection bounds and staleness",
    );

    const parsed = parseUnifiedDiff(fixture.text);
    assertSame(parsed.length, fixture.files.length, "every generated file survives parsing");
    assertSame(
      {
        files: parsed.slice(0, 4).map(file => file.path),
        lines: parsed
          .flatMap(file => file.hunks)
          .flatMap(item => item.lines)
          .map(line => [line.oldLine ?? 0, line.newLine ?? 0, line.content])
          .slice(0, 300),
      },
      { files: fixture.files.slice(0, 4).map(record => record.path), lines: fixture.files.flatMap(record => record.lines).slice(0, 300) },
      "every parsed diff line carries the generated line number and content",
    );
  },
};

// ============================================================================================
// annotate: session-branch annotation restore + assistant anchor validation
// ============================================================================================

const BRANCH_MESSAGE_COUNT = 3400;
const BRANCH_NOISE_EVERY = 7;
const ANNOTATION_COUNT = 200;
const REDACTED_PROBE_INDEX = 1;
const ANCHOR_CONTEXT_RADIUS = 48;
const ANCHOR_START_BASE = 12;
const ANCHOR_START_STEP = 17;
const ANCHOR_LENGTH = 16;
const RAW_SECRET = "token $$TOKEN1234$$";
const DISPLAYED_SECRET = "token [redacted]";
const BRANCH_SESSION_ID = "session-bench-1";

/** Six pairs of lines carrying CJK, combining accents, a skin-toned emoji and a ZWJ family. */
function branchMessageText(index: number): string {
  const lines: string[] = [];
  for (let line = 0; line < 6; line += 1) {
    lines.push(`段 ${index}-${line}: 校验 e\u0301 与 👍🏽 以及 文${(index + line) % 97} 的偏移`);
    lines.push(`check ${index}-${line} cafe\u0301 👨👩👧 ${(line * 31 + index * 7) % 997} end`);
  }
  return lines.join("\n");
}

function assistantAnchorOf(item: ReviewItem, label: string) {
  if (item.anchor.kind !== "assistant") throw new Error(`benchmark ${label} is an assistant anchor`);
  return item.anchor;
}

interface BranchMessage {
  id: string;
  rawText: string;
  displayedText?: string;
}

interface BranchFixture {
  branchEntries: unknown[];
  mutatedEntries: unknown[];
  visibleTextByTimestamp: Map<string, string>;
  annotationEntries: unknown[];
  anchors: Array<{ message: BranchMessage; item: ReviewItem }>;
  deletedIds: string[];
  aliveIds: string[];
  redactedItem: ReviewItem;
  redactedMessage: BranchMessage;
  editedItem: ReviewItem;
}

function buildBranchFixture(): BranchFixture {
  const branchEntries: unknown[] = [];
  const messages: BranchMessage[] = [];
  const visibleTextByTimestamp = new Map<string, string>();

  for (let index = 0; index < BRANCH_MESSAGE_COUNT; index += 1) {
    const timestamp = isoTimestamp(index * 60);
    const body = branchMessageText(index);
    const hidden = index % 37 === 5;
    const message: BranchMessage = { id: `entry-${index}`, rawText: hidden ? `${RAW_SECRET} ${body}` : body, ...(hidden ? { displayedText: `${DISPLAYED_SECRET} ${body}` } : {}) };
    messages.push(message);
    if (message.displayedText !== undefined) visibleTextByTimestamp.set(timestamp, message.displayedText);
    if (index % BRANCH_NOISE_EVERY === 3) {
      branchEntries.push({ type: "message", id: `prompt-${index}`, timestamp, message: { role: "user", timestamp, content: [{ type: "text", text: `prompt ${index}` }] } });
    }
    branchEntries.push({
      type: "message",
      id: message.id,
      timestamp,
      message: { role: "assistant", timestamp, content: [{ type: "thinking", thinking: `plan ${index}` }, { type: "text", text: message.rawText }] },
    });
  }

  const annotationEntries: unknown[] = [];
  const anchors: Array<{ message: BranchMessage; item: ReviewItem }> = [];
  const deletedIds: string[] = [];
  const aliveIds: string[] = [];
  let redactedItem: ReviewItem | undefined;

  for (let index = 0; index < ANNOTATION_COUNT; index += 1) {
    let target = messages[5]!;
    if (index !== REDACTED_PROBE_INDEX) {
      let cursor = (index * 11 + 6) % messages.length;
      while (messages[cursor]!.displayedText !== undefined) cursor = (cursor + 1) % messages.length;
      target = messages[cursor]!;
    }
    const start = ANCHOR_START_BASE + (index * ANCHOR_START_STEP) % 120;
    const anchor = createAssistantAnchor({
      sessionId: BRANCH_SESSION_ID,
      entryId: target.id,
      messageText: target.displayedText ?? target.rawText,
      start,
      end: start + ANCHOR_LENGTH,
      contextRadius: ANCHOR_CONTEXT_RADIUS,
    });
    assert(anchor !== null, `annotation ${index} must anchor inside its message`);
    const item: ReviewItem = { schemaVersion: REVIEW_SCHEMA_VERSION, id: `note-${index}`, source: "assistant", anchor, body: `review note ${index}`, createdAt: isoTimestamp(index * 30), status: "pending" };
    if (index === REDACTED_PROBE_INDEX) redactedItem = item;
    else anchors.push({ message: target, item });
    annotationEntries.push(customEvent({ action: "upsert", item }));
    // every fifth annotation is withdrawn immediately, every ninth later; note-4 is withdrawn then re-added
    const withdrawn = index % 5 === 2 || (index % 9 === 4 && index !== 4);
    if (withdrawn) deletedIds.push(item.id);
    else aliveIds.push(item.id);
    if (index % 5 === 2) annotationEntries.push(customEvent({ action: "delete", id: item.id }));
  }
  for (let index = 0; index < ANNOTATION_COUNT; index += 1) {
    if (index % 9 === 4) annotationEntries.push(customEvent({ action: "delete", id: `note-${index}` }));
  }
  annotationEntries.push(customEvent({ action: "upsert", item: anchors.find(entry => entry.item.id === "note-4")!.item }));
  annotationEntries.push(customEvent({ action: "upsert", item: { id: "note-broken" } }));
  annotationEntries.push(customEvent({ action: "delete", id: "" }));
  annotationEntries.push(customEvent("not-an-object"));

  const editedEntryId = anchors[0]!.message.id;
  const mutatedEntries = branchEntries.map(entry => {
    const record = entry as { id?: unknown; message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
    const message = record.message;
    if (record.id !== editedEntryId || message === undefined || message.role !== "assistant") return entry;
    const content = (message.content ?? []).map(block =>
      block.type === "text" && typeof block.text === "string" ? { ...block, text: `ZZZ${block.text}` } : block,
    );
    return { ...record, message: { ...message, content } };
  });

  assert(redactedItem !== undefined, "benchmark fixture keeps the redacted-message probe annotation");
  return {
    branchEntries,
    mutatedEntries,
    visibleTextByTimestamp,
    annotationEntries,
    anchors,
    deletedIds,
    aliveIds,
    redactedItem,
    redactedMessage: messages[5]!,
    editedItem: anchors[0]!.item,
  };
}

let branchFixtureCache: BranchFixture | undefined;

function branchFixture(): BranchFixture {
  branchFixtureCache ??= buildBranchFixture();
  return branchFixtureCache;
}

function validateAgainstBranch(fixture: BranchFixture, item: ReviewItem, label: string, entries = fixture.branchEntries) {
  return validateAssistantAnchor(assistantAnchorOf(item, label), entries, BRANCH_SESSION_ID, fixture.visibleTextByTimestamp);
}

const branchCase: BenchmarkCase = {
  name: "annotate_session_branch_restore_anchor_validation",
  get operations(): number {
    const fixture = branchFixture();
    return fixture.branchEntries.length + fixture.annotationEntries.length;
  },
  setup(): void {
    branchFixture();
  },
  run(): number {
    const fixture = branchFixture();
    let invalidEvents = 0;
    const restored = restoreReviewItems(fixture.annotationEntries, () => {
      invalidEvents += 1;
    });
    const deleted = deletedReviewItemIds(fixture.annotationEntries);
    const collected = collectAssistantTextEntries(fixture.branchEntries, fixture.visibleTextByTimestamp);
    let hash = foldNumber(CHECKSUM_SEED, restored.length + invalidEvents * 131 + collected.length * 31 + deleted.size * 7);

    for (const entry of collected) {
      hash = foldNumber(hash, entry.annotationAllowed ? 1 : 2);
      hash = foldText(hash, entry.id);
    }
    for (const item of restored) {
      if (item.anchor.kind !== "assistant") {
        hash = foldNumber(hash, 0x165667b1);
        continue;
      }
      const validation = validateAssistantAnchor(item.anchor, fixture.branchEntries, BRANCH_SESSION_ID, fixture.visibleTextByTimestamp);
      hash = foldValidation(hash, validation);
      hash = foldNumber(hash, item.anchor.start + item.anchor.end * 3);
      if (validation.kind === "valid") hash = foldText(hash, item.anchor.text);
    }

    hash = foldValidation(hash, validateAgainstBranch(fixture, fixture.editedItem, "edited annotation", fixture.mutatedEntries));
    hash = foldValidation(hash, validateAgainstBranch(fixture, fixture.redactedItem, "redacted annotation"));
    const base = assistantAnchorOf(fixture.editedItem, "edited annotation");
    hash = foldValidation(hash, validateAssistantAnchor({ ...base, before: `${base.before}X` }, fixture.branchEntries, BRANCH_SESSION_ID));
    hash = foldValidation(hash, validateAssistantAnchor(base, fixture.branchEntries, "session-other"));
    return hash >>> 0;
  },
  verify(): void {
    const fixture = branchFixture();
    const restored = restoreReviewItems(fixture.annotationEntries);
    const ids = restored.map(item => item.id).sort();
    let invalidEvents = 0;
    restoreReviewItems(fixture.annotationEntries, () => {
      invalidEvents += 1;
    });
    assertSame(
      {
        alive: ids,
        deleted: [...deletedReviewItemIds(fixture.annotationEntries)].sort(),
        invalidEvents,
        withdrawnImmediately: ids.includes("note-2"),
        resurrected: ids.includes("note-4"),
      },
      { alive: [...fixture.aliveIds].sort(), deleted: [...fixture.deletedIds].sort(), invalidEvents: 3, withdrawnImmediately: false, resurrected: true },
      "restore replays deletes and re-upserts, reports malformed events and never revives a withdrawn annotation",
    );

    const collected = collectAssistantTextEntries(fixture.branchEntries, fixture.visibleTextByTimestamp);
    const first = assistantAnchorOf(fixture.anchors[0]!.item, "annotation");
    const literalText = "第一行 e\u0301 👍🏽 结尾";
    const literal = createAssistantAnchor({ sessionId: BRANCH_SESSION_ID, entryId: "literal", messageText: literalText, start: 4, end: 6, contextRadius: 3 });
    assert(literal !== null, "a slice across a combining mark produces an anchor");
    assertSame(
      {
        assistantMessages: collected.length,
        kinds: fixture.anchors.map(entry => validateAgainstBranch(fixture, entry.item, "annotation").kind),
        anchorText: fixture.anchors[0]!.message.rawText.slice(first.start, first.end),
        evidenceSlice: collected.find(entry => entry.id === fixture.anchors[0]!.message.id)?.text.slice(first.start, first.end) ?? "missing",
        editedMessage: validateAgainstBranch(fixture, fixture.editedItem, "edited annotation", fixture.mutatedEntries),
        literal: { text: literal.text, before: literal.before, after: literal.after },
      },
      {
        assistantMessages: BRANCH_MESSAGE_COUNT,
        kinds: fixture.anchors.map(() => "valid"),
        anchorText: first.text,
        evidenceSlice: first.text,
        editedMessage: { kind: "stale", reason: "text-mismatch" },
        literal: { text: "e\u0301", before: "一行 ", after: " 👍" },
      },
      "annotations quote their message text in collected evidence, an edit invalidates one, and offsets are code-unit exact",
    );

    const redacted = collected.find(entry => entry.timestamp === isoTimestamp(300));
    assert(redacted !== undefined, "the redacted message is still collected for display");
    assertSame(
      {
        text: redacted.text,
        annotationAllowed: redacted.annotationAllowed,
        validation: validateAgainstBranch(fixture, fixture.redactedItem, "redacted annotation"),
      },
      { text: fixture.redactedMessage.displayedText, annotationAllowed: false, validation: { kind: "stale", reason: "text-mismatch" } },
      "a message hiding a secret shows only its displayed text and can never carry a valid annotation",
    );
  },
};

// ============================================================================================
// octo-developer: review reduction + state fingerprint
// ============================================================================================

const REVIEW_HEAD_A = "a".repeat(40);
const REVIEW_HEAD_B = "b".repeat(40);
const FILLER_REVIEWERS = 60;
const FILLER_REVIEWS_PER_REVIEWER = 16;
const ISSUE_COMMENT_COUNT = 300;
const REVIEW_COMMENT_COUNT = 420;
const THREAD_COUNT = 180;
const STATUS_CHECK_COUNT = 24;

/** [id, author, decision, head, submittedAt seconds] — one appended reviewer verdict. */
type TailRow = readonly [string, string, ReviewRecord["state"], string, number];

function reviewRecord(id: string, author: string, state: ReviewRecord["state"], commitSha: string, offsetSeconds: number): ReviewRecord {
  return {
    id,
    author,
    state,
    commitSha,
    body: `${state} by ${author}`,
    submittedAt: isoTimestamp(offsetSeconds),
    url: `https://github.com/Mininglamp-OSS/octo-server/pull/887#pullrequestreview-${id}`,
  };
}

function commentRecord(id: string, author: string, line: number, offsetSeconds: number) {
  const createdAt = isoTimestamp(offsetSeconds);
  return {
    id,
    author,
    body: `comment ${id} on line ${line}`,
    createdAt,
    updatedAt: createdAt,
    url: `https://github.com/Mininglamp-OSS/octo-server/pull/887#discussion_r${id}`,
    path: `internal/service/module-${line % 17}.go`,
    line,
  };
}

interface ReviewFixture {
  snapshots: ReviewSnapshot[];
  threadFlipped: ReviewSnapshot;
}

function buildReviewFixture(): ReviewFixture {
  const reviews: ReviewRecord[] = [];
  for (let round = 0; round < FILLER_REVIEWS_PER_REVIEWER; round += 1) {
    for (let reviewer = 0; reviewer < FILLER_REVIEWERS; reviewer += 1) {
      const state: ReviewRecord["state"] = round === FILLER_REVIEWS_PER_REVIEWER - 1 ? "DISMISSED" : round % 2 === 0 ? "APPROVED" : "CHANGES_REQUESTED";
      // filler verdicts all share offset 0, so the newest submission by each reviewer wins the tie
      reviews.push(reviewRecord(`filler-${round}-${reviewer}`, `reviewer-${reviewer}`, state, round % 3 === 0 ? REVIEW_HEAD_A : REVIEW_HEAD_B, 0));
    }
  }
  const issueComments = Array.from({ length: ISSUE_COMMENT_COUNT }, (_unused, index) => commentRecord(`issue-${index}`, `author-${index % 31}`, index % 200, 10_000 + index * 45));
  const reviewComments = Array.from({ length: REVIEW_COMMENT_COUNT }, (_unused, index) => commentRecord(`inline-${index}`, `reviewer-${index % FILLER_REVIEWERS}`, index % 400, 20_000 + index * 37));
  const threads = Array.from({ length: THREAD_COUNT }, (_unused, index) => ({
    id: `thread-${index}`,
    path: `internal/service/module-${index % 17}.go`,
    line: index,
    isResolved: index % 4 === 0,
    isBlocking: index % 11 === 0,
    comments: Array.from({ length: 3 }, (_unusedComment, commentIndex) => commentRecord(`${index}-${commentIndex}`, `reviewer-${index % FILLER_REVIEWERS}`, index, index * 60 + commentIndex)),
  }));
  const facts = {
    state: "OPEN" as const,
    mergeable: "MERGEABLE" as const,
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: Array.from({ length: STATUS_CHECK_COUNT }, (_unused, index) => ({
      context: `ci/${["unit", "lint", "build", "e2e", "vet", "gofmt"][index % 6]}`,
      state: index === 7 ? "PENDING" : "SUCCESS",
      detailsUrl: `https://ci.example.com/octo-server/runs/${index}`,
    })),
  };
  // old-head approvals plus a refusal nobody withdraws, a push that drops them, the objector's
  // approval, and finally a withdrawal that leaves one approval and a fresh refusal behind
  const tails: readonly (readonly TailRow[])[] = [
    [
      ["tail-a1", "alice", "APPROVED", REVIEW_HEAD_A, 30_000],
      ["tail-a2", "bob", "APPROVED", REVIEW_HEAD_A, 30_060],
      ["tail-a3", "carol", "CHANGES_REQUESTED", REVIEW_HEAD_A, 30_120],
      ["tail-a4", "erin", "CHANGES_REQUESTED", REVIEW_HEAD_A, 30_180],
      ["tail-a5", "erin", "COMMENTED", REVIEW_HEAD_A, 30_240],
    ],
    [
      ["tail-b1", "alice", "APPROVED", REVIEW_HEAD_A, 30_300],
      ["tail-b2", "bob", "APPROVED", REVIEW_HEAD_B, 30_360],
      ["tail-b3", "carol", "DISMISSED", REVIEW_HEAD_B, 30_420],
    ],
    [
      ["tail-c1", "alice", "APPROVED", REVIEW_HEAD_A, 30_480],
      ["tail-c2", "bob", "APPROVED", REVIEW_HEAD_B, 30_540],
      ["tail-c3", "carol", "APPROVED", REVIEW_HEAD_B, 30_600],
    ],
    [
      ["tail-d1", "alice", "APPROVED", REVIEW_HEAD_A, 30_660],
      ["tail-d2", "bob", "APPROVED", REVIEW_HEAD_B, 30_720],
      ["tail-d3", "dave", "APPROVED", REVIEW_HEAD_B, 30_780],
      ["tail-d4", "dave", "DISMISSED", REVIEW_HEAD_B, 30_840],
      ["tail-d5", "carol", "CHANGES_REQUESTED", REVIEW_HEAD_B, 30_900],
    ],
  ];

  const snapshot = (headSha: string, rows: readonly TailRow[], resolvedThreadId?: string): ReviewSnapshot => ({
    headSha,
    pullRequest: { ...facts },
    reviews: [...reviews, ...rows.map(([id, author, state, head, at]) => reviewRecord(id, author, state, head, at))],
    issueComments: [...issueComments],
    reviewComments: [...reviewComments],
    threads: threads.map(thread => (thread.id === resolvedThreadId ? { ...thread, isResolved: true } : thread)),
  });

  return {
    snapshots: [
      snapshot(REVIEW_HEAD_A, tails[0]!),
      snapshot(REVIEW_HEAD_B, tails[1]!),
      snapshot(REVIEW_HEAD_B, tails[2]!),
      snapshot(REVIEW_HEAD_B, tails[3]!),
    ],
    threadFlipped: snapshot(REVIEW_HEAD_B, tails[2]!, "thread-1"),
  };
}

let reviewFixtureCache: ReviewFixture | undefined;

function reviewFixture(): ReviewFixture {
  reviewFixtureCache ??= buildReviewFixture();
  return reviewFixtureCache;
}

function reduceSnapshots(requiredApprovals: number, snapshots: readonly ReviewSnapshot[]): ReviewState[] {
  let state = createReviewState({ requiredApprovals });
  const states = [state];
  for (const next of snapshots) states.push((state = applyReviewSnapshot(state, next)));
  return states;
}

const reviewCase: BenchmarkCase = {
  name: "octo_developer_review_reduction_and_fingerprint",
  get operations(): number {
    const first = reviewFixture().snapshots[0]!;
    return first.reviews.length + first.issueComments.length + first.reviewComments.length + first.threads.length;
  },
  setup(): void {
    reviewFixture();
  },
  run(): number {
    const fixture = reviewFixture();
    let hash = foldNumber(CHECKSUM_SEED, fixture.snapshots.length);
    for (const state of reduceSnapshots(2, fixture.snapshots)) {
      hash = foldNumber(hash, (state.ready ? 1 : 0) + state.approvals.length * 3 + state.changesRequested.length * 7);
      hash = foldNumber(hash, state.reviews.length * 13 + state.issueComments.length * 17 + state.reviewComments.length * 19 + state.threads.length * 23);
      hash = foldTextSampled(hash, reviewStateFingerprint(state), 7);
    }
    for (const state of reduceSnapshots(2, [...fixture.snapshots.slice(0, 3), fixture.threadFlipped])) {
      hash = foldTextSampled(hash, reviewStateFingerprint(state), 11);
    }
    return hash >>> 0;
  },
  verify(): void {
    const fixture = reviewFixture();
    const [, oldHead, newHead, approved, refused] = reduceSnapshots(2, fixture.snapshots);
    assert(oldHead !== undefined && newHead !== undefined && approved !== undefined && refused !== undefined, "all snapshots reduce");
    assertSame(
      {
        oldHead: { head: oldHead.headSha, ready: oldHead.ready, approvals: oldHead.approvals.map(item => item.author), changes: oldHead.changesRequested.map(item => item.author) },
        newHead: {
          head: newHead.headSha,
          ready: newHead.ready,
          approvals: newHead.approvals.map(item => item.author),
          changes: newHead.changesRequested.length,
          unresolvedThreads: newHead.threads.filter(thread => !thread.isResolved).length,
        },
        approved: { ready: approved.ready, approvals: approved.approvals.map(item => item.author) },
        refused: { ready: refused.ready, approvals: refused.approvals.map(item => item.author), changes: refused.changesRequested.map(item => item.author) },
        keepsFullEvidence: refused.reviews.length === fixture.snapshots[0]!.reviews.length,
      },
      {
        oldHead: { head: REVIEW_HEAD_A, ready: false, approvals: ["alice", "bob"], changes: ["carol", "erin"] },
        newHead: { head: REVIEW_HEAD_B, ready: false, approvals: ["bob"], changes: 0, unresolvedThreads: THREAD_COUNT - THREAD_COUNT / 4 },
        approved: { ready: true, approvals: ["bob", "carol"] },
        refused: { ready: false, approvals: ["bob"], changes: ["carol"] },
        keepsFullEvidence: true,
      },
      "approvals bind to a head, a dismissal clears or withdraws a verdict, a plain comment keeps a refusal, and evidence is kept whole",
    );

    const flipped = reduceSnapshots(2, [...fixture.snapshots.slice(0, 3), fixture.threadFlipped]).at(-1)!;
    assertSame(
      {
        repeatIsStable: reviewStateFingerprint(approved) === reviewStateFingerprint(reduceSnapshots(2, fixture.snapshots)[3]!),
        threadFlipChangesFingerprint: reviewStateFingerprint(flipped) !== reviewStateFingerprint(approved),
        threadFlipKeepsReadiness: flipped.ready === approved.ready,
        unresolvedThreadsCarried: flipped.threads.some(thread => !thread.isResolved),
      },
      { repeatIsStable: true, threadFlipChangesFingerprint: true, threadFlipKeepsReadiness: true, unresolvedThreadsCarried: true },
      "the same evidence reproduces one fingerprint, resolving a thread produces a new one, and readiness stays approval-driven",
    );
  },
};

export const cases: BenchmarkCase[] = [diffCase, branchCase, reviewCase];
