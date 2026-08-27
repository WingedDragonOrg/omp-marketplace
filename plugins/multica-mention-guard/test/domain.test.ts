import { describe, expect, test } from "bun:test";
import {
  classifyNoActionEvidence,
  resolveTaskContext,
  validateMentionBody,
} from "../src/domain";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const MEMBER_ID = "66666666-6666-4666-8666-666666666666";
const UNKNOWN_ID = "77777777-7777-4777-8777-777777777777";

describe("resolveTaskContext", () => {
  test("activates only for a complete matching Multica task context", () => {
    const result = resolveTaskContext(
      {
        MULTICA_TASK_ID: TASK_ID,
        MULTICA_AGENT_ID: AGENT_ID,
        MULTICA_WORKSPACE_ID: WORKSPACE_ID,
      },
      JSON.stringify({
        managed_by: "multica-daemon-task",
        agent_id: AGENT_ID.toUpperCase(),
        issue_id: ISSUE_ID,
      }),
    );

    expect(result).toEqual({
      kind: "active",
      taskId: TASK_ID,
      agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      issueId: ISSUE_ID,
    });
  });
});

describe("validateMentionBody", () => {
  const roster = {
    agentIds: new Set([OTHER_AGENT_ID]),
    memberIds: new Set([MEMBER_ID]),
  };

  test("accepts canonical mentions to another runnable agent or workspace member", () => {
    expect(
      validateMentionBody(
        `Finished. [@Reviewer](mention://agent/${OTHER_AGENT_ID})`,
        roster,
        AGENT_ID,
      ),
    ).toEqual({ ok: true, targetCount: 1 });

    expect(
      validateMentionBody(
        `Need input from [@David[TF]](mention://member/${MEMBER_ID.toUpperCase()})`,
        roster,
        AGENT_ID,
      ),
    ).toEqual({ ok: true, targetCount: 1 });
  });

  test("rejects missing, self, unknown, and mixed invalid participant mentions", () => {
    expect(validateMentionBody("Finished. @Reviewer", roster, AGENT_ID)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(
      validateMentionBody(`[@Self](mention://agent/${AGENT_ID})`, roster, AGENT_ID),
    ).toEqual({ ok: false, reason: "invalid-target" });
    expect(
      validateMentionBody(`[@Unknown](mention://member/${UNKNOWN_ID})`, roster, AGENT_ID),
    ).toEqual({ ok: false, reason: "invalid-target" });
    expect(
      validateMentionBody(
        `[@Reviewer](mention://agent/${OTHER_AGENT_ID}) and [@Unknown](mention://member/${UNKNOWN_ID})`,
        roster,
        AGENT_ID,
      ),
    ).toEqual({ ok: false, reason: "invalid-target" });
  });

  test("rejects a malformed participant URI even when another mention is valid", () => {
    expect(
      validateMentionBody(
        `[@Reviewer](mention://agent/${OTHER_AGENT_ID}) and [@Bad](mention://agent/not-a-uuid)`,
        roster,
        AGENT_ID,
      ),
    ).toEqual({ ok: false, reason: "invalid-target" });
  });

  test("does not count squad, issue, all, or project links", () => {
    const body = [
      `[@Squad](mention://squad/${UNKNOWN_ID})`,
      `[@all](mention://all/all)`,
      `[SWO-1](mention://issue/${UNKNOWN_ID})`,
      `[Project](mention://project/${UNKNOWN_ID})`,
    ].join(" ");

    expect(validateMentionBody(body, roster, AGENT_ID)).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("classifyNoActionEvidence", () => {
  test("recognizes persisted no-action activity inside compound shell output", () => {
    expect(
      classifyNoActionEvidence({
        command:
          "multica squad activity SWO-1 no_action --reason checked && run-later-step",
        output:
          "Squad evaluation recorded: no_action (issue SWO-1)\nrun-later-step: command not found",
        isError: true,
      }),
    ).toBe("confirmed");
  });

  test("uses explicit failure before permissive compound-command success", () => {
    expect(
      classifyNoActionEvidence({
        command: "multica squad activity SWO-1 no_action || true",
        output: "Error: only the squad leader agent can record evaluations",
        isError: false,
      }),
    ).toBe("none");
  });

  test("permits an unconfirmed candidate when the overall shell command succeeds", () => {
    expect(
      classifyNoActionEvidence({
        command:
          "env NO_COLOR=1 /opt/homebrew/bin/multica squad activity SWO-1 no_action >/dev/null",
        output: "",
        isError: false,
      }),
    ).toBe("permissive");
  });

  test("ignores unrelated successful shell commands", () => {
    expect(
      classifyNoActionEvidence({
        command: "multica issue get SWO-1 --output json",
        output: "{}",
        isError: false,
      }),
    ).toBe("none");
  });

  test("does not accept a success marker without an executed activity command", () => {
    expect(
      classifyNoActionEvidence({
        command: "multica issue comment list SWO-1 --output json",
        output: "Squad evaluation recorded: no_action (issue SWO-1)",
        isError: false,
      }),
    ).toBe("none");
    expect(
      classifyNoActionEvidence({
        command: "echo multica squad activity SWO-1 no_action",
        output: "multica squad activity SWO-1 no_action",
        isError: false,
      }),
    ).toBe("none");
  });
});
