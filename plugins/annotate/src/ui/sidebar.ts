import type { Theme } from "@oh-my-pi/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AssistantTextEntry, DiffFile, ReviewItem } from "../model";
import type { GitCommit } from "../git";
import { getLanguageFromPath } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { oneLine, reviewItemLocation, statusColor, statusMark } from "./presentation";

export type SidebarSource =
  | { kind: "file"; file: DiffFile }
  | { kind: "working-tree"; summary: string }
  | { kind: "commit"; commit: GitCommit }
  | { kind: "assistant"; entry: AssistantTextEntry };

export type SidebarTone = "accent" | "muted" | "warning" | "success";

export interface SidebarRowModel {
  lead: string;
  title: string;
  detail?: string;
  tone: SidebarTone;
  /** Optional theme status glyph rendered before the lead word (queue rows). */
  mark?: string;
}

export interface SidebarRowState {
  selected: boolean;
  focused: boolean;
}

function fileChangeCounts(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "addition") additions += 1;
      else if (line.kind === "deletion") deletions += 1;
    }
  }
  return { additions, deletions };
}

function changeDetail(file: DiffFile): string | undefined {
  if (file.binary) return "binary";
  const { additions, deletions } = fileChangeCounts(file);
  if (additions === 0 && deletions === 0) return undefined;
  return `${additions > 0 ? `+${additions}` : ""}${additions > 0 && deletions > 0 ? " " : ""}${deletions > 0 ? `-${deletions}` : ""}`;
}

/** Convert a source record into the compact identity/detail pair shown in the dock. */
export function sourceRowModel(theme: Theme, source: SidebarSource): SidebarRowModel {
  if (source.kind === "working-tree") {
    return { lead: "working", title: source.summary, tone: "accent", mark: theme.styledSymbol("icon.git", "accent") };
  }
  if (source.kind === "commit") {
    return {
      lead: source.commit.shortOid,
      title: oneLine(source.commit.subject, 160),
      detail: source.commit.timestamp.slice(0, 10),
      tone: "muted",
      mark: theme.styledSymbol("icon.git", "muted"),
    };
  }
  if (source.kind === "assistant") {
    return {
      lead: oneLine(source.entry.id, 18),
      title: oneLine(source.entry.text, 160),
      ...(source.entry.annotationAllowed ? {} : { detail: "browse only" }),
      tone: "muted",
      mark: theme.styledSymbol("icon.session", "muted"),
    };
  }

  const kind = source.file.binary
    ? "B"
    : source.file.oldPath && source.file.oldPath !== source.file.path
      ? "R"
      : "M";
  const detail = changeDetail(source.file);
  return {
    lead: kind,
    title: oneLine(source.file.path, 160),
    ...(detail === undefined ? {} : { detail }),
    tone: source.file.binary ? "warning" : kind === "R" ? "accent" : "muted",
    mark: source.file.binary ? undefined : theme.getLangIconStyled(getLanguageFromPath(source.file.path)),
  };
}

/** Keep queue rows ordered as status, durable target, then why it matters. */
export function reviewRowModel(theme: Theme, item: ReviewItem): SidebarRowModel {
  return {
    lead: item.status,
    title: reviewItemLocation(item),
    detail: oneLine(item.status === "stale" ? item.staleReason ?? "reference changed" : item.body, 120),
    tone: statusColor(item),
    mark: statusMark(theme, item),
  };
}

function fitRow(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.trunc(width));
  const clipped = truncateToWidth(value, safeWidth, "");
  return `${clipped}${" ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)))}`;
}

/** Render one reusable dock row with distinct focused and parked selection states. */
export function renderSidebarRow(
  theme: Theme,
  width: number,
  model: SidebarRowModel,
  state: SidebarRowState,
): string {
  const marker = state.selected
    ? theme.fg(state.focused ? "accent" : "muted", state.focused ? theme.nav.cursor : theme.format.bullet)
    : " ";
  const lead = model.mark === undefined
    ? theme.fg(model.tone, model.lead)
    : `${model.mark} ${theme.fg(model.tone, model.lead)}`;
  const detail = model.detail === undefined ? "" : ` ${theme.fg("dim", model.detail)}`;
  const row = `${marker} ${lead} ${model.title}${detail}`;
  const fitted = fitRow(row, width);
  return state.selected ? theme.bgFill("selectedBg", fitted) : fitted;
}
