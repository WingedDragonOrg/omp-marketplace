import type { AnnotateLayout } from "./types";

const SIDEBAR_CHROME = 3;
const MAX_DRAFT_HEIGHT = 8;

/**
 * Keep the evidence canvas dominant while reserving enough dock width for a
 * readable source row, draft target, and review status. A collapsed dock hands
 * the whole frame to the evidence pane for reading long hunks.
 */
export function resolveAnnotateLayout(width: number, height: number, dockCollapsed = false): AnnotateLayout {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
  const bodyHeight = Number.isFinite(height) ? Math.max(1, Math.trunc(height)) : 1;
  if (dockCollapsed) {
    return {
      leftWidth: safeWidth,
      dividerWidth: 0,
      rightWidth: 0,
      bodyHeight,
      sourceHeight: 0,
      draftHeight: 0,
      reviewHeight: 0,
    };
  }

  const dividerWidth = safeWidth >= 3 ? 1 : 0;
  const usableWidth = Math.max(1, safeWidth - dividerWidth);
  const narrowness = Math.max(0, Math.min(1, (96 - safeWidth) / 36));
  const sidebarRatio = 0.3 + narrowness * 0.1;
  let rightWidth = Math.max(1, Math.floor(usableWidth * sidebarRatio));
  let leftWidth = usableWidth - rightWidth;
  if (leftWidth < 1) {
    leftWidth = 1;
    rightWidth = Math.max(0, usableWidth - leftWidth);
  }

  const chrome = Math.min(SIDEBAR_CHROME, bodyHeight);
  const available = Math.max(0, bodyHeight - chrome);
  let sourceHeight = available > 0 ? Math.max(1, Math.floor(available * 0.52)) : 0;
  let draftHeight =
    available - sourceHeight > 0
      ? Math.max(1, Math.min(MAX_DRAFT_HEIGHT, Math.floor(available * 0.24)))
      : 0;
  let reviewHeight = Math.max(0, available - sourceHeight - draftHeight);

  // At small heights every workflow stage gets one row before sources receive
  // the remainder. The queue is the safety check before sending feedback.
  if (available >= 3 && reviewHeight === 0) {
    reviewHeight = 1;
    if (sourceHeight > 1) sourceHeight -= 1;
    else if (draftHeight > 1) draftHeight -= 1;
  }
  if (sourceHeight + draftHeight + reviewHeight > available) {
    sourceHeight = Math.max(0, available - draftHeight - reviewHeight);
  }

  return {
    leftWidth,
    dividerWidth,
    rightWidth,
    bodyHeight,
    sourceHeight,
    draftHeight,
    reviewHeight,
  };
}

export interface AnnotateSidebarGeometry {
  sourceStart: number;
  sourceHeight: number;
  draftStart: number;
  draftHeight: number;
  reviewStart: number;
  reviewHeight: number;
}

export type AnnotateSidebarPanel = "sources" | "draft" | "reviews";

/** Resolve a dock row to the panel whose heading or content it controls. */
export function sidebarPanelAtRow(
  row: number,
  geometry: AnnotateSidebarGeometry,
): AnnotateSidebarPanel | undefined {
  if (!Number.isInteger(row) || row < 0) return undefined;
  const sourceHeading = geometry.sourceStart - 1;
  if (
    row === sourceHeading ||
    (row >= geometry.sourceStart && row < geometry.sourceStart + geometry.sourceHeight)
  ) {
    return "sources";
  }
  const draftHeading = geometry.draftStart - 1;
  if (
    row === draftHeading ||
    (row >= geometry.draftStart && row < geometry.draftStart + geometry.draftHeight)
  ) {
    return "draft";
  }
  const reviewHeading = geometry.reviewStart - 1;
  if (
    row === reviewHeading ||
    (row >= geometry.reviewStart && row < geometry.reviewStart + geometry.reviewHeight)
  ) {
    return "reviews";
  }
  return undefined;
}
