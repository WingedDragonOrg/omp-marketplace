import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { Editor, ScrollView, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sidebarPanelAtRow, type AnnotateSidebarGeometry, type AnnotateSidebarPanel } from "./layout";
import { closeMark, padColumn, panelHeading } from "./presentation";
import type { AnnotateLayout } from "./types";

export interface DockListModel {
  heading: string;
  rows: readonly string[];
  /** Row the list keeps in view; the hovered row wins over the selected one. */
  index: number;
  count: number;
  focused: boolean;
}

export interface DockDraftModel {
  heading: string;
  focused: boolean;
  /** A target is set, so discarding it is a real action. */
  hasTarget: boolean;
  onDiscard: () => void;
}

export interface DockModel {
  sources: DockListModel;
  draft: DockDraftModel;
  queue: DockListModel;
}

interface DockHit {
  row: number;
  from: number;
  to: number;
  action: () => void;
}

/** Keep the chosen row near the middle so its neighbours stay readable. */
function centerOffset(index: number, rowCount: number, height: number): number {
  if (height <= 0 || rowCount <= height) return 0;
  return Math.max(0, Math.min(index - Math.floor(height / 2), rowCount - height));
}

/**
 * The dock is the desk beside the page: what can be pointed at, what is being
 * written, and what is stacked up to send, in that order.
 */
export class AnnotateDock {
  readonly editor: Editor;
  #sourceScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #queueScroll = new ScrollView([], { height: 1, scrollbar: "auto" });
  #geometry: AnnotateSidebarGeometry = {
    sourceStart: 1,
    sourceHeight: 0,
    draftStart: 0,
    draftHeight: 0,
    reviewStart: 0,
    reviewHeight: 0,
  };
  #hits: DockHit[] = [];

  constructor() {
    this.editor = new Editor(getEditorTheme());
    this.editor.setPromptGutter("> ");
    this.editor.setScrollbarVisible(true);
    this.editor.setUseTerminalCursor(false);
  }

  get geometry(): AnnotateSidebarGeometry {
    return this.#geometry;
  }

  render(theme: Theme, layout: AnnotateLayout, model: DockModel): string[] {
    const width = Math.max(1, layout.rightWidth);
    const rows: string[] = [];
    this.#hits = [];

    rows.push(panelHeading(theme, model.sources.heading, model.sources.focused, width));
    this.#geometry.sourceStart = rows.length;
    this.#sourceScroll.setLines([...model.sources.rows]);
    this.#sourceScroll.setHeight(Math.max(1, layout.sourceHeight));
    this.#sourceScroll.setScrollOffset(
      centerOffset(model.sources.index, model.sources.count, layout.sourceHeight),
    );
    const sourceRows = layout.sourceHeight > 0 ? this.#sourceScroll.render(width).slice(0, layout.sourceHeight) : [];
    rows.push(...sourceRows);
    // Panel spans are the rows actually drawn, not the reserved heights: an
    // empty draft editor renders fewer rows than it reserves, so a click map
    // built from reserved heights would send queue clicks into the draft.
    this.#geometry.sourceHeight = sourceRows.length;

    rows.push(this.#draftHeading(theme, width, rows.length, model.draft));
    this.#geometry.draftStart = rows.length;
    this.editor.setMaxHeight(Math.max(1, layout.draftHeight));
    const draftRows = layout.draftHeight > 0 ? this.editor.render(width).slice(0, layout.draftHeight) : [];
    rows.push(...draftRows);
    this.#geometry.draftHeight = draftRows.length;

    rows.push(panelHeading(theme, model.queue.heading, model.queue.focused, width));
    this.#geometry.reviewStart = rows.length;
    this.#queueScroll.setLines([...model.queue.rows]);
    this.#queueScroll.setHeight(Math.max(1, layout.reviewHeight));
    this.#queueScroll.setScrollOffset(centerOffset(model.queue.index, model.queue.rows.length, layout.reviewHeight));
    const queueRows = layout.reviewHeight > 0 ? this.#queueScroll.render(width).slice(0, layout.reviewHeight) : [];
    rows.push(...queueRows);
    this.#geometry.reviewHeight = queueRows.length;
    return rows.slice(0, layout.bodyHeight);
  }

  /** The draft heading carries its own discard control so the draft is never a trap. */
  #draftHeading(theme: Theme, width: number, row: number, model: DockDraftModel): string {
    if (!model.hasTarget || width < 8) return panelHeading(theme, model.heading, model.focused, width);
    const labelWidth = width - 2;
    const heading = padColumn(panelHeading(theme, model.heading, model.focused, labelWidth), labelWidth);
    this.#hits.push({ row, from: labelWidth, to: width, action: model.onDiscard });
    return truncateToWidth(`${heading}${theme.fg("muted", ` ${closeMark(theme)}`)}`, width);
  }

  panelAt(row: number): AnnotateSidebarPanel | undefined {
    return sidebarPanelAtRow(row, this.#geometry);
  }

  hitAt(row: number, column: number): (() => void) | undefined {
    return this.#hits.find(hit => hit.row === row && column >= hit.from && column < hit.to)?.action;
  }

  /** Resolve a dock row to a source index, or undefined when the row is chrome. */
  sourceIndexAt(row: number, count: number): number | undefined {
    if (row < this.#geometry.sourceStart) return undefined;
    const index = this.#sourceScroll.getScrollOffset() + row - this.#geometry.sourceStart;
    return index >= 0 && index < count ? index : undefined;
  }

  queueIndexAt(row: number, count: number): number | undefined {
    if (row < this.#geometry.reviewStart) return undefined;
    const index = this.#queueScroll.getScrollOffset() + row - this.#geometry.reviewStart;
    return index >= 0 && index < count ? index : undefined;
  }

  scrollAt(row: number, delta: number): void {
    const panel = this.panelAt(row);
    if (panel === "sources") this.#sourceScroll.scroll(delta);
    else if (panel === "reviews") this.#queueScroll.scroll(delta);
  }

  invalidate(): void {
    this.#sourceScroll.invalidate();
    this.#queueScroll.invalidate();
    this.editor.invalidate();
  }
}
