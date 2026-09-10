import { describe, expect, test } from "bun:test";
import { AnnotationCard } from "./ui/annotation-card";
import { PointerTracker } from "./ui/pointer";
import { createHarness, loadTheme } from "./test-harness";
import type { ReviewItem } from "./model";
import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";

const rawEvent = (button: number, col: number, row: number, release = false): SgrMouseEvent => ({
  button,
  col,
  row,
  release,
  wheel: button & 64 ? ((button & 1 ? 1 : -1) as 1 | -1) : null,
  motion: (button & 32) !== 0 && (button & 64) === 0,
  leftClick: !release && (button & 64) === 0 && (button & 32) === 0 && (button & 3) === 0,
});

/** SGR press report at a frame-local cell, as the terminal would send it. */
const leftPress = (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}M`;
const leftRelease = (col: number, row: number): string => `\x1b[<0;${col + 1};${row + 1}m`;
const wheelDown = (col: number, row: number): string => `\x1b[<65;${col + 1};${row + 1}M`;
const themeBullet = await loadTheme().then((theme: Theme) => theme.format.bullet);
const dragTo = (col: number, row: number): string => `\x1b[<32;${col + 1};${row + 1}M`;

/** Frame rows that carry a rail mark, i.e. lines that already hold annotations. */
function markedRows(frame: readonly string[]): number[] {
  const rows: number[] = [];
  frame.forEach((row, index) => {
    const first = [...row][0] ?? "";
    if ("◆└┌│•123456789".includes(first) || first === themeBullet) rows.push(index);
  });
  return rows;
}

describe("pointer gestures", () => {
  test("reads a repeat press within the window and drift as a double click", () => {
    const tracker = new PointerTracker();
    expect(tracker.gesture(rawEvent(0, 4, 6), 1_000)).toMatchObject({ kind: "press", clicks: 1 });
    expect(tracker.gesture(rawEvent(0, 5, 6), 1_200)).toMatchObject({ kind: "press", clicks: 2 });
  });

  test("starts the count over once the repeat window lapses", () => {
    const tracker = new PointerTracker();
    tracker.gesture(rawEvent(0, 4, 6), 1_000);
    expect(tracker.gesture(rawEvent(0, 4, 6), 2_000)).toMatchObject({ kind: "press", clicks: 1 });
  });

  test("separates a held-button drag from a bare-pointer hover", () => {
    const tracker = new PointerTracker();
    expect(tracker.gesture(rawEvent(32, 4, 6))).toMatchObject({ kind: "drag", button: "left" });
    expect(tracker.gesture(rawEvent(35, 4, 6))).toEqual({ kind: "hover" });
  });

  test("reports the wheel direction and forgets any pending repeat", () => {
    const tracker = new PointerTracker();
    tracker.gesture(rawEvent(0, 4, 6), 1_000);
    expect(tracker.gesture(rawEvent(65, 4, 6), 1_100)).toEqual({ kind: "wheel", delta: 1 });
    expect(tracker.gesture(rawEvent(0, 4, 6), 1_200)).toMatchObject({ kind: "press", clicks: 1 });
  });
});

describe("annotation card", () => {
  const item = (id: string, status: ReviewItem["status"], body: string): ReviewItem => ({
    schemaVersion: 1,
    id,
    source: "code",
    anchor: { kind: "code", root: "/r", repositoryId: "/r/.git", commitOid: "c", filePath: "a.ts", oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1, headOid: "h", diffFingerprint: "d", selectedText: "x" },
    body,
    createdAt: "2026-01-02T03:06:05.000Z",
    status,
  });
  test("shows each annotation and offers edit only for pending ones", async () => {
    const theme = await loadTheme();
    const card = new AnnotationCard();
    const frame = card.render(theme, 60, 12, {
      target: "a.ts:1",
      items: [item("a", "pending", "First note"), item("b", "sent", "Second note")],
      index: 0,
      onAnnotateAgain: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onClose: () => {},
    });
    const text = frame.rows.join("\n");
    expect(text).toContain("First note");
    expect(text).toContain("Second note");
    expect(text).toContain("annotate again");
    expect(text).toContain("edit");
  });

  test("hides edit when the selected annotation is not pending", async () => {
    const theme = await loadTheme();
    const card = new AnnotationCard();
    const frame = card.render(theme, 60, 12, {
      target: "a.ts:1",
      items: [item("a", "pending", "First"), item("b", "sent", "Second")],
      index: 1,
      onAnnotateAgain: () => {},
      onEdit: () => {},
      onDelete: () => {},
      onClose: () => {},
    });
    const footer = frame.rows[frame.rows.length - 1] ?? "";
    expect(footer).not.toContain("edit");
    expect(footer).toContain("delete");
  });
});

describe("annotate mouse interaction", () => {
  test("opens the annotation card when a rail mark is clicked", async () => {
    const harness = await createHarness();
    const [firstMark] = markedRows(harness.frame());
    expect(firstMark).toBeDefined();

    harness.press(leftPress(0, firstMark!));
    const text = harness.frame().join("\n");
    expect(text).toContain("annotation");
    expect(text).toContain("Check the added evidence line.");
  });

  test("re-annotates an already marked line from the open card", async () => {
    const harness = await createHarness();
    const [firstMark] = markedRows(harness.frame());
    harness.press(leftPress(0, firstMark!));
    harness.press("a");
    const draft = harness.frame().find(row => /Draft:/.test(row));
    expect(draft).toMatch(/code/);

    harness.press("A second look here.");
    harness.press("\r");
    expect(harness.calls.addCode).toHaveLength(1);
    expect(harness.calls.addCode[0]?.body).toBe("A second look here.");
  });

  test("closes the card with escape and returns to the evidence", async () => {
    const harness = await createHarness();
    const [firstMark] = markedRows(harness.frame());
    harness.press(leftPress(0, firstMark!));
    expect(harness.frame().join("\n")).toContain("annotation");

    harness.press("\u001b");
    expect(harness.frame().join("\n")).not.toContain("annotations on");
  });

  test("double-clicking a bare changed line drafts an annotation for it", async () => {
    const harness = await createHarness();
    harness.frame();
    // Content row 0 is the first evidence row and never carries a mark here.
    harness.press(leftPress(6, 2));
    harness.press(leftPress(6, 2));
    const draft = harness.frame().find(row => /Draft:/.test(row));
    expect(draft).toMatch(/code/);
  });

  test("a drag keeps a code selection ready to annotate", async () => {
    const harness = await createHarness();
    harness.frame();
    harness.press(leftPress(6, 2));
    harness.press(dragTo(6, 4));
    harness.press(leftRelease(6, 4));
    harness.press("a");
    harness.press("Range note.");
    harness.press("\r");
    expect(harness.calls.addCode).toHaveLength(1);
    expect(harness.calls.addCode[0]?.selection.lines.length).toBeGreaterThanOrEqual(1);
  });

  test("the mouse wheel scrolls the open card without closing it", async () => {
    const harness = await createHarness();
    const [firstMark] = markedRows(harness.frame());
    harness.press(leftPress(0, firstMark!));
    harness.press(wheelDown(4, firstMark!));
    expect(harness.frame().join("\n")).toContain("annotation");
  });

  test("clicking a queued annotation jumps to its line and opens the card", async () => {
    const harness = await createHarness();
    const queueRow = harness.frame().findIndex(row => /pending @/.test(row));
    expect(queueRow).toBeGreaterThan(0);

    harness.press(leftPress(100, queueRow));
    const text = harness.frame().join("\n");
    expect(text).toContain("annotation");
    expect(text).toContain("Check the added evidence line.");
  });

  test("a revealed annotation can be re-edited in place", async () => {
    const harness = await createHarness();
    const queueRow = harness.frame().findIndex(row => /pending @/.test(row));
    harness.press(leftPress(100, queueRow));
    harness.press("e");
    harness.press(" — revisited");
    harness.press("\r");
    expect(harness.calls.updateItem).toHaveLength(1);
    expect(harness.calls.updateItem[0]?.item.id).toBe("review-pending");
    expect(harness.calls.updateItem[0]?.body).toBe("Check the added evidence line. — revisited");
  });
});
