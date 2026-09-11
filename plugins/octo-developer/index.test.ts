import { expect, test } from "bun:test";

// The entry point is intentionally loaded dynamically while this test-first
// slice has no production module yet. A missing file must fail the capability
// assertion, not abort the suite with an uncaught module-resolution error.
const INDEX_ENTRY = ["./src", "index"].join("/");
const HEAD_SHA = "a".repeat(40);

type UnknownRecord = Record<string, unknown>;
type SchemaNode = UnknownRecord & {
  optional?: () => SchemaNode;
  nullable?: () => SchemaNode;
};
type ToolDefinition = UnknownRecord & {
  name: string;
  execute?: (...args: readonly unknown[]) => Promise<unknown> | unknown;
};
type ExecCall = {
  command: string;
  args: readonly string[];
  options?: UnknownRecord;
};

async function loadIndexModule(): Promise<UnknownRecord> {
  try {
    return (await import(INDEX_ENTRY)) as UnknownRecord;
  } catch {
    return {};
  }
}

function schema(kind: string, fields: UnknownRecord = {}): SchemaNode {
  const node: SchemaNode = {
    kind,
    ...fields,
    optional: () => schema("optional", { inner: node }),
    nullable: () => schema("nullable", { inner: node }),
  };
  return node;
}

const zod = {
  object(shape: UnknownRecord): SchemaNode {
    return schema("object", { shape });
  },
  enum(values: readonly string[]): SchemaNode {
    return schema("enum", { values });
  },
  string(): SchemaNode {
    return schema("string");
  },
  boolean(): SchemaNode {
    return schema("boolean");
  },
  number(): SchemaNode {
    return schema("number");
  },
  unknown(): SchemaNode {
    return schema("unknown");
  },
  array(inner: SchemaNode): SchemaNode {
    return schema("array", { inner });
  },
  record(inner: SchemaNode): SchemaNode {
    return schema("record", { inner });
  },
  optional(inner: SchemaNode): SchemaNode {
    return schema("optional", { inner });
  },
  nullable(inner: SchemaNode): SchemaNode {
    return schema("nullable", { inner });
  },
};

function githubResponse(args: readonly string[]): string {
  if (args.includes("view")) {
    return JSON.stringify({
      number: 887,
      headRefOid: HEAD_SHA,
      url: "https://github.com/Mininglamp-OSS/octo-server/pull/887",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ context: "ci/test", state: "SUCCESS", detailsUrl: "https://ci/887" }],
    });
  }
  if (args.includes("graphql")) {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-1",
                  path: "src/review.ts",
                  line: 42,
                  isResolved: true,
                  comments: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  }
  const request = args.find(argument => argument.includes("repos/")) ?? "";
  if (request.includes("/pulls/887/reviews")) {
    return JSON.stringify([
      {
        id: 1,
        user: { login: "alice" },
        state: "APPROVED",
        commit_id: HEAD_SHA,
        body: "formal approval from alice",
        submitted_at: "2026-09-11T00:01:00Z",
        html_url: "https://github.com/Mininglamp-OSS/octo-server/pull/887#review-1",
      },
      {
        id: 2,
        user: { login: "bob" },
        state: "APPROVED",
        commit_id: HEAD_SHA,
        body: "formal approval from bob",
        submitted_at: "2026-09-11T00:02:00Z",
        html_url: "https://github.com/Mininglamp-OSS/octo-server/pull/887#review-2",
      },
    ]);
  }
  if (request.includes("/issues/887/comments")) {
    return JSON.stringify([
      {
        id: 3,
        user: { login: "dana" },
        body: "ordinary PR comment",
        created_at: "2026-09-11T00:03:00Z",
        updated_at: "2026-09-11T00:03:00Z",
        html_url: "https://github.com/Mininglamp-OSS/octo-server/issues/887#issuecomment-3",
      },
    ]);
  }
  if (request.includes("/pulls/887/comments")) {
    return JSON.stringify([
      {
        id: 4,
        user: { login: "erin" },
        body: "inline review comment",
        created_at: "2026-09-11T00:04:00Z",
        updated_at: "2026-09-11T00:04:00Z",
        html_url: "https://github.com/Mininglamp-OSS/octo-server/pull/887#discussion_r4",
        path: "src/review.ts",
        line: 42,
      },
    ]);
  }
  return JSON.stringify([]);
}

function detailsOf(result: unknown): UnknownRecord {
  expect(result).toBeDefined();
  expect(typeof result).toBe("object");
  const details = (result as UnknownRecord).details;
  expect(typeof details).toBe("object");
  return details as UnknownRecord;
}

async function executeTool(
  tool: ToolDefinition,
  params: UnknownRecord,
  context: UnknownRecord,
): Promise<unknown> {
  expect(typeof tool.execute, "octo_pr must expose a callable execute boundary").toBe("function");
  return tool.execute?.("test-call", params, new AbortController().signal, undefined, context);
}

test("registered octo_pr watch/status/cancel actions expose observable session state", async () => {
  const module = await loadIndexModule();
  const extension = module.default;
  const tools: ToolDefinition[] = [];
  const execCalls: ExecCall[] = [];
  const persistedEntries: Array<{ customType: string; data: UnknownRecord }> = [];
  const notifications: string[] = [];
  const host = new Proxy(
    {
      zod,
      registerTool(definition: ToolDefinition): void {
        tools.push(definition);
      },
      async exec(command: string, args: readonly string[], options?: UnknownRecord): Promise<UnknownRecord> {
        execCalls.push({ command, args, options });
        return { code: 0, stdout: githubResponse(args), stderr: "" };
      },
      appendEntry(customType: string, data: UnknownRecord): void {
        persistedEntries.push({ customType, data });
      },
      on(): void {
        // Lifecycle registration is driven by the real host in production.
      },
    } as UnknownRecord,
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        const noop = (): undefined => undefined;
        Reflect.set(target, property, noop);
        return noop;
      },
    },
  );

  (extension as (pi: UnknownRecord) => void)(host);
  const tool = tools.find(candidate => candidate.name === "octo_pr");
  expect(tool, "the extension must register the octo_pr tool").toBeDefined();

  const timers: UnknownRecord[] = [];
  const sessionId = "index-test-session";
  const context = {
    cwd: "/tmp/octo-developer-test",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => "/tmp/octo-developer-test",
    },
    setInterval(callback: () => unknown, delayMs: number): UnknownRecord {
      const timer = { callback, delayMs, active: true };
      timers.push(timer);
      return timer;
    },
    setTimeout(callback: () => unknown, delayMs: number): UnknownRecord {
      const timer = { callback, delayMs, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer: UnknownRecord): void {
      timer.active = false;
    },
    ui: {
      notify(message: string): void {
        notifications.push(message);
      },
    },
  } as UnknownRecord;

  const watchResult = await executeTool(tool!, { action: "watch" }, context);
  const watched = detailsOf(watchResult);
  expect(watched).toMatchObject({
    status: "ready",
    ready: true,
    headSha: HEAD_SHA,
    watching: true,
    pr: "https://github.com/Mininglamp-OSS/octo-server/pull/887",
  });
  expect((watched.approvals as readonly UnknownRecord[]).map(item => item.author)).toEqual(["alice", "bob"]);
  expect((watched.issueComments as readonly UnknownRecord[])[0]?.body).toBe("ordinary PR comment");
  expect((watched.reviewComments as readonly UnknownRecord[])[0]?.body).toBe("inline review comment");
  const content = (watchResult as UnknownRecord).content as readonly UnknownRecord[];
  const serialized = JSON.parse(String(content[0]?.text)) as UnknownRecord;
  expect(serialized).toMatchObject({
    status: "ready",
    headSha: HEAD_SHA,
    pr: "https://github.com/Mininglamp-OSS/octo-server/pull/887",
    issueComments: [{ body: "ordinary PR comment" }],
    reviewComments: [{ body: "inline review comment" }],
  });
  expect(execCalls.some(call => call.command === "gh")).toBe(true);
  expect(execCalls.every(call => typeof call.options?.timeout === "number" && call.options.timeout > 0)).toBe(true);
  const savedEvidence = persistedEntries.find(
    entry => entry.customType === "com.wingeddragon.octo-pr.watch" && typeof entry.data.lastFingerprint === "string",
  );
  expect(savedEvidence?.data.ref).toBe("https://github.com/Mininglamp-OSS/octo-server/pull/887");
  expect(savedEvidence?.data.headSha).toBe(HEAD_SHA);
  const cached = detailsOf(await executeTool(tool!, { action: "status" }, context));
  expect(cached).toMatchObject({ status: "ready", ready: true, headSha: HEAD_SHA, watching: true });

  const cancelled = detailsOf(await executeTool(tool!, { action: "cancel" }, context));
  expect(cancelled).toMatchObject({ status: "cancelled", ready: false, watching: false, cancelled: true });
  expect(persistedEntries.at(-1)?.data).toMatchObject({
    action: "cancel",
    ref: "https://github.com/Mininglamp-OSS/octo-server/pull/887",
  });
  expect(timers.every(timer => timer.active === false)).toBe(true);

  const afterCancel = detailsOf(await executeTool(tool!, { action: "status" }, context));
  expect(afterCancel).toMatchObject({ status: "cancelled", watching: false, cancelled: true });
  expect(notifications).toEqual([]);
});
