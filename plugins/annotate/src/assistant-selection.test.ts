import { describe, expect, test } from "bun:test";
import {
  chooseAssistantDisplayWindow,
  createAssistantSelectionState,
  moveAssistantSelection,
  selectedAssistantRange,
} from "./assistant-selection";

describe("assistant precise selection", () => {
  test("starts with an empty caret selection at the beginning", () => {
    const state = createAssistantSelectionState("Choose this sentence.");

    expect(state.cursor).toBe(0);
    expect(selectedAssistantRange(state)).toBeUndefined();
  });

  test("extends with Shift and collapses to an edge without Shift", () => {
    let state = createAssistantSelectionState("Select this text.");
    state = moveAssistantSelection(state, "right", true);
    state = moveAssistantSelection(state, "right", true);
    expect(selectedAssistantRange(state)).toEqual({ start: 0, end: 2, text: "Se" });

    state = moveAssistantSelection(state, "left");
    expect(state.cursor).toBe(0);
    expect(selectedAssistantRange(state)).toBeUndefined();
  });

  test("moves by grapheme boundaries instead of splitting surrogate pairs", () => {
    let state = createAssistantSelectionState("A😀B");
    state = moveAssistantSelection(state, "right");
    state = moveAssistantSelection(state, "right", true);

    expect(selectedAssistantRange(state)).toEqual({ start: 1, end: 3, text: "😀" });
    expect(moveAssistantSelection(state, "left").cursor).toBe(1);
  });

  test("supports line home/end and a selection across lines", () => {
    let state = createAssistantSelectionState("first\nsecond\nthird");
    state = moveAssistantSelection(state, "down");
    state = moveAssistantSelection(state, "end");
    expect(state.cursor).toBe(12);

    state = moveAssistantSelection(state, "home");
    expect(state.cursor).toBe(6);
    state = moveAssistantSelection(state, "up", true);
    expect(selectedAssistantRange(state)).toEqual({ start: 0, end: 6, text: "first\n" });
  });

  test("preserves the preferred column while moving vertically", () => {
    let state = createAssistantSelectionState("12\n123456\n123");
    state = moveAssistantSelection(state, "right");
    state = moveAssistantSelection(state, "right");
    state = moveAssistantSelection(state, "down");
    expect(state.cursor).toBe(5);
    state = moveAssistantSelection(state, "down");
    expect(state.cursor).toBe(12);
  });

  test("rejects movement and selection for empty text", () => {
    const state = createAssistantSelectionState("");

    expect(moveAssistantSelection(state, "right", true)).toEqual(state);
    expect(selectedAssistantRange(state)).toBeUndefined();
  });
  test("keeps a clipped cursor line within its cell budget", () => {
    const window = chooseAssistantDisplayWindow(new Array(13).fill(1), 13, 7);
    const visibleWidth = window.end - window.start + (window.start > 0 ? 1 : 0) + (window.end < 13 ? 1 : 0);

    expect(window.end).toBe(13);
    expect(window.start).toBeLessThanOrEqual(13);
    expect(visibleWidth).toBeLessThanOrEqual(7);
  });
  test("keeps wide grapheme pieces within the same visible-cell budget", () => {
    const widths = new Array(8).fill(2);
    const window = chooseAssistantDisplayWindow(widths, 8, 9);
    let selectedCells = 0;
    for (const width of widths.slice(window.start, window.end)) selectedCells += width;
    const indicatorCells = (window.start > 0 ? 1 : 0) + (window.end < widths.length ? 1 : 0);

    expect(window.end).toBe(8);
    expect(selectedCells + indicatorCells).toBeLessThanOrEqual(9);
  });

  test("treats CRLF as one line break without splitting the grapheme", () => {
    let state = createAssistantSelectionState("a\r\nb");
    state = moveAssistantSelection(state, "end");
    expect(state.cursor).toBe(1);

    state = moveAssistantSelection(state, "right");
    expect(state.cursor).toBe(3);
    state = moveAssistantSelection(state, "left", true);
    expect(selectedAssistantRange(state)).toEqual({ start: 1, end: 3, text: "\r\n" });
  });
});
