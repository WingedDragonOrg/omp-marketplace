import { describe, expect, test } from "bun:test";
import { codeSourceItems, resolveAnnotateLayout, type CodeSource } from "./ui";

describe("annotate workbench layout", () => {
  test("allocates the full width to source and annotation columns", () => {
    const layout = resolveAnnotateLayout(120, 32);

    expect(layout.leftWidth + layout.dividerWidth + layout.rightWidth).toBe(120);
    expect(layout.leftWidth).toBeGreaterThan(layout.rightWidth);
    expect(layout.bodyHeight).toBe(32);
  });

  test("gives taller terminals more room for previews and annotation history", () => {
    const short = resolveAnnotateLayout(120, 24);
    const tall = resolveAnnotateLayout(120, 40);

    expect(tall.sourceHeight).toBeGreaterThan(short.sourceHeight);
    expect(tall.previewHeight).toBeGreaterThan(short.previewHeight);
    expect(tall.reviewHeight).toBeGreaterThan(short.reviewHeight);
  });

  test("keeps every pane inside the available bounds", () => {
    const layout = resolveAnnotateLayout(50, 10);

    expect(layout.leftWidth).toBeGreaterThan(0);
    expect(layout.rightWidth).toBeGreaterThan(0);
    expect(layout.sourceHeight + layout.previewHeight + 2).toBe(layout.bodyHeight);
    expect(layout.draftHeight + layout.reviewHeight + 4).toBe(layout.bodyHeight);
  });

  test("honors the actual body height on short overlays", () => {
    const layout = resolveAnnotateLayout(120, 6);

    expect(layout.bodyHeight).toBe(6);
    expect(layout.sourceHeight + layout.previewHeight + 2).toBe(6);
    expect(layout.draftHeight + layout.reviewHeight + 4).toBe(6);
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
});
