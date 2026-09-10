import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { HitRow, type UiHit } from "./primitives";
import type { AnnotateTab } from "./types";
import { closeMark } from "./presentation";

export interface ChromeRow {
  text: string;
  hits: UiHit[];
}

export interface HeaderModel {
  /** What is being read right now, already compacted. */
  context: string;
  /** Pre-styled status: a notice, the busy word, or the key hints. */
  status: (budget: number) => string;
  onHelp: () => void;
  onClose: () => void;
}

const MIN_STATUS_WIDTH = 12;

function place(right: HitRow, rightStart: number): UiHit[] {
  return right.hits.map(hit => ({ ...hit, from: hit.from + rightStart, to: hit.to + rightStart }));
}

/**
 * Title, then what is being read, then the status. The status stays left-anchored
 * against the context it explains instead of drifting with the frame width.
 */
export function renderHeader(theme: Theme, width: number, model: HeaderModel): ChromeRow {
  const safeWidth = Math.max(1, Math.trunc(width));
  const left = new HitRow()
    .add(" ")
    .add(theme.bold("Annotate"))
    .add("  ")
    .add(theme.fg("dim", model.context));
  const right = new HitRow()
    .button(theme.fg("muted", "?"), model.onHelp)
    .add("  ")
    .button(theme.fg("muted", closeMark(theme)), model.onClose)
    .add(" ");

  const rightStart = Math.max(0, safeWidth - right.width);
  const statusBudget = rightStart - left.width - 3;
  if (statusBudget < MIN_STATUS_WIDTH) {
    const leftText = truncateToWidth(left.text, Math.max(0, rightStart), "");
    const gap = Math.max(0, rightStart - visibleWidth(leftText));
    return {
      text: truncateToWidth(`${leftText}${" ".repeat(gap)}${right.text}`, safeWidth),
      hits: place(right, rightStart),
    };
  }

  const status = truncateToWidth(model.status(statusBudget), statusBudget, "");
  const filled = `${left.text}   ${status}`;
  const gap = Math.max(0, rightStart - visibleWidth(filled));
  return {
    text: truncateToWidth(`${filled}${" ".repeat(gap)}${right.text}`, safeWidth),
    hits: place(right, rightStart),
  };
}

export interface ToolbarModel {
  tab: AnnotateTab;
  /** Which revision the Code tab reads, or the session for assistant output. */
  sourceLabel: string;
  revisionsOpen: boolean;
  viewLabel: string | undefined;
  pendingCount: number;
  staleCount: number;
  onTab: (tab: AnnotateTab) => void;
  onRevisions: () => void;
  onView: () => void;
  onSend: () => void;
  onRefresh: () => void;
}

/** Tabs and the current revision on the left, the two irreversible-ish actions right. */
export function renderToolbar(theme: Theme, width: number, model: ToolbarModel): ChromeRow {
  const safeWidth = Math.max(1, Math.trunc(width));
  const row = new HitRow().add(" ");
  for (const tab of ["code", "assistant"] as const) {
    const label = tab === "code" ? " Code " : " Assistant ";
    row.button(
      model.tab === tab
        ? theme.bgFill("selectedBg", theme.fgOnBg("text", "selectedBg", theme.bold(label)))
        : theme.fg("muted", label),
      () => model.onTab(tab),
    );
    row.add(" ");
  }
  if (model.tab === "code") {
    row.button(
      theme.fg(model.revisionsOpen ? "accent" : "dim", `${model.sourceLabel} ${theme.nav.collapse}`),
      () => model.onRevisions(),
    );
    if (model.viewLabel !== undefined) {
      row.add("  ").button(theme.fg("muted", `view ${model.viewLabel}`), () => model.onView());
    }
  } else {
    row.add(theme.fg("dim", model.sourceLabel));
  }

  const sendLabel =
    model.pendingCount === 0
      ? " Send "
      : model.staleCount === 0
        ? ` Send ${model.pendingCount} `
        : ` Send ${model.pendingCount} (${model.staleCount} stale) `;
  const sendChip =
    model.pendingCount > 0
      ? theme.bgFill("toolPendingBg", theme.fgOnBg("text", "toolPendingBg", sendLabel))
      : theme.fg("dim", sendLabel);
  const right = new HitRow()
    .button(sendChip, () => model.onSend())
    .add("  ")
    .button(theme.fg("muted", "Refresh"), () => model.onRefresh())
    .add(" ");

  const rightStart = Math.max(0, safeWidth - right.width);
  const leftText = truncateToWidth(row.text, Math.max(0, rightStart - 1), "");
  const leftWidth = visibleWidth(leftText);
  const gap = Math.max(0, rightStart - leftWidth);
  return {
    text: truncateToWidth(`${leftText}${" ".repeat(gap)}${right.text}`, safeWidth),
    hits: [
      ...row.hits.filter(hit => hit.from < leftWidth).map(hit => ({ ...hit, to: Math.min(hit.to, leftWidth) })),
      ...place(right, rightStart),
    ],
  };
}
