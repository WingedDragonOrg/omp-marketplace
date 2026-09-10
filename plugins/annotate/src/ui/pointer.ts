import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";

export type PointerButton = "left" | "middle" | "right";

/**
 * What the pointer just did, in the vocabulary the workbench reacts to.
 * Terminals report presses, motion and releases separately and never say
 * "double click" or "drag", so repeats and held buttons are resolved here and
 * nowhere else.
 */
export type PointerGesture =
  | { kind: "wheel"; delta: -1 | 1 }
  | { kind: "press"; button: PointerButton; clicks: number }
  | { kind: "drag"; button: PointerButton }
  | { kind: "hover" }
  | { kind: "release" };

/** Presses further apart than this read as two separate clicks. */
const REPEAT_WINDOW_MS = 400;
/** A hand shifts by a cell between the two clicks of a double click. */
const REPEAT_DRIFT_COLUMNS = 1;

/** Motion reports carry `3` in the low bits when no button is held. */
function heldButton(button: number): PointerButton | undefined {
  const low = button & 3;
  if (low === 0) return "left";
  if (low === 1) return "middle";
  if (low === 2) return "right";
  return undefined;
}

export class PointerTracker {
  #pressedAt = 0;
  #row = -1;
  #column = -1;
  #button: PointerButton | undefined;
  #clicks = 0;

  gesture(event: SgrMouseEvent, now = Date.now()): PointerGesture {
    if (event.wheel !== null) {
      this.#clicks = 0;
      return { kind: "wheel", delta: event.wheel };
    }
    if (event.release) return { kind: "release" };
    const held = heldButton(event.button);
    if (event.motion) return held === undefined ? { kind: "hover" } : { kind: "drag", button: held };
    const button = held ?? "left";
    const repeat =
      button === this.#button &&
      now - this.#pressedAt <= REPEAT_WINDOW_MS &&
      event.row === this.#row &&
      Math.abs(event.col - this.#column) <= REPEAT_DRIFT_COLUMNS;
    this.#clicks = repeat ? this.#clicks + 1 : 1;
    this.#pressedAt = now;
    this.#row = event.row;
    this.#column = event.col;
    this.#button = button;
    return { kind: "press", button, clicks: this.#clicks };
  }

  /** Forget the last press so the next one cannot count as a repeat. */
  reset(): void {
    this.#clicks = 0;
    this.#button = undefined;
    this.#pressedAt = 0;
  }
}
