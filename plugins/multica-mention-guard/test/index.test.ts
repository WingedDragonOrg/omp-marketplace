import { describe, expect, test } from "bun:test";
import { installMentionGuard, type ExtensionHooks } from "../src/index";
import type { GuardBackend, GuardSnapshot, StopEvent, ToolResultEvent } from "../src/guard";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";

class FakeHooks implements ExtensionHooks {
  readonly toolResultHandlers: Array<(event: ToolResultEvent) => void> = [];
  readonly sessionStopHandlers: Array<
    (event: StopEvent) => Promise<{ continue: true; additionalContext: string } | undefined>
  > = [];

  onToolResult(handler: (event: ToolResultEvent) => void): void {
    this.toolResultHandlers.push(handler);
  }

  onSessionStop(
    handler: (
      event: StopEvent,
    ) => Promise<{ continue: true; additionalContext: string } | undefined>,
  ): void {
    this.sessionStopHandlers.push(handler);
  }
}

class FakeBackend implements GuardBackend {
  loadCount = 0;

  async loadSnapshot(): Promise<GuardSnapshot> {
    this.loadCount++;
    return {
      comments: [],
      agentIds: new Set([OTHER_AGENT_ID]),
      memberIds: new Set(),
      expectedParentId: null,
      rosterVerified: true,
    };
  }

  async publishFinal(): Promise<void> {
    throw new Error("unexpected publish");
  }
}

const activeEnv = {
  MULTICA_TASK_ID: TASK_ID,
  MULTICA_AGENT_ID: AGENT_ID,
  MULTICA_WORKSPACE_ID: WORKSPACE_ID,
};
const marker = JSON.stringify({
  managed_by: "multica-daemon-task",
  agent_id: AGENT_ID,
  issue_id: ISSUE_ID,
});

function stopEvent(body: string, stopHookActive = false): StopEvent {
  return {
    signal: new AbortController().signal,
    stop_hook_active: stopHookActive,
    last_assistant_message: { content: [{ type: "text", text: body }] },
  };
}

describe("installMentionGuard", () => {
  test("does no marker or backend work outside a Multica task", () => {
    const hooks = new FakeHooks();
    let markerReads = 0;
    let backendBuilds = 0;

    installMentionGuard(hooks, {
      env: {},
      readMarker: () => {
        markerReads++;
        return marker;
      },
      createBackend: () => {
        backendBuilds++;
        return new FakeBackend();
      },
    });

    expect(markerReads).toBe(0);
    expect(backendBuilds).toBe(0);
    expect(hooks.toolResultHandlers).toHaveLength(0);
    expect(hooks.sessionStopHandlers).toHaveLength(0);
  });

  test("registers tool-result and session-stop handlers for an active task", async () => {
    const hooks = new FakeHooks();
    const backend = new FakeBackend();
    installMentionGuard(hooks, {
      env: activeEnv,
      readMarker: () => marker,
      createBackend: () => backend,
    });

    expect(hooks.toolResultHandlers).toHaveLength(1);
    expect(hooks.sessionStopHandlers).toHaveLength(1);

    hooks.toolResultHandlers[0]!({
      toolName: "bash",
      input: { command: "multica squad activity SWO-1 no_action" },
      content: [{ type: "text", text: "Squad evaluation recorded: no_action" }],
      isError: false,
    });
    expect(await hooks.sessionStopHandlers[0]!(stopEvent("No action"))).toBeUndefined();
    expect(backend.loadCount).toBe(0);
  });

  test("fails closed without constructing a backend for partial task identity", async () => {
    const hooks = new FakeHooks();
    let backendBuilds = 0;
    installMentionGuard(hooks, {
      env: { MULTICA_TASK_ID: TASK_ID },
      readMarker: () => marker,
      createBackend: () => {
        backendBuilds++;
        return new FakeBackend();
      },
    });

    expect(backendBuilds).toBe(0);
    expect(hooks.toolResultHandlers).toHaveLength(0);
    expect(hooks.sessionStopHandlers).toHaveLength(1);
    const result = await hooks.sessionStopHandlers[0]!(stopEvent("ignored"));
    expect(result?.continue).toBe(true);
    expect(result?.additionalContext).toContain("上下文");
    expect(
      await hooks.sessionStopHandlers[0]!(stopEvent("ignored again", true)),
    ).toBeUndefined();
  });
});
