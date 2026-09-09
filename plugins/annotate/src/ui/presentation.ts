import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { wrapTextWithAnsi, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { CodeSnapshot, ReviewItem } from "../model";

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
  return parts.join(" / ");
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
  return changes.length > 0 ? `${fileLabel} / ${changes.join(" / ")}` : fileLabel;
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

export function statusLabel(item: ReviewItem): string {
  if (item.status === "stale") return `stale: ${item.staleReason ?? "reference changed"}`;
  return item.status;
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

export function reviewItemLocation(item: ReviewItem): string {
  if (item.anchor.kind === "code") {
    const revision = item.anchor.commitOid === undefined ? "" : `commit ${item.anchor.commitOid.slice(0, 7)} / `;
    const start = item.anchor.newStart || item.anchor.oldStart;
    const end = item.anchor.newEnd || item.anchor.oldEnd;
    const lineRange = start === end ? `${start}` : `${start}–${end}`;
    const textRange =
      item.anchor.startOffset === undefined ? "" : ` / text ${item.anchor.startOffset}–${item.anchor.endOffset}`;
    return `${revision}${oneLine(item.anchor.filePath, 80)}:${lineRange}${textRange}`;
  }
  return `entry ${oneLine(item.anchor.entryId, 24)}:${item.anchor.start}–${item.anchor.end}`;
}

export function panelHeading(theme: Theme, label: string, focused: boolean): string {
  const marker = focused ? theme.fg("accent", "▸ ") : "  ";
  const color = focused ? "accent" : "muted";
  return theme.fg(color, `${marker}${theme.bold(label)}`);
}

export function focusHint(theme: Theme, focused: boolean, text: string): string {
  return theme.fg(focused ? "muted" : "dim", text);
}
