import { visibleWidth } from "@oh-my-pi/pi-tui";

export interface UiHit {
  from: number;
  to: number;
  action: () => void;
}

/** Build a single terminal row while retaining mouse hit ranges. */
export class HitRow {
  text = "";
  width = 0;
  hits: UiHit[] = [];

  add(text: string): this {
    this.text += text;
    this.width += visibleWidth(text);
    return this;
  }

  button(text: string, action: () => void): this {
    const from = this.width;
    this.add(text);
    this.hits.push({ from, to: this.width, action });
    return this;
  }
}
