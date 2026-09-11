import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  createGitHubReviewSource,
  createReviewWatcher,
  parsePullRequestRef,
  reviewStateFingerprint,
  type GhExecutor,
  type ReviewState,
  type ReviewWatcher,
} from "./review";

const POLL_INTERVAL_MS = 60_000;
const CUSTOM_MESSAGE_TYPE = "octo_pr_update";
const WATCH_ENTRY_TYPE = "com.wingeddragon.octo-pr.watch";

type OctoAction = "watch" | "status" | "cancel";
type OctoParams = {
  action: OctoAction;
  pr?: string;
  fresh?: boolean;
};
type SessionRuntime = {
  sessionId: string;
  ref: string;
  pr: string;
  watcher: ReviewWatcher;
  cancelled: boolean;
  paused: boolean;
};
type PersistedWatch = {
  ref: string;
  headSha?: string;
  lastFingerprint?: string;
};
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};
type UnknownRecord = Record<string, unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, label: string): UnknownRecord {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("expected an object");
    }
    return value as UnknownRecord;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function stateStatus(state: ReviewState, watching: boolean, cancelled: boolean): "ready" | "blocked" | "pending" | "error" | "cancelled" {
  if (cancelled) return "cancelled";
  if (state.error) return "error";
  if (state.ready) return "ready";
  if (state.changesRequested.length > 0) return "blocked";
  return watching ? "pending" : "cancelled";
}

function statusDetails(
  state: ReviewState,
  sessionId: string,
  ref: string,
  watching: boolean,
  cancelled: boolean,
): Record<string, unknown> {
  return {
    status: stateStatus(state, watching, cancelled),
    ready: cancelled ? false : state.ready,
    watching,
    cancelled,
    sessionId,
    pr: ref,
    requiredApprovals: state.requiredApprovals,
    headSha: state.headSha || undefined,
    approvals: state.approvals,
    changesRequested: state.changesRequested,
    reviews: state.reviews,
    issueComments: state.issueComments,
    reviewComments: state.reviewComments,
    threads: state.threads,
    pullRequest: state.pullRequest,
    lastCheckedAt: state.lastCheckedAt,
    error: state.error ?? undefined,
  };
}

function textForStatus(details: Record<string, unknown>): string {
  const status = typeof details.status === "string" ? details.status : "pending";
  const headSha = typeof details.headSha === "string" ? details.headSha : "unknown";
  const approvals = Array.isArray(details.approvals) ? details.approvals.length : 0;
  const changesRequested = Array.isArray(details.changesRequested) ? details.changesRequested.length : 0;
  return `octo_pr ${status}: head=${headSha}, approvals=${approvals}, changes_requested=${changesRequested}. Call octo_pr status for full evidence and continue the octo-pr flow.`;
}

function result(details: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function failure(message: string, sessionId?: string): ToolResult {
  const details: Record<string, unknown> = {
    status: "error",
    ready: false,
    watching: false,
    cancelled: false,
    error: message,
  };
  if (sessionId) details.sessionId = sessionId;
  return {
    content: [{ type: "text", text: `octo_pr error: ${message}` }],
    details,
    isError: true,
  };
}

function currentSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function canonicalPullRequestUrl(input: string): string {
  const parsed = parsePullRequestRef(input);
  return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
}

async function resolveCurrentPullRequest(runGh: GhExecutor, cwd: string): Promise<string> {
  const response = await runGh(["pr", "view", "--json", "number,url"], cwd);
  if (response.code !== 0) {
    throw new Error(`cannot resolve current PR: ${response.stderr.trim() || `exit ${response.code}`}`);
  }
  const value = parseJson(response.stdout, "current PR lookup");
  if (typeof value.url !== "string") {
    throw new Error("current branch PR lookup did not return a URL");
  }
  return canonicalPullRequestUrl(value.url);
}

function persistedWatch(ctx: ExtensionContext): PersistedWatch | undefined {
  const branch = ctx.sessionManager.getBranch();
  let active: PersistedWatch | undefined;
  for (const candidate of branch) {
    if (candidate.type !== "custom" || candidate.customType !== WATCH_ENTRY_TYPE) continue;
    const data = candidate.data;
    if (!isUnknownRecord(data)) continue;
    if (data.action === "watch" && typeof data.ref === "string") {
      try {
        active = {
          ref: canonicalPullRequestUrl(data.ref),
          headSha: typeof data.headSha === "string" ? data.headSha : undefined,
          lastFingerprint: typeof data.lastFingerprint === "string" ? data.lastFingerprint : undefined,
        };
      } catch {
        active = undefined;
      }
    } else if (data.action === "cancel") {
      active = undefined;
    }
  }
  return active;
}

function persistWatch(
  pi: ExtensionAPI,
  action: "watch" | "cancel",
  ref: string,
  state?: ReviewState,
  fingerprint?: string,
): void {
  const data: UnknownRecord = { action, ref };
  if (state) {
    data.headSha = state.headSha;
    data.lastFingerprint = fingerprint ?? reviewStateFingerprint(state);
  }
  pi.appendEntry(WATCH_ENTRY_TYPE, data);
}

function scheduleFor(ctx: ExtensionContext) {
  return {
    setInterval(callback: () => void | Promise<void>, delayMs: number): unknown {
      return ctx.setInterval(callback, delayMs);
    },
    clearInterval(handle: unknown): void {
      ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]);
    },
  };
}

function notifySession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  ref: string,
  state: ReviewState,
): void | Promise<void> {
  if (ctx.sessionManager.getSessionId() !== sessionId) return;
  const details = statusDetails(state, sessionId, ref, true, false);
  const payload = {
    customType: CUSTOM_MESSAGE_TYPE,
    content: [{ type: "text" as const, text: textForStatus(details) }],
    details,
  };
  return pi.sendMessage(payload, { deliverAs: "nextTurn", triggerTurn: true });
}

function runtimeDetails(runtime: SessionRuntime): Record<string, unknown> {
  return statusDetails(
    runtime.watcher.getState(),
    runtime.sessionId,
    runtime.pr,
    !runtime.cancelled && !runtime.paused,
    runtime.cancelled,
  );
}

export default function octoDeveloperExtension(pi: ExtensionAPI): void {
  pi.setLabel("Octo Developer");
  const sessions = new Map<string, SessionRuntime>();
  const runGh: GhExecutor = async (args, cwd) => {
    const response = await pi.exec("gh", [...args], { cwd, timeout: 15_000 });
    return {
      code: response.code,
      stdout: response.stdout,
      stderr: response.stderr,
    };
  };
  const createRuntime = (
    ctx: ExtensionContext,
    sessionId: string,
    pr: string,
    initialFingerprint?: string,
    initialHeadSha?: string,
  ): SessionRuntime => {
    const canonicalPr = canonicalPullRequestUrl(pr);
    const ref = parsePullRequestRef(canonicalPr).number;
    const source = createGitHubReviewSource(runGh, ctx.cwd);
    const watcher = createReviewWatcher({
      sessionId,
      ref,
      source,
      schedule: scheduleFor(ctx),
      requiredApprovals: 2,
      pollIntervalMs: POLL_INTERVAL_MS,
      initialFingerprint,
      initialHeadSha,
      notify: state => notifySession(pi, ctx, sessionId, canonicalPr, state),
      persist: (state, fingerprint) => persistWatch(pi, "watch", canonicalPr, state, fingerprint),
      onError: error => {
        try {
          ctx.ui.notify(`octo_pr watcher error: ${errorMessage(error)}`, "error");
        } catch {
          // The extension error channel is unavailable in headless contexts.
        }
      },
    });
    return { sessionId, ref, pr: canonicalPr, watcher, cancelled: false, paused: false };
  };

  const restoreSession = async (ctx: ExtensionContext, forceRebuild = false): Promise<void> => {
    const sessionId = currentSessionId(ctx);
    const runtime = sessions.get(sessionId);
    if (forceRebuild) {
      runtime?.watcher.cancel();
      sessions.delete(sessionId);
    } else if (runtime && !runtime.cancelled) {
      runtime.paused = false;
      await runtime.watcher.resume();
      return;
    } else if (runtime?.cancelled) {
      return;
    }

    const saved = persistedWatch(ctx);
    if (!saved) return;
    const restored = createRuntime(ctx, sessionId, saved.ref, saved.lastFingerprint, saved.headSha);
    sessions.set(sessionId, restored);
    await restored.watcher.start();
  };

  const pauseSession = (ctx: ExtensionContext): void => {
    const runtime = sessions.get(currentSessionId(ctx));
    if (!runtime || runtime.cancelled) return;
    runtime.paused = true;
    runtime.watcher.pause();
  };

  pi.on("session_start", async (_event, ctx) => {
    await restoreSession(ctx);
  });
  pi.on("session_before_switch", (_event, ctx) => {
    pauseSession(ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    await restoreSession(ctx);
  });
  pi.on("session_branch", async (_event, ctx) => {
    await restoreSession(ctx, true);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreSession(ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pauseSession(ctx);
  });
  const z = pi.zod;
  pi.registerTool({
    name: "octo_pr",
    label: "Octo PR",
    description: "Watch and inspect Mininglamp-OSS/octo-server pull request review state without remote writes.",
    parameters: z.object({
      action: z.enum(["watch", "status", "cancel"]),
      pr: z.string().optional(),
      fresh: z.boolean().optional(),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const params = rawParams as OctoParams;
      const sessionId = currentSessionId(ctx);
      const cwd = ctx.cwd;
      const runtime = sessions.get(sessionId);

      if (params.action !== "status" && params.fresh === true) {
        return failure("fresh is only valid for status", sessionId);
      }

      if (params.action === "watch") {
        if (runtime && !runtime.cancelled) {
          return failure("this session already has an active PR watcher; use status or cancel first", sessionId);
        }
        let nextRuntime: SessionRuntime | undefined;
        try {
          const pr = params.pr?.trim()
            ? canonicalPullRequestUrl(params.pr)
            : await resolveCurrentPullRequest(runGh, cwd);
          if (currentSessionId(ctx) !== sessionId) {
            return failure("session changed while resolving the PR", sessionId);
          }
          persistWatch(pi, "watch", pr);
          nextRuntime = createRuntime(ctx, sessionId, pr);
          sessions.set(sessionId, nextRuntime);
          await nextRuntime.watcher.start();
          if (currentSessionId(ctx) !== sessionId) {
            nextRuntime.watcher.cancel();
            sessions.delete(sessionId);
            return failure("session changed while starting the PR watcher", sessionId);
          }
          return result(runtimeDetails(nextRuntime));
        } catch (error) {
          nextRuntime?.watcher.cancel();
          if (nextRuntime && sessions.get(sessionId) === nextRuntime) sessions.delete(sessionId);
          return failure(errorMessage(error), sessionId);
        }
      }
      if (!runtime) {
        let pr: string | undefined;
        if (params.pr?.trim()) {
          try {
            pr = canonicalPullRequestUrl(params.pr);
          } catch (error) {
            return failure(errorMessage(error), sessionId);
          }
        }
        return result({
          status: "cancelled",
          ready: false,
          watching: false,
          cancelled: true,
          sessionId,
          pr,
          error: undefined,
        });
      }

      if (params.pr?.trim()) {
        try {
          if (parsePullRequestRef(params.pr).number !== runtime.ref) {
            return failure("pr does not match this session's active watcher", sessionId);
          }
        } catch (error) {
          return failure(errorMessage(error), sessionId);
        }
      }

      if (params.action === "status") {
        if (params.fresh === true && !runtime.cancelled && !runtime.paused) await runtime.watcher.refresh();
        return result(runtimeDetails(runtime));
      }

      runtime.watcher.cancel();
      runtime.cancelled = true;
      runtime.paused = false;
      persistWatch(pi, "cancel", runtime.pr);
      return result(runtimeDetails(runtime));
    },
  });
}
