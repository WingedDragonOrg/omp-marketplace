import { describe, expect, test } from "bun:test";
import type { DiffLine } from "./model";
import { codeLinesForRange, codeRangeSelectionForRange } from "./code-range-selector";

const lines: DiffLine[] = [
  { kind: "context", content: "const first = true;", oldLine: 1, newLine: 1 },
  { kind: "addition", content: "const second = true;", newLine: 2 },
  { kind: "context", content: "const third = true;", oldLine: 2, newLine: 3 },
];

describe("codeLinesForRange", () => {
  test("returns every diff line intersected by a partial multi-line range", () => {
    const fullText = lines.map(line => line.content).join("\n");
    const range = {
      start: lines[0]!.content.indexOf("first"),
      end: lines[0]!.content.length + 1 + lines[1]!.content.length - 1,
    };

    expect(codeLinesForRange(lines, range)).toEqual(lines.slice(0, 2));
    expect(fullText.slice(range.start, range.end)).toContain("second");
  });

  test("keeps a single-line selection anchored to its line", () => {
    const start = lines[1]!.content.indexOf("second");
    const end = start + "second".length;
    expect(codeLinesForRange(lines, { start: lines[0]!.content.length + 1 + start, end: lines[0]!.content.length + 1 + end })).toEqual([
      lines[1],
    ]);
  });
  test("returns offsets relative to the anchored line span", () => {
    const fullText = lines.map(line => line.content).join("\n");
    const base = lines[0]!.content.length + 1;
    const start = base + lines[1]!.content.indexOf("second");
    const end = start + "second".length;
    const selection = codeRangeSelectionForRange(lines, {
      start,
      end,
      text: fullText.slice(start, end),
    });

    expect(selection?.lines).toEqual([lines[1]]);
    expect(selection?.startOffset).toBe(lines[1]!.content.indexOf("second"));
    expect(selection?.endOffset).toBe(lines[1]!.content.indexOf("second") + "second".length);
    expect(selection?.text).toBe("second");
  });
});
