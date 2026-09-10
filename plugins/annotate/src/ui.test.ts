import { describe, expect, test } from "bun:test";
import {
  activeNotice,
  annotateHints,
  annotateKeySections,
  annotationRailGlyph,
  buildAnnotateDiffDocument,
  codeAnnotationsForLine,
  codeSelectionForHunkVisualRow,
  codeSelectionForPane,
  compactPath,
  createNotice,
  formatAssistantTarget,
  formatCodeSelectionTarget,
  formatCodeSourceSummary,
  formatCommitSourceSummary,
  formatReviewQueueSummary,
  nextAnnotateCodeMode,
  panelHeading,
  renderKeyHints,
  renderSidebarRow,
  resolveAnnotateAction,
  resolveAnnotateLayout,
  reviewItemLocation,
  reviewRowModel,
  sidebarPanelAtRow,
  sourceRowModel,
  type AnnotateScope,
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
    ).toBe("2 pending, 1 stale, 1 sent");
  });
  test("describes commit history instead of stale working-tree stats", () => {
    expect(formatCommitSourceSummary(0)).toBe("No recent commits");
    expect(formatCommitSourceSummary(1)).toBe("1 recent commit");
    expect(formatCommitSourceSummary(3)).toBe("3 recent commits");
  });

  test("uses readable punctuation for changed-file counts", () => {
    const snapshot: CodeSnapshot = {
      root: "/tmp/project",
      repositoryId: "/tmp/project/.git",
      headOid: "head",
      diffFingerprint: "fingerprint",
      files: [
        {
          path: "src/example.ts",
          binary: false,
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 2,
              header: "",
              lines: [
                { kind: "deletion", content: "old", oldLine: 1 },
                { kind: "addition", content: "new", newLine: 1 },
                { kind: "addition", content: "extra", newLine: 2 },
              ],
            },
          ],
        },
      ],
    };

    expect(formatCodeSourceSummary(snapshot)).toBe("1 file, +2, -1");
  });

  test("keeps the whole workflow visible in a short terminal", () => {
    const layout = resolveAnnotateLayout(60, 6);

    expect(layout.sourceHeight).toBeGreaterThan(0);
    expect(layout.draftHeight).toBeGreaterThan(0);
    expect(layout.reviewHeight).toBeGreaterThan(0);
  });

  test("shows overflow instead of hiding the tenth annotation on the rail", () => {
    expect(annotationRailGlyph({} as never, 10, false, false)).toBe("9+");
  });
});

const scope = (overrides: Partial<AnnotateScope> = {}): AnnotateScope => ({
  focus: "diff",
  tab: "code",
  codeMode: "split",
  hasDraft: false,
  revisions: false,
  dockCollapsed: false,
  helpOpen: false,
  cardOpen: false,
  ...overrides,
});

describe("annotate keys", () => {
  test("gives a key one meaning per pane", () => {
    expect(resolveAnnotateAction("h", scope())).toBe("scrollLeft");
    expect(resolveAnnotateAction("h", scope({ focus: "source" }))).toBeUndefined();
    expect(resolveAnnotateAction("\r", scope())).toBe("annotate");
    expect(resolveAnnotateAction("\r", scope({ focus: "source" }))).toBe("openSource");
  });

  test("leaves the draft editor its own text keys", () => {
    expect(resolveAnnotateAction("k", scope({ focus: "editor" }))).toBeUndefined();
    expect(resolveAnnotateAction("x", scope({ focus: "editor", hasDraft: true }))).toBeUndefined();
    expect(resolveAnnotateAction("\u001b", scope({ focus: "editor" }))).toBe("leaveEditor");
    expect(resolveAnnotateAction("\u001b", scope())).toBe("close");
  });

  test("offers discard only while a draft exists", () => {
    expect(resolveAnnotateAction("x", scope({ focus: "source" }))).toBeUndefined();
    expect(resolveAnnotateAction("x", scope({ focus: "source", hasDraft: true }))).toBe("discardDraft");
  });

  test("holds editing keys while the help sheet scrolls", () => {
    expect(resolveAnnotateAction("a", scope({ helpOpen: true }))).toBeUndefined();
    expect(resolveAnnotateAction("s", scope({ helpOpen: true }))).toBeUndefined();
    expect(resolveAnnotateAction("j", scope({ helpOpen: true }))).toBe("moveDown");
    expect(resolveAnnotateAction("?", scope({ helpOpen: true }))).toBe("closeHelp");
  });

  test("describes revision browsing by what the key will do next", () => {
    const closed = annotateKeySections(scope()).flatMap(section => section.rows);
    const open = annotateKeySections(scope({ revisions: true })).flatMap(section => section.rows);

    expect(closed.find(row => row.key === "H")?.label).toBe("browse revisions");
    expect(open.find(row => row.key === "H")?.label).toBe("back to changed files");
    expect(open.some(row => row.label === "next file")).toBe(false);
  });

  test("drops the least useful hint instead of clipping the line", () => {
    const theme = { fg: (_color: string, text: string) => text } as never;
    const hints = annotateHints(scope());
    const wide = renderKeyHints(theme, hints, 200);
    const narrow = renderKeyHints(theme, hints, 24);

    expect(wide).toContain("a annotate selection");
    expect(wide).toContain("? keys");
    expect(narrow.length).toBeLessThanOrEqual(24);
    expect(narrow.startsWith("a annotate selection")).toBe(true);
    expect(narrow).not.toContain("? keys");
  });
});

describe("annotate feedback", () => {
  test("expires confirmations but keeps failures until the next action", () => {
    const info = createNotice("Sending 2 annotations.", "info", 1_000);
    const failure = createNotice("Sending annotations failed.", "error", 1_000);

    expect(activeNotice(info, 4_000)).toBe(info);
    expect(activeNotice(info, 5_001)).toBeUndefined();
    expect(activeNotice(failure, 9_999_999)).toBe(failure);
  });
});

describe("annotate collapsed dock", () => {
  test("hands the whole frame to the evidence pane", () => {
    const layout = resolveAnnotateLayout(120, 30, true);

    expect(layout.leftWidth).toBe(120);
    expect(layout.dividerWidth).toBe(0);
    expect(layout.rightWidth).toBe(0);
    expect(layout.bodyHeight).toBe(30);
    expect([layout.sourceHeight, layout.draftHeight, layout.reviewHeight]).toEqual([0, 0, 0]);
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
    const railTheme = {
      boxSharp: { vertical: "V", topLeft: "T", bottomLeft: "B" },
      format: { bullet: "P" },
    } as never;
    expect(annotationRailGlyph(railTheme, 1, false, false)).toBe("P");
    expect(annotationRailGlyph(railTheme, 1, false, true)).toBe("T");
    expect(annotationRailGlyph(railTheme, 1, true, true)).toBe("V");
    expect(annotationRailGlyph(railTheme, 1, true, false)).toBe("B");
  });
});

describe("annotate narrow layout", () => {
  test("gives a narrow dock enough room for source identity and status", () => {
    const layout = resolveAnnotateLayout(60, 6);

    expect(layout.rightWidth).toBeGreaterThanOrEqual(23);
    expect(layout.leftWidth).toBeGreaterThan(0);
  });

  test("keeps the dock width monotonic across the wide layout boundary", () => {
    expect(resolveAnnotateLayout(96, 6).rightWidth).toBeGreaterThanOrEqual(resolveAnnotateLayout(95, 6).rightWidth);
  });

  test("clips focused panel headings to their dock width", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      nav: { expand: ">" },
    } as never;

    const heading = panelHeading(theme, "Sources: Working tree, 12 files", true, 12);

    expect(heading.length).toBeLessThanOrEqual(12);
    expect(heading).toContain(">");
  });
});

describe("annotate sidebar rows", () => {
  test("keeps file identity and change counts readable as one selectable row", () => {
    const row = sourceRowModel({ styledSymbol: (_k: string, _c: string) => "", getLangIconStyled: () => "" } as never, {
      kind: "file",
      file: {
        path: "src/example.ts",
        oldPath: undefined,
        binary: false,
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 2,
            header: "",
            lines: [
              { kind: "deletion", content: "old", oldLine: 1 },
              { kind: "addition", content: "new", newLine: 1 },
              { kind: "addition", content: "extra", newLine: 2 },
            ],
          },
        ],
      },
    });

    expect(row).toEqual({
      lead: "M",
      title: "src/example.ts",
      detail: "+2 -1",
      tone: "muted",
      mark: "",
    });
  });

  test("keeps review rows ordered around status, target, and feedback", () => {
    const row = reviewRowModel({ styledSymbol: (_k: string, _c: string) => "*" } as never, reviewItem("pending-1", "pending"));

    expect(row.lead).toBe("pending");
    expect(row.title).toBe("message entry-pending-1:0–1");
    expect(row.detail).toBe("Review this.");
    expect(row.tone).toBe("accent");
  });

  test("uses a focused marker and selected surface without losing the row body", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bgFill: (_color: string, text: string) => `[selected]${text}`,
      nav: { cursor: ">" },
      format: { bullet: "." },
    } as never;
    const focused = renderSidebarRow(
      theme,
      24,
      { lead: "M", title: "src/example.ts", detail: "+2 -1", tone: "muted" },
      { selected: true, focused: true },
    );
    const parked = renderSidebarRow(
      theme,
      24,
      { lead: "M", title: "src/example.ts", detail: "+2 -1", tone: "muted" },
      { selected: true, focused: false },
    );

    expect(focused).toContain("[selected]>");
    expect(focused).toContain("src/example.ts");
    expect(parked).toContain("[selected].");
  });

  test("compacts long code and assistant targets around the useful identity", () => {
    const codeTarget = formatCodeSelectionTarget(
      {
        filePath: "packages/annotate/src/components/very-long-file-name.ts",
        line: { kind: "addition", content: "value", newLine: 42 },
        lines: [{ kind: "addition", content: "value", newLine: 42 }],
        commitOid: "abcdef0123456789",
      },
      40,
    );
    const assistantTarget = formatAssistantTarget(
      { id: "assistant-entry-123456" },
      { start: 12, end: 34 },
      32,
    );
    expect(compactPath("src/generated/very-long-name.ts", 12)).toBe("…ong-name.ts");

    expect(codeTarget).toBe("@abcdef0 …/very-long-file-name.ts:+42");
    expect(assistantTarget).toBe("message …ntry-123456 chars 12–34");
  });

  test("keeps the code line range visible in a narrow draft heading", () => {
    const target = formatCodeSelectionTarget(
      {
        filePath: "plugins/annotate/src/ui.test.ts",
        line: { kind: "addition", content: "value", newLine: 42 },
        lines: [{ kind: "addition", content: "value", newLine: 42 }],
      },
      16,
    );

    expect(target).toBe("…/ui.test.ts:+42");
  });

  test("keeps an assistant edit range visible in a narrow target", () => {
    expect(reviewItemLocation(reviewItem("pending-1", "pending"), 8)).toBe("0–1");
  });
  test("keeps a code edit line visible in a narrow target", () => {
    const item: ReviewItem = {
      ...reviewItem("pending-code", "pending"),
      source: "code",
      anchor: {
        kind: "code",
        root: "/tmp/project",
        repositoryId: "/tmp/project/.git",
        filePath: "src/generated/very-long-name.ts",
        headOid: "head",
        diffFingerprint: "fingerprint",
        oldStart: 42,
        oldEnd: 42,
        newStart: 42,
        newEnd: 42,
        selectedText: "value",
      },
    };

    expect(reviewItemLocation(item, 8)).toBe("…e.ts:42");
  });
  test("keeps an assistant range visible when its label budget is tiny", () => {
    expect(formatAssistantTarget({ id: "assistant-entry-123456" }, { start: 12, end: 34 }, 7)).toBe("12–34");
  });
  test("drops an oversized commit prefix before dropping the code line", () => {
    const target = formatCodeSelectionTarget(
      {
        filePath: "plugins/annotate/src/ui.test.ts",
        line: { kind: "addition", content: "value", newLine: 42 },
        lines: [{ kind: "addition", content: "value", newLine: 42 }],
        commitOid: "abcdef0123456789",
      },
      5,
    );

    expect(target).toBe("…:+42");
  });

  test("drops an oversized assistant identity before dropping its range", () => {
    expect(formatAssistantTarget({ id: "assistant-entry-123456" }, { start: 12, end: 34 }, 12)).toBe("12–34");
  });
});
