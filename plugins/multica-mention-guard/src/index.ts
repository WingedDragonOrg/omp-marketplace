import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveTaskContext, type TaskContext } from "./domain";
import { MentionGuard } from "./guard";
import type {
  GuardBackend,
  StopContinuation,
  StopEvent,
  ToolResultEvent,
} from "./guard";
import { BunCommandExecutor, MulticaCliBackend } from "./multica-cli";

export interface ExtensionHooks {
  onToolResult(handler: (event: ToolResultEvent) => void): void;
  onSessionStop(
    handler: (event: StopEvent) => Promise<StopContinuation | undefined>,
  ): void;
}

export interface InstallDependencies {
  env: Record<string, string | undefined>;
  readMarker: () => string | undefined;
  createBackend: (
    context: Extract<TaskContext, { kind: "active" }>,
  ) => GuardBackend;
}

export function installMentionGuard(
  hooks: ExtensionHooks,
  dependencies: InstallDependencies,
): void {
  const hasTaskSignal = [
    dependencies.env.MULTICA_TASK_ID,
    dependencies.env.MULTICA_AGENT_ID,
    dependencies.env.MULTICA_WORKSPACE_ID,
  ].some(value => typeof value === "string" && value.trim() !== "");
  const context = resolveTaskContext(
    dependencies.env,
    hasTaskSignal ? dependencies.readMarker() : undefined,
  );

  if (context.kind === "inactive") return;
  if (context.kind === "invalid") {
    let reminderIssued = false;
    hooks.onSessionStop(async event => {
      if (reminderIssued || event.stop_hook_active) return undefined;
      reminderIssued = true;
      return {
        continue: true,
        additionalContext:
          "Multica task 运行时上下文不完整或与 daemon marker 不一致，mention guard 只提醒这一次，下一次 stop 不再阻止。不要重述最终回复；如果没有具体后续工作，不要 mention agent。",
      };
    });
    return;
  }

  const guard = new MentionGuard(context, dependencies.createBackend(context));
  hooks.onToolResult(event => guard.observeToolResult(event));
  hooks.onSessionStop(event => guard.handleSessionStop(event));
}

export default function mentionGuardExtension(pi: ExtensionAPI): void {
  installMentionGuard(
    {
      onToolResult: handler => {
        pi.on("tool_result", async event => {
          handler({
            toolName: event.toolName,
            input: event.input,
            content: event.content,
            isError: event.isError,
          });
        });
      },
      onSessionStop: handler => {
        pi.on("session_stop", event =>
          handler({
            signal: event.signal,
            stop_hook_active: event.stop_hook_active,
            last_assistant_message: event.last_assistant_message,
          }),
        );
      },
    },
    {
      env: process.env,
      readMarker: () => {
        try {
          return readFileSync(
            join(process.cwd(), ".multica", "daemon_task_context.json"),
            "utf8",
          );
        } catch {
          return undefined;
        }
      },
      createBackend: context =>
        new MulticaCliBackend(
          context,
          new BunCommandExecutor({
            timeoutMs: 5_000,
            maxOutputBytes: 16 * 1024 * 1024,
          }),
        ),
    },
  );
}
