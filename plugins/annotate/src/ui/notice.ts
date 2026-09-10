export type NoticeLevel = "info" | "warning" | "error";

export interface Notice {
  message: string;
  level: NoticeLevel;
  /** Wall-clock ms after which the notice stops showing; errors stay until replaced. */
  expiresAt: number | undefined;
}

/**
 * Confirmations should not outlive the glance that follows them, warnings need
 * a second read, and failures stay until the next action replaces them.
 */
const NOTICE_TTL_MS: Record<NoticeLevel, number | undefined> = {
  info: 4_000,
  warning: 8_000,
  error: undefined,
};

export function createNotice(message: string, level: NoticeLevel = "info", now = Date.now()): Notice {
  const ttl = NOTICE_TTL_MS[level];
  return { message, level, expiresAt: ttl === undefined ? undefined : now + ttl };
}

/** Give the header back to the action hint once a notice has had its dwell time. */
export function activeNotice(notice: Notice | undefined, now = Date.now()): Notice | undefined {
  if (notice === undefined) return undefined;
  if (notice.expiresAt === undefined) return notice;
  return notice.expiresAt > now ? notice : undefined;
}

/** Milliseconds until a notice expires, so the view can repaint exactly once. */
export function noticeRepaintDelay(notice: Notice | undefined, now = Date.now()): number | undefined {
  if (notice?.expiresAt === undefined) return undefined;
  return Math.max(1, notice.expiresAt - now);
}
