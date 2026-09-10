import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { ScrollView, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { ReviewItem } from "../model";
import { closeMark, padColumn, previewLines, statusColor, statusMark } from "./presentation";
import { HitRow, type UiHit } from "./primitives";

/** A hit range inside the card, addressed by the card's own first row. */
export interface AnnotationCardHit extends UiHit {
  row: number;
}

export interface AnnotationCardModel {
  /** What these annotations are attached to, already compacted. */
  target: string;
  items: readonly ReviewItem[];
  /** The annotation the footer keys and buttons act on. */
  index: number;
  onAnnotateAgain(): void;
  onEdit(): void;
  onDelete(): void;
  onClose(): void;
}

export interface AnnotationCardFrame {
  rows: string[];
  hits: AnnotationCardHit[];
}

/** Below this the card cannot hold a status word and any text beside it. */
export const MIN_ANNOTATION_CARD_WIDTH = 28;
const BORDER_ROWS = 2;
const MIN_BODY_ROWS = 1;

interface FooterButton {
  key: string;
  label: string;
  action: () => void;
}

/**
 * What is already written at one line, opened from its rail mark. The card
 * answers "what did I say here", then offers the two things a reader wants
 * next: another annotation on the same line, or a change to the one that is
 * already there.
 */
export class AnnotationCard {
  #scroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  /** Body row index to the annotation it belongs to, so a click resolves. */
  #rowItems: number[] = [];
  #offset = 0;

  /**
   * Rows for the card, clipped to `maxHeight`. The caller places the returned
   * rows itself, so the natural height is the returned row count.
   */
  render(theme: Theme, width: number, maxHeight: number, model: AnnotationCardModel): AnnotationCardFrame {
    const safeWidth = Math.max(1, Math.trunc(width));
    if (safeWidth < MIN_ANNOTATION_CARD_WIDTH || maxHeight < BORDER_ROWS + MIN_BODY_ROWS) {
      return { rows: [], hits: [] };
    }
    const inner = safeWidth - 4;
    const body = this.#bodyRows(theme, inner, model);
    const bodyHeight = Math.max(MIN_BODY_ROWS, Math.min(body.length, maxHeight - BORDER_ROWS));
    this.#scroll.setLines(body);
    this.#scroll.setHeight(bodyHeight);
    this.#scroll.setScrollOffset(this.#clampOffset(body.length, bodyHeight, model.index));
    this.#offset = this.#scroll.getScrollOffset();

    const edge = theme.fg("borderMuted", "│");
    const top = this.#topRow(theme, safeWidth, model);
    const bottom = this.#bottomRow(theme, safeWidth, model);
    const rows = [
      top.text,
      ...this.#scroll.render(inner).map(row => `${edge} ${padColumn(row, inner)} ${edge}`),
      bottom.text,
    ];
    const hits: AnnotationCardHit[] = [
      ...top.hits.map(hit => ({ ...hit, row: 0 })),
      ...bottom.hits.map(hit => ({ ...hit, row: rows.length - 1 })),
    ];
    return { rows, hits };
  }

  /** Resolve a card row to the annotation it shows, or undefined for chrome. */
  itemIndexAt(cardRow: number): number | undefined {
    const bodyRow = cardRow - 1 + this.#offset;
    if (bodyRow < 0) return undefined;
    return this.#rowItems[bodyRow];
  }

  scroll(delta: number): void {
    this.#scroll.scroll(delta);
    this.#offset = this.#scroll.getScrollOffset();
  }

  invalidate(): void {
    this.#scroll.invalidate();
  }

  /** Keep the acted-on annotation in view when the keyboard moves the selection. */
  #clampOffset(rowCount: number, height: number, index: number): number {
    const first = this.#rowItems.indexOf(index);
    const maxOffset = Math.max(0, rowCount - height);
    let offset = Math.min(this.#offset, maxOffset);
    if (first >= 0) {
      if (first < offset) offset = first;
      else if (first >= offset + height) offset = Math.min(maxOffset, first - height + 1);
    }
    return offset;
  }

  #bodyRows(theme: Theme, inner: number, model: AnnotationCardModel): string[] {
    const leadWidth = model.items.reduce((widest, item) => Math.max(widest, item.status.length), 0);
    const gutter = 2 + leadWidth + 2;
    const textWidth = Math.max(1, inner - gutter);
    const indent = " ".repeat(gutter);
    const rows: string[] = [];
    this.#rowItems = [];

    model.items.forEach((item, index) => {
      // The blank separator belongs to the block that ended, so clicking it
      // selects that annotation and scrolling to `index` lands on its status.
      if (index > 0) {
        rows.push("");
        this.#rowItems.push(index - 1);
      }
      const marker = index === model.index ? theme.fg("accent", `${theme.nav.expand} `) : "  ";
      const word = item.status;
      const lead = `${statusMark(theme, item)}${" ".repeat(leadWidth - word.length + 1)}${theme.fg(statusColor(item), word)}`;
      const text = previewLines(item.body, textWidth);
      rows.push(`${marker}${lead}  ${text[0] ?? ""}`);
      this.#rowItems.push(index);
      for (const line of text.slice(1)) {
        rows.push(`${indent}${line}`);
        this.#rowItems.push(index);
      }
      if (item.staleReason !== undefined) {
        for (const line of previewLines(item.staleReason, textWidth)) {
          rows.push(`${indent}${theme.fg("warning", line)}`);
          this.#rowItems.push(index);
        }
      }
    });
    return rows.length > 0 ? rows : [theme.fg("dim", "Nothing is annotated here yet.")];
  }

  #topRow(theme: Theme, width: number, model: AnnotationCardModel): { text: string; hits: UiHit[] } {
    const count = model.items.length;
    const title = `${count} annotation${count === 1 ? "" : "s"} on ${model.target}`;
    const row = new HitRow().add(theme.fg("borderMuted", `${theme.boxRound.topLeft}${theme.boxRound.horizontal} `));
    const titleBudget = Math.max(1, width - 3 - 6);
    const fitted = truncateToWidth(title, titleBudget, "");
    row.add(theme.fg("accent", theme.bold(fitted)));
    const fill = Math.max(0, width - 3 - visibleWidth(fitted) - 6);
    row.add(theme.fg("borderMuted", ` ${theme.boxRound.horizontal.repeat(fill)}${theme.boxRound.horizontal} `));
    row.button(theme.fg("muted", closeMark(theme)), model.onClose);
    row.add(theme.fg("borderMuted", ` ${theme.boxRound.topRight}`));
    return { text: row.text, hits: row.hits };
  }

  /**
   * The bottom border carries the card's actions, so the reader never has to
   * guess what can be done with what they just opened.
   */
  #bottomRow(theme: Theme, width: number, model: AnnotationCardModel): { text: string; hits: UiHit[] } {
    const selected = model.items[model.index];
    const buttons: FooterButton[] = [
      { key: "a", label: "annotate again", action: model.onAnnotateAgain },
      ...(selected?.status === "pending"
        ? [{ key: "e", label: "edit", action: model.onEdit }]
        : []),
      ...(selected === undefined ? [] : [{ key: "d", label: "delete", action: model.onDelete }]),
      { key: "esc", label: "close", action: model.onClose },
    ];
    for (let count = buttons.length; count > 0; count -= 1) {
      const row = new HitRow().add(theme.fg("borderMuted", `${theme.boxRound.bottomLeft}${theme.boxRound.horizontal} `));
      for (const button of buttons.slice(0, count)) {
        if (row.width > 3) row.add("  ");
        const from = row.width;
        row.add(`${theme.fg("muted", button.key)} ${theme.fg("dim", button.label)}`);
        row.hits.push({ from, to: row.width, action: button.action });
      }
      const fill = width - row.width - 2;
      if (fill < 1) continue;
      row.add(theme.fg("borderMuted", ` ${theme.boxRound.horizontal.repeat(fill - 1)}${theme.boxRound.bottomRight}`));
      return { text: row.text, hits: row.hits };
    }
    return { text: theme.fg("borderMuted", `${theme.boxRound.bottomLeft}${theme.boxRound.horizontal.repeat(Math.max(0, width - 2))}${theme.boxRound.bottomRight}`), hits: [] };
  }
}
