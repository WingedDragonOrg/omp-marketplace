import { describe, expect, test } from "bun:test";
import { carryMissingReviewItems, createAssistantAnnotationDraft, isDispatchConfirmation, validatePendingItems } from "./src/workflow";
import { readGitCommits, readGitSnapshot, readGitSnapshotAtCommit } from "./src/git";
import {
  applyReviewEvent,
  buildReviewMessage,
  collectAssistantTextEntries,
  createAssistantAnchor,
  createCodeAnchor,
  deletedReviewItemIds,
  editReviewItem,
  extractAssistantText,
  parseUnifiedDiff,
  restoreReviewItems,
  validateAssistantAnchor,
  validateCodeAnchor,
} from "./src/model";
import type { GitCommandResult } from "./src/git";
import type {
  AssistantAnchor,
  CodeAnchor,
  CodeSnapshot,
  DiffFile,
  ReviewEvent,
  ReviewItem,
} from "./src/model";

const assistantEntry = (id: string, content: unknown) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-09-04T00:00:00.000Z",
  message: { role: "assistant", content },
});

const diff = [
  "diff --git a/src/demo.ts b/src/demo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,2 +1,3 @@",
  " const before = true;",
  "+const reviewed = true;",
  " const after = true;",
].join("\n");

const snapshot: CodeSnapshot = {
  root: "/tmp/project",
  repositoryId: "/tmp/project/.git",
  headOid: "abc123",
  diffFingerprint: "fingerprint-1",
  files: parseUnifiedDiff(diff),
};

function codeItem(file: DiffFile): ReviewItem & { source: "code"; anchor: CodeAnchor } {
  const anchor = createCodeAnchor(snapshot, file.path, file.hunks[0]!.lines.slice(1, 2));
  if (!anchor) throw new Error("test fixture did not produce an anchor");
  return {
    schemaVersion: 1,
    id: "code-1",
    source: "code",
    anchor,
    body: "Keep this value explicit.",
    createdAt: "2026-09-04T00:01:00.000Z",
    status: "pending",
  };
}

describe("extractAssistantText", () => {
  test("joins visible text blocks and ignores images and tool calls", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "First paragraph." },
        { type: "image", data: "ignored" },
        { type: "toolCall", name: "read", arguments: {} },
        { type: "text", text: "Second paragraph." },
      ]),
    ).toBe("First paragraph.\nSecond paragraph.");
  });

  test("accepts a plain text content value and rejects non-text content", () => {
    expect(extractAssistantText("plain assistant text")).toBe("plain assistant text");
    expect(extractAssistantText(null)).toBeUndefined();
    expect(extractAssistantText([{ type: "image", data: "ignored" }])).toBeUndefined();
  });
});

describe("collectAssistantTextEntries", () => {
  test("collects visible assistant entries from the current branch only", () => {
    expect(
      collectAssistantTextEntries([
        assistantEntry("assistant-1", [{ type: "text", text: "Visible answer." }, { type: "toolCall", name: "read" }]),
        assistantEntry("assistant-2", [{ type: "image", data: "ignored" }]),
        { type: "message", id: "user-1", message: { role: "user", content: "user text" } },
      ]),
    ).toEqual([{ id: "assistant-1", timestamp: "2026-09-04T00:00:00.000Z", text: "Visible answer.", annotationAllowed: true }]);
  });
});

describe("assistant display overrides", () => {
  test("uses visible message-end text and hides unresolved secret placeholders", () => {
    const entry = {
      type: "message",
      id: "assistant-secret",
      timestamp: "2026-09-04T00:00:00.000Z",
      message: { role: "assistant", timestamp: 42, content: [{ type: "text", text: "$$TOKEN1234$$" }] },
    };
    expect(collectAssistantTextEntries([entry])).toEqual([]);
    expect(collectAssistantTextEntries([entry], new Map([["42", "Visible restored text."]]))).toEqual([
      { id: "assistant-secret", timestamp: "2026-09-04T00:00:00.000Z", text: "Visible restored text.", annotationAllowed: false },
    ]);
  });
});

  test("validates live deobfuscated text against the persisted assistant entry", () => {
    const visibleText = "Keep this visible text.";
    const anchor = createAssistantAnchor({
      sessionId: "session-1",
      entryId: "assistant-secret",
      messageText: visibleText,
      start: 0,
      end: visibleText.length,
    });
    expect(
      validateAssistantAnchor(
        anchor!,
        [{
          type: "message",
          id: "assistant-secret",
          message: { role: "assistant", timestamp: 42, content: [{ type: "text", text: "$$TOKEN1234$$" }] },
        }],
        "session-1",
        new Map([["42", visibleText]]),
      ),
    ).toEqual({ kind: "stale", reason: "text-mismatch" });
  });
describe("assistant anchors", () => {
  test("captures an exact selection with bounded context and validates it on the same branch", () => {
    const text = "Before the selected sentence. Keep this sentence. After the sentence.";
    const anchor = createAssistantAnchor({
      sessionId: "session-1",
      entryId: "assistant-1",
      messageText: text,
      start: text.indexOf("Keep"),
      end: text.indexOf("Keep") + "Keep this sentence.".length,
      contextRadius: 8,
    });
    expect(anchor).toEqual<AssistantAnchor>({
      kind: "assistant",
      sessionId: "session-1",
      entryId: "assistant-1",
      start: 30,
      end: 49,
      text: "Keep this sentence.",
      before: "ntence. ",
      after: " After t",
    });

    expect(
      validateAssistantAnchor(anchor!, [assistantEntry("assistant-1", [{ type: "text", text }])]),
    ).toEqual({ kind: "valid" });
  });

  test("marks an entry that moved out of the branch or changed text as stale", () => {
    const anchor = createAssistantAnchor({
      sessionId: "session-1",
      entryId: "assistant-1",
      messageText: "Review this paragraph.",
      start: 0,
      end: 6,
      contextRadius: 4,
    });
    expect(
      validateAssistantAnchor(anchor!, [assistantEntry("other-entry", [{ type: "text", text: "Review this paragraph." }])]),
    ).toEqual({ kind: "stale", reason: "entry-not-in-current-branch" });
    expect(
      validateAssistantAnchor(anchor!, [assistantEntry("assistant-1", [{ type: "text", text: "Changed paragraph." }])]),
    ).toEqual({ kind: "stale", reason: "text-mismatch" });
  });

  test("rejects empty and out-of-bounds selections", () => {
    expect(
      createAssistantAnchor({
        sessionId: "session-1",
        entryId: "assistant-1",
        messageText: "text",
        start: 2,
        end: 2,
      }),
    ).toBeNull();
    expect(
      createAssistantAnchor({
        sessionId: "session-1",
        entryId: "assistant-1",
        messageText: "text",
        start: -1,
        end: 2,
      }),
    ).toBeNull();
  });

  test("creates a whole-message annotation draft", () => {
    const draft = createAssistantAnnotationDraft(
      "session-1",
      { id: "assistant-1", text: "Assistant answer." },
      "  Improve this answer.  ",
    );
    expect(draft).toEqual({
      anchor: {
        kind: "assistant",
        sessionId: "session-1",
        entryId: "assistant-1",
        start: 0,
        end: 17,
        text: "Assistant answer.",
        before: "",
        after: "",
      },
      body: "Improve this answer.",
    });
  });
  test("creates a precise annotation draft from a selected range", () => {
    const text = "Before. Select this sentence. After.";
    const start = text.indexOf("Select");
    const end = start + "Select this sentence.".length;
    const draft = createAssistantAnnotationDraft(
      "session-1",
      { id: "assistant-1", text },
      "  Shorten this sentence.  ",
      { start, end },
    );

    expect(draft).toEqual({
      anchor: {
        kind: "assistant",
        sessionId: "session-1",
        entryId: "assistant-1",
        start,
        end,
        text: "Select this sentence.",
        before: "Before. ",
        after: " After.",
      },
      body: "Shorten this sentence.",
    });
  });
});

describe("unified diff anchors", () => {
  test("parses file, hunk, and old/new line positions", () => {
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/demo.ts");
    expect(files[0]!.hunks[0]!.oldStart).toBe(1);
    expect(files[0]!.hunks[0]!.newStart).toBe(1);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: "context", content: "const before = true;", oldLine: 1, newLine: 1 },
      { kind: "addition", content: "const reviewed = true;", newLine: 2 },
      { kind: "context", content: "const after = true;", oldLine: 2, newLine: 3 },
    ]);
  });

  test("keeps patch lines whose content resembles file headers", () => {
    const files = parseUnifiedDiff([
      "diff --git a/marker.txt b/marker.txt",
      "--- a/marker.txt",
      "+++ b/marker.txt",
      "@@ -1,2 +1,2 @@",
      "--- deletion-looking content",
      "+++ addition-looking content",
    ].join("\n"));
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: "deletion", content: "-- deletion-looking content", oldLine: 1 },
      { kind: "addition", content: "++ addition-looking content", newLine: 1 },
    ]);
  });

  test("decodes Git's quoted UTF-8 path escapes", () => {
    const files = parseUnifiedDiff([
      "diff --git \"caf\\303\\251.ts\" \"caf\\303\\251.ts\"",
      "--- \"caf\\303\\251.ts\"",
      "+++ \"caf\\303\\251.ts\"",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(files[0]!.path).toBe("café.ts");
  });

  test("validates a code anchor against its original repository snapshot", () => {
    const item = codeItem(snapshot.files[0]!);
    expect(validateCodeAnchor(item.anchor, snapshot)).toEqual({ kind: "valid" });
    expect(
      validateCodeAnchor(
        item.anchor,
        { ...snapshot, root: "/tmp/other-worktree" },
      ),
    ).toEqual({ kind: "stale", reason: "repository-changed" });
    expect(
      validateCodeAnchor(
        item.anchor,
        { ...snapshot, diffFingerprint: "changed" },
      ),
    ).toEqual({ kind: "stale", reason: "snapshot-changed" });
    expect(
      validateCodeAnchor(
        { ...item.anchor, selectedText: "const reviewed = false;" },
        snapshot,
      ),
    ).toEqual({ kind: "stale", reason: "text-mismatch" });
  });
  test("captures and validates a commit revision on historical code anchors", () => {
    const historicalCommitOid = "b".repeat(40);
    const historicalSnapshot = { ...snapshot, commitOid: historicalCommitOid };
    const anchor = createCodeAnchor(historicalSnapshot, snapshot.files[0]!.path, snapshot.files[0]!.hunks[0]!.lines.slice(1, 2));

    expect(anchor?.commitOid).toBe(historicalCommitOid);
    expect(validateCodeAnchor(anchor!, historicalSnapshot)).toEqual({ kind: "valid" });
    expect(validateCodeAnchor(anchor!, snapshot)).toEqual({ kind: "stale", reason: "snapshot-changed" });
  });
  test("captures and validates partial selections across multiple code lines", () => {
    const file = snapshot.files[0]!;
    const selectedLines = file.hunks[0]!.lines;
    const fullText = selectedLines.map(line => line.content).join("\n");
    const startOffset = 2;
    const endOffset = fullText.length - 2;
    const anchor = createCodeAnchor(snapshot, file.path, selectedLines, { startOffset, endOffset });

    expect(anchor?.startOffset).toBe(startOffset);
    expect(anchor?.endOffset).toBe(endOffset);
    expect(anchor?.selectedText).toBe(fullText.slice(startOffset, endOffset));
    expect(validateCodeAnchor(anchor!, snapshot)).toEqual({ kind: "valid" });
    expect(validateCodeAnchor({ ...anchor!, endOffset: endOffset + 1 }, snapshot)).toEqual({ kind: "stale", reason: "text-mismatch" });
    expect(createCodeAnchor(snapshot, file.path, selectedLines, { startOffset: 0, endOffset: 0 })).toBeNull();
  });
  test("edits a pending annotation body while preserving its code anchor", () => {
    const item = codeItem(snapshot.files[0]!);
    const updated = editReviewItem(item, "Use a clearer name.");

    expect(updated).toMatchObject({
      id: item.id,
      source: "code",
      anchor: item.anchor,
      body: "Use a clearer name.",
      status: "pending",
    });
    expect(editReviewItem(item, "   ")).toBeUndefined();
    expect(editReviewItem({ ...item, status: "sent" }, "Use a clearer name.")).toBeUndefined();
  });
  test("keeps binary files as browse-only entries", () => {
    const files = parseUnifiedDiff([
      "diff --git a/assets/image.bin b/assets/image.bin",
      "index 1111111..2222222",
      "Binary files a/assets/image.bin and b/assets/image.bin differ",
    ].join("\n"));
    expect(files).toEqual([
      { path: "assets/image.bin", oldPath: "assets/image.bin", binary: true, hunks: [] },
    ]);
  });

  test("treats gitlink submodule diffs as browse-only", () => {
    const files = parseUnifiedDiff([
      "diff --git a/vendor/lib b/vendor/lib",
      "old mode 160000",
      "new mode 160000",
      "--- a/vendor/lib",
      "+++ b/vendor/lib",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
    ].join("\n"));
    expect(files[0]).toEqual({
      path: "vendor/lib",
      oldPath: "vendor/lib",
      binary: true,
      gitlink: true,
      hunks: [],
    });
  });

  test("detects gitlinks from an index mode without old/new mode lines", () => {
    const files = parseUnifiedDiff([
      "diff --git a/vendor/lib b/vendor/lib",
      "index 1111111..2222222 160000",
      "--- a/vendor/lib",
      "+++ b/vendor/lib",
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
    ].join("\n"));
    expect(files[0]).toEqual({
      path: "vendor/lib",
      oldPath: "vendor/lib",
      binary: true,
      gitlink: true,
      hunks: [],
    });
  });

  test("keeps ordinary text lines that start like submodule markers", () => {
    const files = parseUnifiedDiff([
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1 +1 @@",
      "-Subproject commit is documented here",
      "+Subproject commit remains documented here",
    ].join("\n"));
    expect(files[0]!.binary).toBe(false);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(2);
  });
  test("preserves repository paths that begin with a or b", () => {
    const files = parseUnifiedDiff([
      "diff --git a/a/source.ts b/a/source.ts",
      "--- a/a/source.ts",
      "+++ b/a/source.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"));
    expect(files[0]!.path).toBe("a/source.ts");
  });
});


describe("readGitSnapshot", () => {
  test("reads repository identity, HEAD, and combined staged/unstaged diff with argv calls", async () => {
    const calls: string[][] = [];
    const exec = async (_cwd: string, args: string[]): Promise<GitCommandResult> => {
      calls.push(args);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { code: 0, stdout: "/tmp/project\n", stderr: "" };
      if (command === "rev-parse --git-common-dir") return { code: 0, stdout: "/tmp/project/.git\n", stderr: "" };
      if (command === "rev-parse HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (command === "diff --no-ext-diff --no-color --no-textconv --default-prefix --src-prefix=a/ --dst-prefix=b/ --unified=40 HEAD --") {
        return { code: 0, stdout: diff, stderr: "" };
      }
      throw new Error(`unexpected git call: ${command}`);
    };

    const result = await readGitSnapshot(exec, "/tmp/project");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.detail);
    expect(result.snapshot.root).toBe("/tmp/project");
    expect(result.snapshot.repositoryId).toBe("/tmp/project/.git");
    expect(result.snapshot.headOid).toBe("abc123");
    expect(result.snapshot.files[0]!.path).toBe("src/demo.ts");
    expect(result.snapshot.diffFingerprint).toHaveLength(64);
    expect(calls.every(args => Array.isArray(args))).toBe(true);
  });
  test("preserves whitespace in repository identity paths", async () => {
    const root = "/tmp/ project ";
    const commonDir = "/tmp/metadata .git ";
    const cwdCalls: string[] = [];
    const exec = async (cwd: string, args: string[]): Promise<GitCommandResult> => {
      cwdCalls.push(cwd);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { code: 0, stdout: `${root}\n`, stderr: "" };
      if (command === "rev-parse --git-common-dir") return { code: 0, stdout: `${commonDir}\n`, stderr: "" };
      if (command === "rev-parse HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (command === "diff --no-ext-diff --no-color --no-textconv --default-prefix --src-prefix=a/ --dst-prefix=b/ --unified=40 HEAD --") {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected git call: ${command}`);
    };

    const result = await readGitSnapshot(exec, "/tmp/project");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.detail);
    expect(result.snapshot.root).toBe(root);
    expect(result.snapshot.repositoryId).toBe(commonDir);
    expect(cwdCalls.slice(1)).toEqual([root, root, root]);
  });

  test("returns a repository error without pretending an empty snapshot is valid", async () => {
    const result = await readGitSnapshot(async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }), "/tmp/not-a-repo");
    expect(result).toEqual({ kind: "error", detail: "fatal: not a git repository" });
  });
});
describe("readGitCommits", () => {
  test("parses recent commits from NUL-delimited Git log output", async () => {
    const firstOid = "a".repeat(40);
    const secondOid = "b".repeat(40);
    const result = await readGitCommits(async (_cwd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "/tmp/project\n", stderr: "" };
      expect(args).toEqual(["log", "--no-decorate", "--format=%H%x00%h%x00%cI%x00%s%x00", "-n", "2", "--"]);
      return {
        code: 0,
        stdout: [
          firstOid,
          firstOid.slice(0, 7),
          "2026-09-09T12:00:00+00:00",
          "Add commit annotations",
          secondOid,
          secondOid.slice(0, 7),
          "2026-09-08T12:00:00+00:00",
          "Fix the source list",
          "",
        ].join("\0"),
        stderr: "",
      };
    }, "/tmp/project", 2);

    expect(result).toEqual({
      kind: "ok",
      commits: [
        {
          oid: firstOid,
          shortOid: firstOid.slice(0, 7),
          timestamp: "2026-09-09T12:00:00+00:00",
          subject: "Add commit annotations",
        },
        {
          oid: secondOid,
          shortOid: secondOid.slice(0, 7),
          timestamp: "2026-09-08T12:00:00+00:00",
          subject: "Fix the source list",
        },
      ],
    });
  });
});

describe("readGitSnapshotAtCommit", () => {
  test("reads a commit diff without including the commit message", async () => {
    const commitOid = "c".repeat(40);
    const calls: string[][] = [];
    const result = await readGitSnapshotAtCommit(async (_cwd, args) => {
      calls.push(args);
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { code: 0, stdout: "/tmp/project\n", stderr: "" };
      if (command === "rev-parse --git-common-dir") return { code: 0, stdout: "/tmp/project/.git\n", stderr: "" };
      if (command === `show --no-ext-diff --no-color --no-textconv --format= --default-prefix --src-prefix=a/ --dst-prefix=b/ --unified=40 ${commitOid} --`) {
        return { code: 0, stdout: diff, stderr: "" };
      }
      throw new Error(`unexpected git call: ${command}`);
    }, "/tmp/project", commitOid);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.detail);
    expect(result.snapshot.commitOid).toBe(commitOid);
    expect(result.snapshot.headOid).toBe(commitOid);
    expect(result.snapshot.files[0]!.path).toBe("src/demo.ts");
    expect(calls.every(args => Array.isArray(args))).toBe(true);
  });
});

describe("pending historical code validation", () => {
  test("validates a historical code annotation against its matching commit snapshot", () => {
    const commitOid = "d".repeat(40);
    const historicalSnapshot = { ...snapshot, commitOid };
    const anchor = createCodeAnchor(historicalSnapshot, snapshot.files[0]!.path, snapshot.files[0]!.hunks[0]!.lines.slice(1, 2));
    if (!anchor) throw new Error("test fixture did not produce an anchor");
    const item: ReviewItem = {
      schemaVersion: 1,
      id: "historical-code",
      source: "code",
      anchor,
      body: "Keep this historical line explicit.",
      createdAt: "2026-09-09T00:00:00.000Z",
      status: "pending",
    };

    expect(
      validatePendingItems([item], {
        sessionId: "session-1",
        branchEntries: [],
        codeSnapshot: snapshot,
        codeSnapshots: new Map([[commitOid, historicalSnapshot]]),
      }),
    ).toEqual({ valid: [item], stale: [] });
  });

  test("marks a historical annotation stale when its commit snapshot is unavailable", () => {
    const commitOid = "e".repeat(40);
    const historicalSnapshot = { ...snapshot, commitOid };
    const anchor = createCodeAnchor(historicalSnapshot, snapshot.files[0]!.path, snapshot.files[0]!.hunks[0]!.lines.slice(1, 2));
    if (!anchor) throw new Error("test fixture did not produce an anchor");
    const item: ReviewItem = {
      schemaVersion: 1,
      id: "missing-historical-code",
      source: "code",
      anchor,
      body: "Re-check this historical line.",
      createdAt: "2026-09-09T00:00:00.000Z",
      status: "pending",
    };

    expect(
      validatePendingItems([item], {
        sessionId: "session-1",
        branchEntries: [],
        codeSnapshot: snapshot,
        codeSnapshots: new Map(),
      }),
    ).toEqual({
      valid: [],
      stale: [{ item: { ...item, status: "stale", staleReason: "commit-not-found" }, reason: "commit-not-found" }],
    });
  });
});

describe("pending review validation", () => {
  test("sends valid items while marking changed code stale", () => {
    const validAssistant = {
      schemaVersion: 1 as const,
      id: "assistant-valid",
      source: "assistant" as const,
      anchor: {
        kind: "assistant" as const,
        sessionId: "session-1",
        entryId: "assistant-entry",
        start: 0,
        end: 4,
        text: "Text",
        before: "",
        after: "",
      },
      body: "Use a shorter sentence.",
      createdAt: "2026-09-04T00:02:00.000Z",
      status: "pending" as const,
    };
    const staleCode = codeItem(snapshot.files[0]!);
    const result = validatePendingItems(
      [staleCode, validAssistant],
      {
        sessionId: "session-1",
        branchEntries: [assistantEntry("assistant-entry", [{ type: "text", text: "Text" }])],
        codeSnapshot: { ...snapshot, diffFingerprint: "new-fingerprint" },
      },
    );

    expect(result.valid).toEqual([validAssistant]);
    expect(result.stale).toEqual([
      { item: { ...staleCode, status: "stale", staleReason: "snapshot-changed" }, reason: "snapshot-changed" },
    ]);
  });

  test("does not validate already sent or stale history again", () => {
    const item = codeItem(snapshot.files[0]!);
    const sent = { ...item, status: "sent" as const };
    const stale = { ...item, id: "stale", status: "stale" as const, staleReason: "text-mismatch" };
    expect(
      validatePendingItems([sent, stale], {
        sessionId: "session-1",
        branchEntries: [],
        codeSnapshot: snapshot,
      }),
    ).toEqual({ valid: [], stale: [] });
  });
});

describe("dispatch confirmation", () => {
  test("matches only the exact user message content", () => {
    expect(isDispatchConfirmation("expected", "expected")).toBe(true);
    expect(isDispatchConfirmation([{ type: "text", text: "expected" }], "expected")).toBe(true);
    expect(isDispatchConfirmation("different", "expected")).toBe(false);
  });
});

describe("branch review state", () => {
  test("retains items absent from a new branch as stale history", () => {
    const previous = codeItem(snapshot.files[0]!);
    expect(carryMissingReviewItems([], [previous])).toEqual([
      { ...previous, status: "stale", staleReason: "entry-not-in-current-branch" },
    ]);
  });
});

  test("does not revive an item hidden by a branch tombstone", () => {
    const previous = codeItem(snapshot.files[0]!);
    const deletedIds = deletedReviewItemIds([
      { type: "custom", customType: "annotate.review", data: { action: "delete", id: previous.id } },
    ]);
    expect(carryMissingReviewItems([], [previous], deletedIds)).toEqual([]);
  });

describe("review state", () => {
  const item: ReviewItem = {
    schemaVersion: 1,
    id: "assistant-1",
    source: "assistant",
    anchor: {
      kind: "assistant",
      sessionId: "session-1",
      entryId: "entry-1",
      start: 0,
      end: 4,
      text: "Text",
      before: "",
      after: "",
    },
    body: "Clarify this sentence.",
    createdAt: "2026-09-04T00:00:00.000Z",
    status: "pending",
  };

  test("replays latest upserts and deletion tombstones from current branch entries", () => {
    const entries = [
      { type: "custom", customType: "annotate.review", data: { action: "upsert", item } },
      {
        type: "custom",
        customType: "annotate.review",
        data: { action: "upsert", item: { ...item, status: "sent" } },
      },
      { type: "custom", customType: "annotate.review", data: { action: "delete", id: item.id } },
      {
        type: "custom",
        customType: "annotate.review",
        data: { action: "upsert", item: { ...item, id: "kept", status: "stale", staleReason: "text-mismatch" } },
      },
      { type: "custom", customType: "other-extension", data: { action: "upsert", item } },
    ];
    expect(restoreReviewItems(entries)).toEqual([
      { ...item, id: "kept", status: "stale", staleReason: "text-mismatch" },
    ]);
  });

  test("ignores malformed events without losing valid state", () => {
    const valid: ReviewEvent = { action: "upsert", item };
    expect(
      applyReviewEvent(new Map(), { action: "upsert", item: { ...item, status: "invalid" } as never }),
    ).toEqual(new Map());
    expect(restoreReviewItems([
      { type: "custom", customType: "annotate.review", data: valid },
      { type: "custom", customType: "annotate.review", data: null },
      { type: "custom", customType: "annotate.review", data: { action: "unknown" } },
    ])).toEqual([item]);
  });

  test("reports malformed review records while restoring valid items", () => {
    let invalidCount = 0;
    const restored = restoreReviewItems([
      { type: "custom", customType: "annotate.review", data: { action: "upsert", item } },
      { type: "custom", customType: "annotate.review", data: { action: "upsert", item: { ...item, status: "bad" } } },
    ], () => {
      invalidCount += 1;
    });
    expect(restored).toEqual([item]);
    expect(invalidCount).toBe(1);
  });
});

describe("buildReviewMessage", () => {
  test("serializes all annotations as one user instruction with quoted references", () => {
    const message = buildReviewMessage([
      codeItem(snapshot.files[0]!),
      {
        schemaVersion: 1,
        id: "assistant-1",
        source: "assistant",
        anchor: {
          kind: "assistant",
          sessionId: "session-1",
          entryId: "entry-1",
          start: 0,
          end: 4,
          text: "Text",
          before: "",
          after: "",
        },
        body: "Make the explanation shorter.",
        createdAt: "2026-09-04T00:00:00.000Z",
        status: "pending",
      },
    ]);

    expect(message).toContain("Annotate review feedback");
    expect(message).toContain('"source": "code"');
    expect(message).toContain('"source": "assistant"');
    expect(message).toContain("Keep this value explicit.");
    expect(message).toContain("Make the explanation shorter.");
    expect(message).toContain("quoted reference context");
    expect(message).toContain("working tree or a specific commit");
  });
});
