import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AnnotateKeySection } from "./keymap";
import { padColumn } from "./presentation";

/** Keys never take more than this share of a column; labels carry the meaning. */
const KEY_SHARE = 0.45;
const COLUMN_GUTTER = 3;
const MIN_COLUMN_WIDTH = 30;
const MAX_COLUMNS = 3;

interface HelpBlock {
  rows: string[];
  keyWidth: number;
}

/**
 * Pack the sections into as few tall columns as the pane can show, so the whole
 * keymap stays on one screen instead of asking the reader to scroll for it.
 */
function columnCount(width: number, blockCount: number): number {
  const fit = Math.floor((width + COLUMN_GUTTER) / (MIN_COLUMN_WIDTH + COLUMN_GUTTER));
  return Math.max(1, Math.min(MAX_COLUMNS, blockCount, fit));
}

function distribute(blocks: readonly HelpBlock[], columns: number): HelpBlock[][] {
  const target = Math.ceil(blocks.reduce((total, block) => total + block.rows.length, 0) / columns);
  const groups: HelpBlock[][] = [];
  let current: HelpBlock[] = [];
  let height = 0;
  for (const block of blocks) {
    if (current.length > 0 && height + block.rows.length > target && groups.length < columns - 1) {
      groups.push(current);
      current = [];
      height = 0;
    }
    current.push(block);
    height += block.rows.length;
  }
  groups.push(current);
  while (groups.length < columns) groups.push([]);
  return groups;
}

/**
 * Render the keymap as a reference sheet. The caller decides how many rows it
 * can show, so a short terminal scrolls the sheet instead of hiding keys.
 */
export function renderHelpSheet(
  theme: Theme,
  width: number,
  sections: readonly AnnotateKeySection[],
): string[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const blocks: HelpBlock[] = sections.map(section => ({
    rows: [section.title, ...section.rows.map(row => `${row.key}\u0000${row.label}`), ""],
    keyWidth: section.rows.reduce((widest, row) => Math.max(widest, visibleWidth(row.key)), 0),
  }));

  const columns = columnCount(safeWidth, blocks.length);
  const groups = distribute(blocks, columns);
  const columnWidth = Math.max(
    MIN_COLUMN_WIDTH,
    Math.floor((safeWidth - COLUMN_GUTTER * (columns - 1)) / columns),
  );
  const keyLimit = Math.max(2, Math.floor(columnWidth * KEY_SHARE));

  const rendered: string[][] = groups.map(group => {
    const rows: string[] = [];
    for (const block of group) {
      for (const row of block.rows) {
        const separator = row.indexOf("\u0000");
        if (separator < 0) {
          rows.push(row.length === 0 ? "" : theme.fg("accent", theme.bold(row)));
          continue;
        }
        const key = row.slice(0, separator);
        const label = row.slice(separator + 1);
        const keyCell = padColumn(
          truncateToWidth(theme.fg("muted", key), keyLimit, ""),
          Math.min(block.keyWidth, keyLimit),
        );
        rows.push(truncateToWidth(`  ${keyCell}  ${theme.fg("text", label)}`, columnWidth, ""));
      }
    }
    return rows;
  });

  const rowCount = Math.max(...rendered.map(rows => rows.length), 0);
  const lines: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const cells = rendered.map(rows => padColumn(rows[index] ?? "", columnWidth));
    lines.push(truncateToWidth(cells.join(" ".repeat(COLUMN_GUTTER)), safeWidth, ""));
  }
  return lines;
}
