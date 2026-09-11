import * as path from "node:path";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export type TanControllerContext = ConstructorParameters<typeof TanCommandController>[0];
export type TanControllerLike = Pick<TanCommandController, "start">;

export interface DelegateDependencies {
  resolveParentSession?: (ctx: ExtensionCommandContext) => AgentSession | undefined;
  createCleanSessionManager?: (cwd: string, sessionDir: string) => SessionManager;
  createTanController?: (context: TanControllerContext) => TanControllerLike;
  mcpManager?: MCPManager;
}

/** Return the submitted work, or undefined when the command has no work. */
export function parseDelegateWork(rawArgs: string): string | undefined {
  const work = rawArgs.trim();
  return work || undefined;
}

/** Create the persisted, empty source session used by the native tan controller. */
export function createCleanSessionManager(cwd: string, sessionDir: string): SessionManager {
  return SessionManager.create(cwd, sessionDir);
}

/**
 * Give the native tan controller an empty transcript while preserving the
 * parent's runtime identity and artifact/local protocol roots.
 */
export function createTanSessionManagerFacade(
  parent: SessionManager,
  clean: SessionManager,
): Pick<
  SessionManager,
  "ensureOnDisk" | "flush" | "getSessionFile" | "getSessionId" | "getCwd" | "getArtifactsDir"
> {
  return {
    ensureOnDisk: () => clean.ensureOnDisk(),
    flush: () => clean.flush(),
    getSessionFile: () => clean.getSessionFile(),
    getSessionId: () => parent.getSessionId(),
    getCwd: () => parent.getCwd(),
    getArtifactsDir: () => parent.getArtifactsDir(),
  };
}

/** Find the live AgentSession owning the extension command's session manager. */
export function resolveParentSession(
  ctx: ExtensionCommandContext,
  registry: AgentRegistry = AgentRegistry.global(),
): AgentSession | undefined {
  for (const ref of registry.list()) {
    if (ref.session?.sessionManager === ctx.sessionManager) return ref.session;
  }

  const main = registry.get(MAIN_AGENT_ID)?.session;
  return main?.sessionManager === ctx.sessionManager ? main : undefined;
}

/**
 * Dispatch a clean-context background job through the same native TanCommandController
 * used by /tan. Only the session-manager source is replaced, so job lifecycle, Hub
 * registration, cancellation and result delivery remain native OMP behavior.
 */
export async function dispatchDelegate(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  dependencies: DelegateDependencies = {},
): Promise<void> {
  const work = parseDelegateWork(rawArgs);
  if (!work) {
    ctx.ui.notify("Usage: /delegate <work>", "warning");
    return;
  }

  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/delegate requires the interactive TUI.", "error");
    return;
  }

  const parent = (dependencies.resolveParentSession ?? resolveParentSession)(ctx);
  if (!parent) {
    ctx.ui.notify("Unable to resolve the active OMP session for /delegate.", "error");
    return;
  }
  if (!parent.model) {
    ctx.ui.notify("No active model available for /delegate.", "error");
    return;
  }
  if (!parent.asyncJobManager) {
    ctx.ui.notify("Background jobs are disabled; enable async jobs to use /delegate.", "error");
    return;
  }

  const parentFile = ctx.sessionManager.getSessionFile();
  if (!parentFile) {
    ctx.ui.notify("/delegate requires a persisted session.", "error");
    return;
  }

  const clean = (dependencies.createCleanSessionManager ?? createCleanSessionManager)(
    ctx.cwd,
    path.dirname(parentFile),
  );
  const cleanFile = clean.getSessionFile();
  if (!cleanFile) {
    await clean.close();
    ctx.ui.notify("Unable to persist the clean /delegate session.", "error");
    return;
  }

  const tanSessionManager = createTanSessionManagerFacade(parent.sessionManager, clean);
  const tanContext = {
    session: parent,
    sessionManager: tanSessionManager,
    settings: parent.settings,
    mcpManager: dependencies.mcpManager ?? MCPManager.instance(),
    showStatus: (message: string) => ctx.ui.notify(message, "info"),
    showError: (message: string) => ctx.ui.notify(message, "error"),
  } as unknown as TanControllerContext;

  try {
    const controller = (
      dependencies.createTanController ??
      ((context: TanControllerContext) => new TanCommandController(context))
    )(tanContext);
    await controller.start(work);
  } finally {
    try {
      await clean.dropSession(cleanFile);
    } catch (error) {
      ctx.ui.notify(
        `Unable to remove the temporary clean /delegate source session: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }
}

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.setLabel("delegate");
  pi.registerCommand("delegate", {
    description: "Run a full background agent with a clean conversation context",
    handler: async (rawArgs, ctx) => {
      await dispatchDelegate(rawArgs, ctx);
    },
  });
}
