import { describe, expect, test } from "bun:test";
import {
  annotationRailGlyph,
  buildAnnotateDiffDocument,
  codeAnnotationsForLine,
  codeSelectionForPane,
  codeSelectionForHunkVisualRow,
  codeSourceItems,
  formatCommitSourceSummary,
  formatReviewQueueSummary,
  nextAnnotateCodeMode,
  resolveAnnotateLayout,
  sidebarPanelAtRow,
  type CodeSource,
} from "./ui";
import { createCodeAnchor } from "./model";
import type { CodeSnapshot, DiffFile, ReviewItem } from "./model";

const reviewItem = (id: string, status: ReviewItem["status"]): ReviewItem => ({
  schemaVersion: 1,
  id,
  source: "assistant",
  anchor: {
    kind: "assistant",
    sessionId: "session",
    entryId: `entry-${id}`,
    start: 0,
    end: 1,
    text: "x",
    before: "",
    after: "",
  },
  body: "Review this.",
  createdAt: "2026-09-09T00:00:00.000Z",
  status,
});

describe("annotate workbench layout", () => {
  test("keeps the diff pane dominant like the built-in git TUI", () => {
    const layout = resolveAnnotateLayout(120, 32);

    expect(layout.leftWidth + layout.dividerWidth + layout.rightWidth).toBe(120);
    expect(layout.leftWidth).toBeGreaterThanOrEqual(80);
    expect(layout.rightWidth).toBeGreaterThanOrEqual(24);
    expect(layout.bodyHeight).toBe(32);
  });

  test("reserves the sidebar for sources, draft, and review history", () => {
    const layout = resolveAnnotateLayout(120, 32);

    expect(layout.sourceHeight + layout.draftHeight + layout.reviewHeight + 3).toBe(layout.bodyHeight);
    expect(layout.sourceHeight).toBeGreaterThan(layout.draftHeight);
    expect(layout.reviewHeight).toBeGreaterThan(0);
  });

  test("keeps every pane inside short overlay bounds", () => {
    const layout = resolveAnnotateLayout(50, 6);

    expect(layout.leftWidth).toBeGreaterThan(0);
    expect(layout.rightWidth).toBeGreaterThan(0);
    expect(layout.sourceHeight + layout.draftHeight + layout.reviewHeight + 3).toBe(layout.bodyHeight);
  });

  test("honors the actual body height on a minimal overlay", () => {
    const layout = resolveAnnotateLayout(120, 4);

    expect(layout.bodyHeight).toBe(4);
    expect(layout.sourceHeight + layout.draftHeight + layout.reviewHeight + 3).toBe(4);
  });
});

describe("annotate workflow summaries", () => {
  test("keeps every queue state visible in a compact status line", () => {
    expect(
      formatReviewQueueSummary([
        reviewItem("pending-1", "pending"),
        reviewItem("pending-2", "pending"),
        reviewItem("stale-1", "stale"),
        reviewItem("sent-1", "sent"),
      ]),
    ).toBe("2 pending / 1 stale / 1 sent");
  });
  test("describes commit history instead of stale working-tree stats", () => {
    expect(formatCommitSourceSummary(0)).toBe("No recent commits");
    expect(formatCommitSourceSummary(1)).toBe("1 recent commit");
    expect(formatCommitSourceSummary(3)).toBe("3 recent commits");
  });

  test("keeps the whole workflow visible in a short terminal", () => {
    const layout = resolveAnnotateLayout(60, 6);

    expect(layout.sourceHeight).toBeGreaterThan(0);
    expect(layout.draftHeight).toBeGreaterThan(0);
    expect(layout.reviewHeight).toBeGreaterThan(0);
  });

  test("shows overflow instead of hiding the tenth annotation on the rail", () => {
    expect(annotationRailGlyph(10, false, false)).toBe("9+");
  });
});

describe("annotate dock hit regions", () => {
  test("maps dock headings to the action they expose", () => {
    const geometry = {
      sourceStart: 1,
      sourceHeight: 2,
      draftStart: 4,
      draftHeight: 2,
      reviewStart: 7,
      reviewHeight: 2,
    };

    expect(sidebarPanelAtRow(0, geometry)).toBe("sources");
    expect(sidebarPanelAtRow(3, geometry)).toBe("draft");
    expect(sidebarPanelAtRow(4, geometry)).toBe("draft");
    expect(sidebarPanelAtRow(6, geometry)).toBe("reviews");
    expect(sidebarPanelAtRow(8, geometry)).toBe("reviews");
  });
});

describe("annotate code source navigation", () => {
  test("exposes recent commits as selectable source records", () => {
    const source: CodeSource = { kind: "commit-list" };
    const commit = {
      oid: "a".repeat(40),
      shortOid: "aaaaaaa",
      timestamp: "2026-09-09T12:00:00+00:00",
      subject: "Add historical review",
    };

    expect(codeSourceItems(undefined, source, [commit])).toEqual([{ kind: "commit", commit }]);
  });

  test("builds a wide diff document while preserving line anchors", () => {
    const file: DiffFile = {
      path: "src/example.ts",
      binary: false,
      hunks: [
        {
          oldStart: 10,
          oldCount: 3,
          newStart: 10,
          newCount: 3,
          header: "render()",
          lines: [
            { kind: "context", content: "  return value;", oldLine: 10, newLine: 10 },
            { kind: "deletion", content: "  return oldValue;", oldLine: 11 },
            { kind: "addition", content: "  return newValue;", newLine: 11 },
          ],
        },
      ],
    };

    const built = buildAnnotateDiffDocument(file);

    expect(built.document.filePath).toBe("src/example.ts");
    expect(built.document.hunks[0]?.header).toBe("@@ -10,3 +10,3 @@ render()");
    expect(built.selections.map(selection => selection.line.kind)).toEqual(["context", "deletion", "addition"]);
    expect(built.selections[0]?.lines).toEqual([file.hunks[0]!.lines[0]]);
    expect(built.selections[1]?.line.oldLine).toBe(11);
    expect(built.selections[2]?.line.newLine).toBe(11);
  });

  test("never falls back to a different code target in hunk or file view", () => {
    const file: DiffFile = {
      path: "src/two-hunks.ts",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 0,
          newStart: 1,
          newCount: 1,
          header: "first",
          lines: [{ kind: "addition", content: "first", newLine: 1 }],
        },
        {
          oldStart: 20,
          oldCount: 0,
          newStart: 20,
          newCount: 1,
          header: "second",
          lines: [{ kind: "addition", content: "second", newLine: 20 }],
        },
      ],
    };
    const built = buildAnnotateDiffDocument(file);

    expect(codeSelectionForPane(built, undefined, "hunk", 1)?.line.content).toBe("second");
    expect(codeSelectionForPane(built, undefined, "file", 0)).toBeUndefined();
    expect(codeSelectionForPane(built, { from: 1, to: 1 }, "file", 0)?.line.content).toBe("second");
  });

  test("cycles only through views backed by diff evidence", () => {
    expect(nextAnnotateCodeMode("split")).toBe("inline");
    expect(nextAnnotateCodeMode("inline")).toBe("hunk");
    expect(nextAnnotateCodeMode("hunk")).toBe("split");
    expect(nextAnnotateCodeMode("file")).toBe("split");
  });

  test("keeps hunk rows linked to their annotation rail targets", () => {
    const file: DiffFile = {
      path: "src/hunks.ts",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 0,
          newStart: 1,
          newCount: 1,
          header: "first",
          lines: [{ kind: "addition", content: "first", newLine: 1 }],
        },
        {
          oldStart: 20,
          oldCount: 0,
          newStart: 20,
          newCount: 1,
          header: "second",
          lines: [{ kind: "addition", content: "second", newLine: 20 }],
        },
      ],
    };
    const built = buildAnnotateDiffDocument(file);

    expect(codeSelectionForHunkVisualRow(built, 80, false, 0)).toBeUndefined();
    expect(codeSelectionForHunkVisualRow(built, 80, false, 1)?.line.content).toBe("first");
    expect(codeSelectionForHunkVisualRow(built, 80, false, 2)).toBeUndefined();
    expect(codeSelectionForHunkVisualRow(built, 80, false, 4)?.line.content).toBe("second");
  });

  test("sanitizes code text before handing it to the terminal diff pane", () => {
    const file: DiffFile = {
      path: "src/control.ts",
      binary: false,
      hunks: [
        {
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 1,
          header: "",
          lines: [{ kind: "addition", content: "safe\u001b[31m", newLine: 1 }],
        },
      ],
    };

    const built = buildAnnotateDiffDocument(file);

    expect(built.document.rows[0]?.newText).toBe("safe[31m");
    expect(built.selections[0]?.line.content).toBe("safe\u001b[31m");
  });
  test("shows grouped row markers and all annotations at a code line", () => {
    const file: DiffFile = {
      path: "src/marked.ts",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 1,
          newCount: 2,
          header: "",
          lines: [
            { kind: "context", content: "const first = true;", oldLine: 1, newLine: 1 },
            { kind: "addition", content: "const second = true;", newLine: 2 },
          ],
        },
      ],
    };
    const snapshot: CodeSnapshot = {
      root: "/tmp/project",
      repositoryId: "/tmp/project/.git",
      headOid: "head",
      diffFingerprint: "fingerprint",
      files: [file],
    };
    const anchor = createCodeAnchor(snapshot, file.path, [file.hunks[0]!.lines[1]!]);
    if (!anchor) throw new Error("test fixture did not produce an anchor");
    const item: ReviewItem = {
      schemaVersion: 1,
      id: "review-1",
      source: "code",
      anchor,
      body: "Check this change.",
      createdAt: "2026-09-09T00:00:00.000Z",
      status: "pending",
    };
    const duplicate = { ...item, id: "review-2", body: "Also verify this value." };

    expect(codeAnnotationsForLine([item, duplicate], snapshot, file.path, file.hunks[0]!.lines[1]!)).toEqual([
      item,
      duplicate,
    ]);
    expect(annotationRailGlyph(1, false, false)).toBe("◆");
    expect(annotationRailGlyph(1, false, true)).toBe("┌");
    expect(annotationRailGlyph(1, true, true)).toBe("│");
    expect(annotationRailGlyph(1, true, false)).toBe("└");
  });
});
