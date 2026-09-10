import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { createHarness, loadTheme } from "./test-harness";
import { closeMark } from "./ui/presentation";
describe("annotate workbench rendering", () => {
  test("keeps every rendered row at the terminal width after resize", async () => {
    const harness = await createHarness();

    for (const size of [
      { columns: 120, rows: 30 },
      { columns: 70, rows: 14 },
    ]) {
      harness.tui.setSize(size.columns, size.rows);
      const rows = harness.lines();
      expect(rows.length).toBeLessThanOrEqual(size.rows);
      for (const row of rows) expect(visibleWidth(row)).toBe(size.columns);
    }
  });

  test("shows sources, draft, and queue sections in dock order", async () => {
    const harness = await createHarness();
    const rows = harness.frame();
    const sources = rows.findIndex(row => /sources/i.test(row));
    const draft = rows.findIndex(row => /draft/i.test(row));
    const queue = rows.findIndex(row => /queue/i.test(row));

    expect(sources).toBeGreaterThanOrEqual(0);
    expect(draft).toBeGreaterThan(sources);
    expect(queue).toBeGreaterThan(draft);
  });

  test("renders added code evidence and its source path", async () => {
    const harness = await createHarness();
    const snapshot = harness.data.codeSnapshot;
    if (!snapshot) throw new Error("Harness did not provide a code snapshot.");
    const file = snapshot.files[0];
    if (!file) throw new Error("Harness did not provide a diff file.");
    const addedLine = file.hunks.flatMap(hunk => hunk.lines).find(line => line.kind === "addition");
    if (!addedLine) throw new Error("Harness did not provide an added diff line.");

    const rows = harness.frame();
    const pathTail = file.path.slice(file.path.lastIndexOf("/") + 1);
    expect(rows.some(row => row.includes(addedLine.content))).toBe(true);
    expect(rows.some(row => row.includes(file.path) || row.includes(pathTail))).toBe(true);
  });

  test("switches to the assistant tab and hides code evidence", async () => {
    const harness = await createHarness();
    const snapshot = harness.data.codeSnapshot;
    if (!snapshot) throw new Error("Harness did not provide a code snapshot.");
    const file = snapshot.files[0];
    if (!file) throw new Error("Harness did not provide a diff file.");
    const addedLine = file.hunks.flatMap(hunk => hunk.lines).find(line => line.kind === "addition");
    if (!addedLine) throw new Error("Harness did not provide an added diff line.");
    const assistant = harness.data.assistantEntries[0];
    if (!assistant) throw new Error("Harness did not provide assistant text.");

    harness.press("2");
    const rows = harness.frame();
    expect(rows.some(row => row.includes(assistant.text))).toBe(true);
    expect(rows.some(row => row.includes(addedLine.content))).toBe(false);
  });
});

describe("annotate workbench interaction", () => {
  test("keeps typed words when the draft is pointed at another selection", async () => {
    const harness = await createHarness();
    harness.frame();
    harness.press("\t");
    harness.press("a");
    for (const char of "reads backwards") harness.press(char);
    expect(harness.frame().some(row => row.includes("reads backwards"))).toBe(true);

    harness.press("\u001b");
    harness.press("j");
    harness.press("a");
    const rows = harness.frame();
    const close = closeMark(await loadTheme());
    expect(rows.some(row => row.includes(close))).toBe(true);
  });

  test("discards a draft only when asked", async () => {
    const harness = await createHarness();
    harness.frame();
    harness.press("\t");
    harness.press("a");
    for (const char of "wrong line") harness.press(char);
    harness.press("\u001b");
    harness.press("x");
    const rows = harness.frame();

    expect(rows.some(row => row.includes("wrong line"))).toBe(false);
    expect(rows.some(row => row.includes("Draft discarded."))).toBe(true);
  });

  test("saves an annotation through the draft editor", async () => {
    const harness = await createHarness();
    harness.frame();
    harness.press("\t");
    harness.press("a");
    for (const char of "this loop re-clicks every row") harness.press(char);
    harness.press("\r");

    expect(harness.calls.addCode).toHaveLength(1);
    expect(harness.calls.addCode[0]?.body).toBe("this loop re-clicks every row");
  });

  test("enter on a focused queue item reveals it in the evidence", async () => {
    const harness = await createHarness();
    harness.frame();
    harness.press("\r"); // open the selected file, moving focus to the evidence
    harness.press("\t"); // step to the queue (the empty draft is skipped)
    harness.press("\r"); // reveal the selected annotation

    expect(harness.frame().join("\n")).toContain("Check the added evidence line.");
  });

  test("answers ? with the keymap and scrolls it on short terminals", async () => {
    const harness = await createHarness();
    harness.tui.setSize(120, 14);
    harness.press("?");
    const first = harness.frame();
    expect(first.some(row => row.includes("wrap long lines"))).toBe(true);

    harness.press("G");
    const last = harness.frame();
    expect(last).not.toEqual(first);
    expect(last.some(row => row.includes("close Annotate"))).toBe(true);
  });

  test("gives the evidence pane the whole frame when the dock is hidden", async () => {
    const harness = await createHarness();
    const docked = harness.frame();
    harness.press("f");
    const collapsed = harness.frame();

    expect(docked.some(row => /Queue:/.test(row))).toBe(true);
    expect(collapsed.some(row => /Queue:|Draft:|Sources:/.test(row))).toBe(false);

    harness.press("f");
    expect(harness.frame().some(row => /Queue:/.test(row))).toBe(true);
  });

  test("shows a failure from the agent in the header", async () => {
    const harness = await createHarness();
    harness.data.notice = { message: "The agent is busy — annotations stay pending.", level: "warning", expiresAt: undefined };
    const rows = harness.frame();

    expect(rows[0]).toContain("The agent is busy");
  });
});
