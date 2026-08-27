import { describe, expect, test } from "bun:test";
import {
  MentionGuard,
  type GuardBackend,
  type GuardComment,
  type GuardSnapshot,
  type StopEvent,
} from "../src/guard";
import type { TaskContext } from "../src/domain";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const PARENT_ID = "77777777-7777-4777-8777-777777777777";

const context: Extract<TaskContext, { kind: "active" }> = {
  kind: "active",
  taskId: TASK_ID,
  agentId: AGENT_ID,
  workspaceId: WORKSPACE_ID,
  issueId: ISSUE_ID,
};

const validFinal =
  `Implemented and verified. [@Reviewer](mention://agent/${OTHER_AGENT_ID})`;
const naturalFinal = "确认最终关闭状态。无实现或状态动作，无后续动作。";

function comment(content: string, parentId: string | null = PARENT_ID): GuardComment {
  return {
    issueId: ISSUE_ID,
    sourceTaskId: TASK_ID,
    authorType: "agent",
    authorId: AGENT_ID,
    type: "comment",
    parentId,
    content,
  };
}

function snapshot(
  comments: GuardComment[] = [],
  expectedParentId: string | null = PARENT_ID,
  rosterVerified = true,
): GuardSnapshot {
  const agentIds = new Set<string>();
  agentIds.add(OTHER_AGENT_ID);
  const memberIds = new Set<string>();
  memberIds.add(MEMBER_ID);
  return { comments, agentIds, memberIds, expectedParentId, rosterVerified };
}

function stopEvent(body: string, stopHookActive = false): StopEvent {
  return {
    signal: new AbortController().signal,
    stop_hook_active: stopHookActive,
    last_assistant_message: {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: body },
      ],
    },
  };
}

class FakeBackend implements GuardBackend {
  loadCount = 0;
  publishCount = 0;
  mode: "success" | "pre-dispatch-failure" | "dispatch-unknown" = "success";
  publishedBodies: string[] = [];

  constructor(public value: GuardSnapshot) {}

  async loadSnapshot(): Promise<GuardSnapshot> {
    this.loadCount++;
    return this.value;
  }

  async publishFinal(
    body: string,
    parentId: string | null,
    _signal: AbortSignal,
    onDispatched: () => void,
  ): Promise<void> {
    this.publishCount++;
    if (this.mode === "pre-dispatch-failure") throw new Error("spawn failed");
    onDispatched();
    if (this.mode === "dispatch-unknown") throw new Error("response lost");
    this.publishedBodies.push(body);
    this.value.comments.push(comment(body, parentId));
  }
}

describe("MentionGuard normal stop", () => {
  test("lets Multica collect a compliant final when fallback is available", async () => {
    const backend = new FakeBackend(snapshot([], null));
    const guard = new MentionGuard(context, backend);

    expect(await guard.handleSessionStop(stopEvent(validFinal))).toBeUndefined();
    expect(backend.publishCount).toBe(0);
  });

  test("does not republish an identical final already stored by the task", async () => {
    const backend = new FakeBackend(snapshot([comment(validFinal)]));
    const guard = new MentionGuard(context, backend);

    expect(await guard.handleSessionStop(stopEvent(validFinal))).toBeUndefined();
    expect(backend.publishCount).toBe(0);
  });

  test("publishes a compliant final when a different task comment suppresses fallback", async () => {
    const coordination =
      `[@Reviewer](mention://agent/${OTHER_AGENT_ID}) please review the PR`;
    const backend = new FakeBackend(snapshot([comment(coordination)]));
    const guard = new MentionGuard(context, backend);

    expect(await guard.handleSessionStop(stopEvent(validFinal))).toBeUndefined();
    expect(backend.publishCount).toBe(1);
    expect(backend.publishedBodies).toEqual([validFinal]);
  });

  test("preserves final delivery and reminds once when rosters are unavailable", async () => {
    const backend = new FakeBackend(
      snapshot([comment("progress already posted")], PARENT_ID, false),
    );
    const guard = new MentionGuard(context, backend);

    const result = await guard.handleSessionStop(stopEvent(validFinal));

    expect(backend.publishedBodies).toEqual([validFinal]);
    expect(result?.continue).toBe(true);
  });
});

describe("MentionGuard one-shot reminder", () => {
  test("publishes the original final unchanged before its only reminder", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);

    const first = await guard.handleSessionStop(stopEvent(naturalFinal));

    expect(backend.publishedBodies).toEqual([naturalFinal]);
    expect(first?.continue).toBe(true);
    expect(first?.additionalContext).toContain("原始完整 final 已由 hook 原样发布");
    expect(first?.additionalContext).toContain("不要重述");
  });

  test("does not duplicate an original final the agent already posted", async () => {
    const backend = new FakeBackend(snapshot([comment(naturalFinal)]));
    const guard = new MentionGuard(context, backend);

    const result = await guard.handleSessionStop(stopEvent(naturalFinal));

    expect(result?.continue).toBe(true);
    expect(backend.publishCount).toBe(0);
  });

  test("allows no mention and never runs the hook twice", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);

    const first = await guard.handleSessionStop(stopEvent(naturalFinal));
    const readsAfterFirst = backend.loadCount;
    const second = await guard.handleSessionStop(
      stopEvent("确认，无后续动作。", true),
    );

    expect(first?.continue).toBe(true);
    expect(second).toBeUndefined();
    expect(backend.loadCount).toBe(readsAfterFirst);
    expect(backend.publishCount).toBe(1);
  });

  test("explains agent, no-mention, and optional member coordination choices", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);

    const result = await guard.handleSessionStop(stopEvent(naturalFinal));
    const reminder = result?.additionalContext ?? "";

    expect(reminder).toContain("具体后续工作");
    expect(reminder).toContain("不得仅为确认、致谢或关闭线程 mention");
    expect(reminder).toContain("不要 mention 任何 agent");
    expect(reminder).toContain("可以完全不 mention");
    expect(reminder).toContain("mention://member/");
    expect(reminder).toContain("下一次 stop 无条件放行");
  });

  test("does not treat a foreign stop-hook chain as its own reminder", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);

    expect(
      await guard.handleSessionStop(stopEvent(naturalFinal, true)),
    ).toBeUndefined();
    expect(backend.loadCount).toBe(0);
    expect(backend.publishCount).toBe(0);
  });
});

describe("MentionGuard publication failure", () => {
  test("falls back to normal completion when publication never dispatched and fallback is available", async () => {
    const backend = new FakeBackend(snapshot([], null));
    backend.mode = "pre-dispatch-failure";
    const guard = new MentionGuard(context, backend);

    expect(await guard.handleSessionStop(stopEvent(naturalFinal))).toBeUndefined();
    expect(backend.publishCount).toBe(1);
  });

  test("never posts again after a dispatch-unknown outcome", async () => {
    const backend = new FakeBackend(snapshot([], null));
    backend.mode = "dispatch-unknown";
    const guard = new MentionGuard(context, backend);

    expect(await guard.handleSessionStop(stopEvent(naturalFinal))).toBeUndefined();
    expect(
      await guard.handleSessionStop(stopEvent(naturalFinal, false)),
    ).toBeUndefined();
    expect(backend.publishCount).toBe(1);
  });

  test("reports delivery uncertainty once when fallback is already suppressed", async () => {
    const backend = new FakeBackend(snapshot([comment("progress already posted")]));
    backend.mode = "dispatch-unknown";
    const guard = new MentionGuard(context, backend);

    const first = await guard.handleSessionStop(stopEvent(naturalFinal));
    const second = await guard.handleSessionStop(stopEvent(naturalFinal));

    expect(first?.continue).toBe(true);
    expect(first?.additionalContext).toContain("交付状态未确认");
    expect(second).toBeUndefined();
    expect(backend.publishCount).toBe(1);
  });
});

describe("MentionGuard final serialization", () => {
  test("preserves block order, CR, trailing newlines, and removes only NUL", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);
    const event: StopEvent = {
      signal: new AbortController().signal,
      stop_hook_active: false,
      last_assistant_message: {
        content: [
          { type: "text", text: "    evidence\r\n" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "result\r\u0000\n" },
        ],
      },
    };

    await guard.handleSessionStop(event);

    expect(backend.publishedBodies).toEqual(["    evidence\r\nresult\r\n"]);
  });
});

describe("MentionGuard no-action", () => {
  test("allows confirmed no-action without reading or publishing", async () => {
    const backend = new FakeBackend(snapshot());
    const guard = new MentionGuard(context, backend);
    guard.observeToolResult({
      toolName: "bash",
      input: { command: "multica squad activity SWO-1 no_action" },
      content: [{ type: "text", text: "Squad evaluation recorded: no_action" }],
      isError: false,
    });

    expect(await guard.handleSessionStop(stopEvent("No action"))).toBeUndefined();
    expect(backend.loadCount).toBe(0);
    expect(backend.publishCount).toBe(0);
  });
});
