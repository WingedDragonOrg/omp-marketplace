import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { Ellipsis, wrapTextWithAnsi, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AssistantTextEntry, CodeSnapshot, ReviewItem } from "../model";
import type { AnnotateKeyHint } from "./keymap";
import type { CodeSelection } from "./types";

export interface ReviewQueueSummary {
  total: number;
  pending: number;
  stale: number;
  sent: number;
}

export function summarizeReviewQueue(items: readonly ReviewItem[]): ReviewQueueSummary {
  let pending = 0;
  let stale = 0;
  let sent = 0;
  for (const item of items) {
    if (item.status === "pending") pending += 1;
    else if (item.status === "stale") stale += 1;
    else sent += 1;
  }
  return { total: items.length, pending, stale, sent };
}

/** Short status text for the dock and header; pending work is always first. */
export function formatReviewQueueSummary(items: readonly ReviewItem[]): string {
  const summary = summarizeReviewQueue(items);
  if (summary.total === 0) return "empty";
  const parts: string[] = [];
  if (summary.pending > 0) parts.push(`${summary.pending} pending`);
  if (summary.stale > 0) parts.push(`${summary.stale} stale`);
  if (summary.sent > 0) parts.push(`${summary.sent} sent`);
  return parts.join(", ");
}

export function formatCodeSourceSummary(snapshot: CodeSnapshot | undefined): string {
  if (!snapshot || snapshot.files.length === 0) return "No changed files";
  let additions = 0;
  let deletions = 0;
  for (const file of snapshot.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "addition") additions += 1;
        else if (line.kind === "deletion") deletions += 1;
      }
    }
  }
  const fileLabel = `${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"}`;
  const changes = [additions > 0 ? `+${additions}` : "", deletions > 0 ? `-${deletions}` : ""].filter(Boolean);
  return changes.length > 0 ? `${fileLabel}, ${changes.join(", ")}` : fileLabel;
}

export function formatCommitSourceSummary(count: number): string {
  if (count <= 0) return "No recent commits";
  return `${count} recent commit${count === 1 ? "" : "s"}`;
}

export function formatAssistantSourceSummary(count: number): string {
  if (count <= 0) return "No visible messages";
  return `${count} message${count === 1 ? "" : "s"}`;
}

export function oneLine(value: string, maxLength = 160): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
    if (char === "\r" || char === "\n" || char === "\t") return " ";
    return `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`;
  });
  const normalized = sanitized.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/** Preserve the filename tail when a path must fit a narrow dock row. */
export function compactPath(value: string, maxLength = 48): string {
  const safeWidth = Math.max(1, Math.trunc(maxLength));
  const normalized = oneLine(value, Number.MAX_SAFE_INTEGER);
  if (visibleWidth(normalized) <= safeWidth) return normalized;
  const separator = normalized.lastIndexOf("/");
  if (separator >= 0 && separator < normalized.length - 1) {
    const tail = normalized.slice(separator + 1);
    if (visibleWidth(tail) + 2 <= safeWidth) return `…/${tail}`;
    return compactIdentifier(tail, safeWidth);
  }
  return truncateToWidth(normalized, safeWidth, Ellipsis.Unicode);
}

function compactIdentifier(value: string, maxLength: number): string {
  const safeWidth = Math.max(1, Math.trunc(maxLength));
  const normalized = oneLine(value, Number.MAX_SAFE_INTEGER);
  if (visibleWidth(normalized) <= safeWidth) return normalized;
  if (safeWidth === 1) return "…";
  const tailWidth = Math.max(1, safeWidth - 1);
  return `…${truncateToWidth(normalized.slice(-tailWidth), tailWidth, Ellipsis.Omit)}`;
}

export function formatCodeSelectionTarget(selection: CodeSelection, maxLength = 72): string {
  const safeWidth = Math.max(1, Math.trunc(maxLength));
  const first = selection.lines[0] ?? selection.line;
  const last = selection.lines[selection.lines.length - 1] ?? first;
  const lineLabel =
    selection.lines.length > 1 ? `${codeLineLabel(first)}–${codeLineLabel(last)}` : codeLineLabel(first);
  const textRange =
    selection.startOffset === undefined || selection.endOffset === undefined
      ? ""
      : ` #${selection.startOffset}–${selection.endOffset}`;
  const revision = selection.commitOid === undefined ? "" : `@${selection.commitOid.slice(0, 7)} `;
  const suffix = `:${lineLabel}${textRange}`;
  if (safeWidth <= visibleWidth(revision) + visibleWidth(suffix)) {
    const pathBudget = safeWidth - visibleWidth(suffix);
    if (pathBudget > 0) return `${compactPath(selection.filePath, pathBudget)}${suffix}`;
    return truncateToWidth(suffix, safeWidth, Ellipsis.Omit);
  }
  const pathBudget = safeWidth - visibleWidth(revision) - visibleWidth(suffix);
  return `${revision}${compactPath(selection.filePath, pathBudget)}${suffix}`;
}

export function formatAssistantTarget(
  entry: Pick<AssistantTextEntry, "id">,
  selection: { start: number; end: number } | undefined,
  maxLength = 72,
): string {
  const safeWidth = Math.max(1, Math.trunc(maxLength));
  const range = selection === undefined ? "whole message" : `${selection.start}–${selection.end}`;
  const rangeLabel = selection === undefined ? range : `chars ${range}`;
  const prefix = "message ";
  const suffix = ` ${rangeLabel}`;
  if (safeWidth < visibleWidth(prefix) + visibleWidth(suffix) + 1) {
    return truncateToWidth(range, safeWidth, Ellipsis.Omit);
  }
  const idBudget = safeWidth - visibleWidth(prefix) - visibleWidth(suffix);
  return `${prefix}${compactIdentifier(entry.id, idBudget)}${suffix}`;
}

export function previewLines(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  const rows: string[] = [];
  for (const line of normalized.split("\n")) {
    const wrapped = wrapTextWithAnsi(line, safeWidth);
    if (wrapped.length === 0) rows.push("");
    else rows.push(...wrapped);
  }
  return rows.length > 0 ? rows : [""];
}

export function padColumn(value: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const clipped = truncateToWidth(value, safeWidth, "");
  return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

export function composeColumns(
  leftRows: readonly string[],
  rightRows: readonly string[],
  leftWidth: number,
  divider: string,
  rightWidth: number,
): string[] {
  const rowCount = Math.max(leftRows.length, rightRows.length);
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    rows.push(
      `${padColumn(leftRows[index] ?? "", leftWidth)}${divider}${padColumn(rightRows[index] ?? "", rightWidth)}`,
    );
  }
  return rows;
}

export function statusColor(item: ReviewItem): "accent" | "success" | "warning" {
  if (item.status === "sent") return "success";
  if (item.status === "stale") return "warning";
  return "accent";
}

export function codeLineLabel(line: { kind: "context" | "addition" | "deletion"; oldLine?: number; newLine?: number }): string {
  const marker = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
  const number = line.newLine ?? line.oldLine ?? 0;
  return `${marker}${number}`;
}

export function reviewItemLocation(item: ReviewItem, maxLength = 72): string {
  const safeWidth = Math.max(1, Math.trunc(maxLength));
  if (item.anchor.kind === "code") {
    const revision = item.anchor.commitOid === undefined ? "" : `@${item.anchor.commitOid.slice(0, 7)} `;
    const start = item.anchor.newStart || item.anchor.oldStart;
    const end = item.anchor.newEnd || item.anchor.oldEnd;
    const lineRange = start === end ? `${start}` : `${start}–${end}`;
    const textRange =
      item.anchor.startOffset === undefined || item.anchor.endOffset === undefined
        ? ""
        : ` #${item.anchor.startOffset}–${item.anchor.endOffset}`;
    const suffix = `:${lineRange}${textRange}`;
    const fixedWidth = visibleWidth(revision) + visibleWidth(suffix);
    if (safeWidth <= fixedWidth) return truncateToWidth(`${lineRange}${textRange}`, safeWidth, Ellipsis.Omit);
    const pathBudget = safeWidth - fixedWidth;
    return `${revision}${compactPath(item.anchor.filePath, pathBudget)}${suffix}`;
  }
  const prefix = "message ";
  const range = `${item.anchor.start}–${item.anchor.end}`;
  const suffix = `:${range}`;
  if (safeWidth <= visibleWidth(prefix) + visibleWidth(suffix)) {
    return truncateToWidth(range, safeWidth, Ellipsis.Omit);
  }
  const idBudget = safeWidth - visibleWidth(prefix) - visibleWidth(suffix);
  return `${prefix}${compactIdentifier(item.anchor.entryId, idBudget)}${suffix}`;
}

/**
 * Workbench mark vocabulary. Every mark resolves through the active theme so it
 * follows the reader's symbol preset (`unicode` / `nerd` / `ascii`) exactly like
 * OMP's own chrome, instead of hardcoding a glyph the `ascii` preset cannot draw:
 *   focused section  theme.nav.expand      list cursor     theme.nav.cursor
 *   parked selection theme.format.bullet   disclosure      theme.nav.collapse
 *   annotation rail  theme.boxSharp.* + theme.format.bullet
 *   card frame       theme.boxRound.*
 * `close` is the one mark with no theme symbol, so it degrades to `x` under the
 * `ascii` preset where a cross glyph would not render.
 */
export function closeMark(theme: Theme): string {
  return theme.getSymbolPreset() === "ascii" ? "x" : "✕";
}

/** The review status as OMP's own status glyph, so the queue reads before text does. */
export function statusMark(theme: Theme, item: ReviewItem): string {
  if (item.status === "stale") return theme.styledSymbol("status.warning", "warning");
  if (item.status === "sent") return theme.styledSymbol("status.success", "success");
  return theme.styledSymbol("status.pending", statusColor(item));
}

export function panelHeading(theme: Theme, label: string, focused: boolean, width?: number): string {
  const marker = focused ? theme.fg("accent", `${theme.nav.expand} `) : "  ";
  const color = focused ? "accent" : "muted";
  const rendered = theme.fg(color, `${marker}${theme.bold(label)}`);
  return width === undefined ? rendered : truncateToWidth(rendered, Math.max(1, Math.trunc(width)), "");
}

/**
 * Render `key label` pairs, dropping the least useful pair first so the header
 * always shows the most useful keys it can fit rather than a clipped list.
 */
export function renderKeyHints(theme: Theme, hints: readonly AnnotateKeyHint[], width: number): string {
  const safeWidth = Math.max(1, Math.trunc(width));
  const pairs = hints.map(hint => `${theme.fg("muted", hint.key)} ${theme.fg("dim", hint.label)}`);
  for (let count = pairs.length; count > 1; count -= 1) {
    const line = pairs.slice(0, count).join("   ");
    if (visibleWidth(line) <= safeWidth) return line;
  }
  return truncateToWidth(pairs[0] ?? "", safeWidth, "");
}
