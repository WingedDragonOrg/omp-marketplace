import { describe, expect, test } from "bun:test";

// Keep the import dynamic while the implementation is being developed. A missing
// module is reported by the capability assertion below, rather than as a loader
// error that prevents the behavior suite from running.
const REVIEW_ENTRY = ["./src", "review"].join("/");
const REF = "octo-server#887";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
type ReviewRecord = {
  id: string;
  author: string;
  state: ReviewDecision;
  commitSha: string;
  body: string;
  submittedAt: string;
  url: string;
};
type CommentRecord = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};
type ThreadRecord = {
  id: string;
  path: string;
  line: number;
  isResolved: boolean;
  comments: readonly CommentRecord[];
};
type StatusCheck = {
  context: string;
  state: string;
  detailsUrl: string;
};
type PullRequestFacts = {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  statusCheckRollup: readonly StatusCheck[];
};
type ReviewSnapshot = {
  headSha: string;
  pullRequest: PullRequestFacts;
  reviews: readonly ReviewRecord[];
  issueComments: readonly CommentRecord[];
  reviewComments: readonly CommentRecord[];
  threads: readonly ThreadRecord[];
};
type ReviewState = ReviewSnapshot & {
  requiredApprovals: number;
  ready: boolean;
  approvals: readonly ReviewRecord[];
  changesRequested: readonly ReviewRecord[];
  error?: string | null;
};
type ReviewWatcher = {
  start(): Promise<void>;
  refresh(): Promise<void>;
  cancel(): void;
  pause(): void;
  resume(): Promise<void>;
  getState(): ReviewState;
};
type ReviewModule = Record<string, unknown>;
type ReviewFunction = (...args: readonly unknown[]) => unknown;

async function loadReviewModule(): Promise<ReviewModule> {
  try {
    return (await import(REVIEW_ENTRY)) as ReviewModule;
  } catch {
    return {};
  }
}

async function requiredReviewFunction(name: string): Promise<ReviewFunction> {
  const module = await loadReviewModule();
  const candidate = module[name];
  expect(typeof candidate, `src/review.ts must export ${name}`).toBe("function");
  return candidate as ReviewFunction;
}

function review(
  id: string,
  author: string,
  state: ReviewDecision,
  commitSha = HEAD_A,
  submittedAt = `2026-09-11T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
): ReviewRecord {
  return {
    id,
    author,
    state,
    commitSha,
    body: `${state.toLowerCase()} body from ${author}`,
    submittedAt,
    url: `https://github.com/Mininglamp-OSS/octo-server/pull/887#pullrequestreview-${id}`,
  };
}

function comment(id: string, author: string, body: string, updatedAt = "2026-09-11T00:01:00Z"): CommentRecord {
  return {
    id,
    author,
    body,
    createdAt: "2026-09-11T00:00:00Z",
    updatedAt,
    url: `https://github.com/Mininglamp-OSS/octo-server/pull/887#issuecomment-${id}`,
  };
}

function pullRequestFacts(): PullRequestFacts {
  return {
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      {
        context: "ci/test",
        state: "SUCCESS",
        detailsUrl: "https://github.com/Mininglamp-OSS/octo-server/actions/runs/887",
      },
    ],
  };
}

function snapshot(overrides: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    headSha: HEAD_A,
    pullRequest: pullRequestFacts(),
    reviews: [],
    issueComments: [],
    reviewComments: [],
    threads: [],
    ...overrides,
  };
}

function readySnapshot(headSha = HEAD_A): ReviewSnapshot {
  return snapshot({
    headSha,
    reviews: [
      review("r1", "alice", "APPROVED", headSha),
      review("r2", "bob", "APPROVED", headSha),
    ],
  });
}

describe("review gate state", () => {
  test("becomes ready with two distinct current-head approvals without waiting for a third", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const state = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      readySnapshot(),
    );

    expect(state.ready).toBe(true);
    expect(state.approvals.map(item => item.author)).toEqual(["alice", "bob"]);
    expect(state.approvals).toHaveLength(2);
    expect(state.headSha).toBe(HEAD_A);
  });

  test("does not count repeated approvals from one reviewer as a second vote", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const state = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      snapshot({
        reviews: [
          review("r1", "alice", "APPROVED"),
          review("r2", "alice", "APPROVED", HEAD_A, "2026-09-11T00:02:00Z"),
        ],
      }),
    );

    expect(state.ready).toBe(false);
    expect(state.approvals.map(item => item.author)).toEqual(["alice"]);
  });

  test("a current-head CHANGES_REQUESTED blocks an otherwise approved pair", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const initiallyReady = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      readySnapshot(),
    );
    const blocked = applyReviewSnapshot(
      initiallyReady,
      snapshot({
        reviews: [
          review("r1", "alice", "APPROVED"),
          review("r2", "bob", "APPROVED"),
          review("r3", "carol", "CHANGES_REQUESTED"),
        ],
      }),
    );

    expect(blocked.ready).toBe(false);
    expect(blocked.changesRequested.map(item => item.author)).toEqual(["carol"]);
  });

  test("a dismissed approval no longer satisfies the gate", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const initiallyReady = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      readySnapshot(),
    );
    const revoked = applyReviewSnapshot(
      initiallyReady,
      snapshot({
        reviews: [
          review("r1", "alice", "DISMISSED"),
          review("r2", "bob", "APPROVED"),
        ],
      }),
    );

    expect(revoked.ready).toBe(false);
    expect(revoked.approvals.map(item => item.author)).toEqual(["bob"]);
  });

  test("approvals for the previous head do not carry across a head change", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const initiallyReady = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      readySnapshot(HEAD_A),
    );
    const newHead = applyReviewSnapshot(
      initiallyReady,
      snapshot({
        headSha: HEAD_B,
        reviews: [
          review("r1", "alice", "APPROVED", HEAD_A),
          review("r2", "bob", "APPROVED", HEAD_A),
        ],
      }),
    );

    expect(newHead.headSha).toBe(HEAD_B);
    expect(newHead.ready).toBe(false);
    expect(newHead.approvals).toHaveLength(0);
  });

  test("keeps an effective CHANGES_REQUESTED from the previous head blocking after a push", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const blockedAtOldHead = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      snapshot({
        headSha: HEAD_A,
        reviews: [
          review("reject-a", "alice", "CHANGES_REQUESTED", HEAD_A, "2026-09-11T00:01:00Z"),
          review("approve-b", "bob", "APPROVED", HEAD_A),
          review("approve-c", "carol", "APPROVED", HEAD_A),
        ],
      }),
    );
    const pushedWithOldRefusal = applyReviewSnapshot(
      blockedAtOldHead,
      snapshot({
        headSha: HEAD_B,
        reviews: [
          review("reject-a", "alice", "CHANGES_REQUESTED", HEAD_A, "2026-09-11T00:01:00Z"),
          review("approve-b", "bob", "APPROVED", HEAD_B),
          review("approve-c", "carol", "APPROVED", HEAD_B),
        ],
      }),
    );

    expect(pushedWithOldRefusal.ready).toBe(false);
    expect(pushedWithOldRefusal.approvals.map(item => item.author)).toEqual(["bob", "carol"]);
    expect(pushedWithOldRefusal.changesRequested.map(item => item.author)).toEqual(["alice"]);
  });

  test("clears a refusal only after that reviewer submits a decisive approval or is dismissed", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );
    const createBlockedState = (): ReviewState =>
      applyReviewSnapshot(
        createReviewState({ requiredApprovals: 2 }),
        snapshot({
          headSha: HEAD_B,
          reviews: [
            review("reject-a", "alice", "CHANGES_REQUESTED", HEAD_A, "2026-09-11T00:01:00Z"),
            review("approve-b", "bob", "APPROVED", HEAD_B),
            review("approve-c", "carol", "APPROVED", HEAD_B),
          ],
        }),
      );

    const resolvedByApproval = applyReviewSnapshot(
      createBlockedState(),
      snapshot({
        headSha: HEAD_B,
        reviews: [
          review("reject-a", "alice", "CHANGES_REQUESTED", HEAD_A, "2026-09-11T00:01:00Z"),
          review("approve-a", "alice", "APPROVED", HEAD_B, "2026-09-11T00:03:00Z"),
          review("approve-b", "bob", "APPROVED", HEAD_B),
          review("approve-c", "carol", "APPROVED", HEAD_B),
        ],
      }),
    );
    const resolvedByDismissal = applyReviewSnapshot(
      createBlockedState(),
      snapshot({
        headSha: HEAD_B,
        reviews: [
          review("reject-a", "alice", "DISMISSED", HEAD_A, "2026-09-11T00:03:00Z"),
          review("approve-b", "bob", "APPROVED", HEAD_B),
          review("approve-c", "carol", "APPROVED", HEAD_B),
        ],
      }),
    );

    expect(resolvedByApproval.ready).toBe(true);
    expect(resolvedByApproval.changesRequested).toHaveLength(0);
    expect(resolvedByDismissal.ready).toBe(true);
    expect(resolvedByDismissal.changesRequested).toHaveLength(0);
  });

  test("COMMENTED after CHANGES_REQUESTED does not silently clear the refusal", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );

    const state = applyReviewSnapshot(
      createReviewState({ requiredApprovals: 2 }),
      snapshot({
        reviews: [
          review("r1", "alice", "CHANGES_REQUESTED", HEAD_A, "2026-09-11T00:01:00Z"),
          review("r2", "alice", "COMMENTED", HEAD_A, "2026-09-11T00:02:00Z"),
          review("r3", "bob", "APPROVED"),
        ],
      }),
    );

    expect(state.ready).toBe(false);
    expect(state.changesRequested.map(item => item.author)).toEqual(["alice"]);
  });
});

describe("review snapshot collection", () => {
  test("paginates every evidence collection and keeps full formal, inline, and ordinary comments", async () => {
    const loadReviewSnapshot = (await requiredReviewFunction("loadReviewSnapshot")) as (
      (source: Record<string, unknown>, ref: string, options?: { pageSize?: number }) => Promise<ReviewSnapshot>
    );
    const calls: string[] = [];
    const source = {
      getPullRequest: async (ref: string) => {
        calls.push(`pull:${ref}`);
        return { headSha: HEAD_A, ...pullRequestFacts() };
      },
      listReviews: async (_ref: string, page: number, perPage: number) => {
        calls.push(`reviews:${page}:${perPage}`);
        return page === 1
          ? [review("r1", "alice", "APPROVED"), review("r2", "bob", "APPROVED")]
          : page === 2
            ? [review("r3", "carol", "APPROVED")]
            : [];
      },
      listIssueComments: async (_ref: string, page: number, perPage: number) => {
        calls.push(`issues:${page}:${perPage}`);
        return page === 1 ? [comment("i1", "dana", "ordinary comment 1"), comment("i2", "erin", "ordinary comment 2")] : [];
      },
      listReviewComments: async (_ref: string, page: number, perPage: number) => {
        calls.push(`inline:${page}:${perPage}`);
        return page === 1
          ? [comment("c1", "frank", "inline comment 1"), comment("c2", "gina", "inline comment 2")]
          : [comment("c3", "hugo", "inline comment 3")];
      },
      listThreads: async (_ref: string, page: number, perPage: number) => {
        calls.push(`threads:${page}:${perPage}`);
        return page === 1
          ? [
              {
                id: "t1",
                path: "src/review.ts",
                line: 42,
                isResolved: false,
                comments: [comment("tc1", "frank", "unresolved thread")],
              },
            ]
          : [];
      },
    };

    const result = await loadReviewSnapshot(source, REF, { pageSize: 2 });

    expect([...calls].sort()).toEqual(
      [
        `pull:${REF}`,
        `pull:${REF}`,
        "reviews:1:2",
        "reviews:2:2",
        "issues:1:2",
        "issues:2:2",
        "inline:1:2",
        "inline:2:2",
        "threads:1:2",
      ].sort(),
    );
    expect(result.headSha).toBe(HEAD_A);
    expect(result.reviews.map(item => item.id)).toEqual(["r1", "r2", "r3"]);
    expect(result.reviews[0]?.body).toBe("approved body from alice");
    expect(result.issueComments.map(item => item.body)).toEqual(["ordinary comment 1", "ordinary comment 2"]);
    expect(result.reviewComments.map(item => item.body)).toEqual([
      "inline comment 1",
      "inline comment 2",
      "inline comment 3",
    ]);
    expect(result.threads[0]?.isResolved).toBe(false);
    expect(result.threads[0]?.comments[0]?.body).toBe("unresolved thread");
  });

  test("retries when the head changes during collection instead of returning mixed-head evidence", async () => {
    const loadReviewSnapshot = (await requiredReviewFunction("loadReviewSnapshot")) as (
      (source: Record<string, unknown>, ref: string, options?: { pageSize?: number }) => Promise<ReviewSnapshot>
    );
    let pullLookups = 0;
    const source = {
      getPullRequest: async () => {
        pullLookups += 1;
        return { headSha: pullLookups === 1 ? HEAD_A : HEAD_B, ...pullRequestFacts() };
      },
      listReviews: async () => [review("r1", "alice", "APPROVED", HEAD_B)],
      listIssueComments: async () => [],
      listReviewComments: async () => [],
      listThreads: async () => [],
    };

    const result = await loadReviewSnapshot(source, REF, { pageSize: 2 });

    expect(pullLookups).toBe(4);
    expect(result.headSha).toBe(HEAD_B);
    expect(result.reviews[0]?.commitSha).toBe(HEAD_B);
  });

  test("propagates a later-page API failure instead of treating an empty or partial result as success", async () => {
    const loadReviewSnapshot = (await requiredReviewFunction("loadReviewSnapshot")) as (
      (source: Record<string, unknown>, ref: string, options?: { pageSize?: number }) => Promise<ReviewSnapshot>
    );
    const failure = new Error("GitHub API rate limit");
    const source = {
      getPullRequest: async () => ({ headSha: HEAD_A, ...pullRequestFacts() }),
      listReviews: async (_ref: string, page: number) => {
        if (page === 1) return [review("r1", "alice", "APPROVED"), review("r2", "bob", "APPROVED")];
        throw failure;
      },
      listIssueComments: async () => [],
      listReviewComments: async () => [],
      listThreads: async () => [],
    };

    await expect(loadReviewSnapshot(source, REF, { pageSize: 2 })).rejects.toThrow("GitHub API rate limit");
  });
  test("collects GraphQL review threads with independent pagination for concurrent snapshots", async () => {
    const createGitHubReviewSource = (await requiredReviewFunction("createGitHubReviewSource")) as (
      (runGh: ReviewFunction, cwd?: string) => { fetchSnapshot(ref: string): Promise<ReviewSnapshot> }
    );
    const calls: string[][] = [];
    const runGh: ReviewFunction = async argsValue => {
      const args = argsValue as readonly string[];
      calls.push([...args]);
      if (args.includes("graphql")) {
        const after = args.find(argument => argument.startsWith("after="));
        const id = after ? "thread-2" : "thread-1";
        const hasNextPage = !after;
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [{ id, path: "src/review.ts", line: 42, isResolved: Boolean(after), comments: { nodes: [] } }],
                    pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
                  },
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("view")) {
        return {
          code: 0,
          stdout: JSON.stringify({ headRefOid: HEAD_A, ...pullRequestFacts() }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const githubRef = "887";
    const source = createGitHubReviewSource(runGh);

    const [first, second] = await Promise.all([source.fetchSnapshot(githubRef), source.fetchSnapshot(githubRef)]);

    expect(first.threads.map(thread => thread.id)).toEqual(["thread-1", "thread-2"]);
    expect(second.threads.map(thread => thread.id)).toEqual(["thread-1", "thread-2"]);
    const graphqlCalls = calls.filter(args => args.includes("graphql"));
    expect(graphqlCalls).toHaveLength(4);
    expect(graphqlCalls.filter(args => !args.some(argument => argument.startsWith("after=")))).toHaveLength(2);
    expect(graphqlCalls.filter(args => args.some(argument => argument === "after=cursor-1"))).toHaveLength(2);
  });

  test("fails a snapshot when GraphQL reports errors instead of treating missing thread evidence as empty", async () => {
    const createGitHubReviewSource = (await requiredReviewFunction("createGitHubReviewSource")) as (
      (runGh: ReviewFunction, cwd?: string) => { fetchSnapshot(ref: string): Promise<ReviewSnapshot> }
    );
    const runGh: ReviewFunction = async argsValue => {
      const args = argsValue as readonly string[];
      if (args.includes("graphql")) {
        return { code: 0, stdout: JSON.stringify({ errors: [{ message: "forbidden" }] }), stderr: "" };
      }
      if (args.includes("view")) {
        return {
          code: 0,
          stdout: JSON.stringify({ headRefOid: HEAD_A, ...pullRequestFacts() }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const source = createGitHubReviewSource(runGh);

    await expect(source.fetchSnapshot("887")).rejects.toThrow("GraphQL errors");
  });
  test("rejects incomplete GraphQL thread payloads instead of returning an empty collection", async () => {
    const createGitHubReviewSource = (await requiredReviewFunction("createGitHubReviewSource")) as (
      (runGh: ReviewFunction, cwd?: string) => { fetchSnapshot(ref: string): Promise<ReviewSnapshot> }
    );
    const runGh: ReviewFunction = async argsValue => {
      const args = argsValue as readonly string[];
      if (args.includes("graphql")) {
        return {
          code: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
          stderr: "",
        };
      }
      if (args.includes("view")) {
        return {
          code: 0,
          stdout: JSON.stringify({ headRefOid: HEAD_A, ...pullRequestFacts() }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };

    const source = createGitHubReviewSource(runGh);
    await expect(source.fetchSnapshot("887")).rejects.toThrow("pageInfo");
  });
  test("rejects a pull request response without a head SHA", async () => {
    const createGitHubReviewSource = (await requiredReviewFunction("createGitHubReviewSource")) as (
      (runGh: ReviewFunction, cwd?: string) => { getPullRequest(ref: string): Promise<unknown> }
    );
    const runGh: ReviewFunction = async argsValue => {
      const args = argsValue as readonly string[];
      if (args.includes("view")) {
        return { code: 0, stdout: JSON.stringify(pullRequestFacts()), stderr: "" };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const source = createGitHubReviewSource(runGh);

    await expect(source.getPullRequest("887")).rejects.toThrow("head SHA");
  });
});

type TimerJob = {
  callback: () => void | Promise<void>;
  delayMs: number;
  nextAt: number;
  active: boolean;
};

class ManualScheduler {
  now = 0;
  readonly jobs: TimerJob[] = [];

  setInterval(callback: TimerJob["callback"], delayMs: number): TimerJob {
    const job: TimerJob = { callback, delayMs, nextAt: this.now + delayMs, active: true };
    this.jobs.push(job);
    return job;
  }

  clearInterval(job: TimerJob): void {
    job.active = false;
  }

  activeDelays(): number[] {
    return this.jobs.filter(job => job.active).map(job => job.delayMs);
  }

  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    for (;;) {
      const due = this.jobs
        .filter(job => job.active && job.nextAt <= target)
        .sort((left, right) => left.nextAt - right.nextAt)[0];
      if (!due) break;
      this.now = due.nextAt;
      due.nextAt += due.delayMs;
      await due.callback();
    }
    this.now = target;
  }
}

class SequenceSource {
  calls = 0;
  readonly refs: string[] = [];

  constructor(private readonly results: readonly (ReviewSnapshot | Error)[]) {}

  async fetchSnapshot(ref: string): Promise<ReviewSnapshot> {
    this.refs.push(ref);
    const result = this.results[Math.min(this.calls++, this.results.length - 1)];
    if (result instanceof Error) throw result;
    return result as ReviewSnapshot;
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function newWatcher(
  entries: readonly (ReviewSnapshot | Error)[],
  options: { sessionId?: string; scheduler?: ManualScheduler } = {},
): Promise<{
  watcher: ReviewWatcher;
  source: SequenceSource;
  scheduler: ManualScheduler;
  notifications: ReviewState[];
}> {
  const createReviewWatcher = (await requiredReviewFunction("createReviewWatcher")) as (
    options: Record<string, unknown>,
  ) => ReviewWatcher;
  const source = new SequenceSource(entries);
  const scheduler = options.scheduler ?? new ManualScheduler();
  const notifications: ReviewState[] = [];
  const watcher = createReviewWatcher({
    sessionId: options.sessionId ?? "session-a",
    ref: REF,
    source,
    schedule: scheduler,
    requiredApprovals: 2,
    pollIntervalMs: 60_000,
    notify: (state: ReviewState) => notifications.push(state),
  });
  return { watcher, source, scheduler, notifications };
}

describe("review watcher", () => {
  test("polls every 60 seconds, emits complete initial evidence, and deduplicates 30 minutes of unchanged snapshots", async () => {
    const first = snapshot({
      reviews: [review("r1", "alice", "APPROVED"), review("r2", "bob", "APPROVED")],
      issueComments: [comment("i1", "dana", "ordinary review context")],
      reviewComments: [comment("c1", "frank", "inline review context")],
      threads: [
        {
          id: "t1",
          path: "src/review.ts",
          line: 42,
          isResolved: true,
          comments: [comment("tc1", "frank", "resolved thread")],
        },
      ],
    });
    const { watcher, source, scheduler, notifications } = await newWatcher([first]);

    await watcher.start();

    expect(source.calls).toBe(1);
    expect(source.refs).toEqual([REF]);
    expect(scheduler.activeDelays()).toEqual([60_000]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      headSha: HEAD_A,
      ready: true,
      reviews: [{ id: "r1", body: "approved body from alice" }, { id: "r2", body: "approved body from bob" }],
      issueComments: [{ id: "i1", body: "ordinary review context" }],
      reviewComments: [{ id: "c1", body: "inline review context" }],
      threads: [{ id: "t1", isResolved: true }],
      pullRequest: {
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ context: "ci/test", state: "SUCCESS" }],
      },
    });

    await scheduler.advance(30 * 60_000);

    expect(source.calls).toBe(31);
    expect(notifications).toHaveLength(1);
  });

  test("emits again when ordinary or inline comment evidence changes even if the gate stays ready", async () => {
    const first = readySnapshot();
    const unchanged = snapshot({
      reviews: first.reviews,
      issueComments: [comment("i1", "dana", "before")],
      reviewComments: [comment("c1", "frank", "inline before")],
    });
    const changed = snapshot({
      reviews: first.reviews,
      issueComments: [comment("i1", "dana", "after", "2026-09-11T00:03:00Z")],
      reviewComments: [comment("c1", "frank", "inline after", "2026-09-11T00:03:00Z")],
    });
    const { watcher, scheduler, notifications } = await newWatcher([unchanged, unchanged, changed]);

    await watcher.start();
    await scheduler.advance(60_000);
    expect(notifications).toHaveLength(1);

    await scheduler.advance(60_000);

    expect(notifications).toHaveLength(2);
    expect(notifications[1]?.ready).toBe(true);
    expect(notifications[1]?.issueComments[0]?.body).toBe("after");
    expect(notifications[1]?.reviewComments[0]?.body).toBe("inline after");
  });

  test("cancellation prevents an in-flight fetch from notifying or changing session state", async () => {
    const deferred = createDeferred<ReviewSnapshot>();
    const scheduler = new ManualScheduler();
    const source = { fetchSnapshot: async (_ref: string) => deferred.promise };
    const createReviewWatcher = (await requiredReviewFunction("createReviewWatcher")) as (
      options: Record<string, unknown>,
    ) => ReviewWatcher;
    const notifications: ReviewState[] = [];
    const watcher = createReviewWatcher({
      sessionId: "session-cancelled",
      ref: REF,
      source,
      schedule: scheduler,
      notify: (state: ReviewState) => notifications.push(state),
      pollIntervalMs: 60_000,
    });

    const start = watcher.start();
    watcher.cancel();
    deferred.resolve(readySnapshot());
    await start;

    expect(notifications).toHaveLength(0);
    expect(watcher.getState().ready).toBe(false);
    expect(scheduler.activeDelays()).toEqual([]);
  });

  test("pausing a session stops polling, and resuming it rechecks the current head", async () => {
    const pending = snapshot();
    const ready = readySnapshot();
    const { watcher, source, scheduler, notifications } = await newWatcher([pending, ready]);

    await watcher.start();
    watcher.pause();
    await scheduler.advance(30 * 60_000);

    expect(source.calls).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(watcher.getState().ready).toBe(false);
    expect(scheduler.activeDelays()).toEqual([]);

    await watcher.resume();

    expect(source.calls).toBe(2);
    expect(watcher.getState().ready).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(scheduler.activeDelays()).toEqual([60_000]);
  });

  test("cancelling one session does not stop another session's watcher", async () => {
    const scheduler = new ManualScheduler();
    const first = await newWatcher([readySnapshot()], { sessionId: "session-one", scheduler });
    const second = await newWatcher([readySnapshot()], { sessionId: "session-two", scheduler });

    await Promise.all([first.watcher.start(), second.watcher.start()]);
    first.watcher.cancel();
    await scheduler.advance(60_000);

    expect(first.source.calls).toBe(1);
    expect(first.notifications).toHaveLength(1);
    expect(second.source.calls).toBe(2);
    expect(second.notifications).toHaveLength(1);
    expect(second.watcher.getState().ready).toBe(true);
  });

  test("surfaces an API failure as an error state instead of an empty successful gate", async () => {
    const { watcher, source, scheduler, notifications } = await newWatcher([new Error("GitHub API unavailable")]);

    await watcher.start();

    expect(source.calls).toBe(1);
    expect(watcher.getState().ready).toBe(false);
    expect(watcher.getState().error).toContain("GitHub API unavailable");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.ready).toBe(false);
    expect(notifications[0]?.error).toContain("GitHub API unavailable");
    expect(scheduler.activeDelays()).toEqual([120_000]);
  });
  test("keeps the gate in an explicit error state and retries delivery after notification or persistence failures", async () => {
    const scheduler = new ManualScheduler();
    const notifications: ReviewState[] = [];
    const errors: string[] = [];
    let notifyAttempts = 0;
    let persistAttempts = 0;
    const createReviewWatcher = (await requiredReviewFunction("createReviewWatcher")) as (
      options: Record<string, unknown>,
    ) => ReviewWatcher;
    const watcher = createReviewWatcher({
      sessionId: "session-delivery-failure",
      ref: REF,
      source: { fetchSnapshot: async () => readySnapshot() },
      schedule: scheduler,
      pollIntervalMs: 60_000,
      notify: (state: ReviewState) => {
        notifyAttempts += 1;
        if (notifyAttempts === 1) throw new Error("notification sink unavailable");
        notifications.push(state);
      },
      persist: async () => {
        persistAttempts += 1;
        if (persistAttempts === 1) throw new Error("session persistence unavailable");
      },
      onError: (error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    await watcher.start();

    expect(watcher.getState().error).toBe("notification sink unavailable");
    expect(notifications).toHaveLength(0);
    expect(errors).toEqual(["notification sink unavailable"]);

    await scheduler.advance(2 * 60_000);

    expect(notifyAttempts).toBeGreaterThan(2);
    expect(persistAttempts).toBeGreaterThan(1);
    expect(notifications.at(-1)?.ready).toBe(true);
    expect(watcher.getState().error).toBeNull();
  });

  test("does not let a paused generation's fetch block a fresh resume refresh", async () => {
    const firstFetch = createDeferred<ReviewSnapshot>();
    const scheduler = new ManualScheduler();
    let calls = 0;
    const createReviewWatcher = (await requiredReviewFunction("createReviewWatcher")) as (
      options: Record<string, unknown>,
    ) => ReviewWatcher;
    const watcher = createReviewWatcher({
      sessionId: "session-generation",
      ref: REF,
      source: {
        fetchSnapshot: async () => {
          calls += 1;
          return calls === 1 ? firstFetch.promise : readySnapshot(HEAD_B);
        },
      },
      schedule: scheduler,
      pollIntervalMs: 60_000,
      notify: () => undefined,
    });

    const start = watcher.start();
    await Promise.resolve();
    watcher.pause();
    await watcher.resume();

    expect(calls).toBe(2);
    expect(watcher.getState()).toMatchObject({ headSha: HEAD_B, ready: true });

    firstFetch.resolve(snapshot({ headSha: HEAD_A }));
    await start;
    expect(watcher.getState()).toMatchObject({ headSha: HEAD_B, ready: true });
  });

  test("restores a persisted fingerprint without replaying an unchanged notification", async () => {
    const createReviewState = (await requiredReviewFunction("createReviewState")) as (
      options?: { requiredApprovals?: number },
    ) => ReviewState;
    const applyReviewSnapshot = (await requiredReviewFunction("applyReviewSnapshot")) as (
      (state: ReviewState, next: ReviewSnapshot) => ReviewState
    );
    const reviewStateFingerprint = await requiredReviewFunction("reviewStateFingerprint");
    const restored = applyReviewSnapshot(createReviewState({ requiredApprovals: 2 }), readySnapshot());
    const scheduler = new ManualScheduler();
    const notifications: ReviewState[] = [];
    const createReviewWatcher = (await requiredReviewFunction("createReviewWatcher")) as (
      options: Record<string, unknown>,
    ) => ReviewWatcher;
    const watcher = createReviewWatcher({
      sessionId: "session-restored",
      ref: REF,
      source: { fetchSnapshot: async () => readySnapshot() },
      schedule: scheduler,
      initialHeadSha: HEAD_A,
      initialFingerprint: reviewStateFingerprint(restored),
      notify: (state: ReviewState) => notifications.push(state),
    });

    await watcher.start();

    expect(watcher.getState()).toMatchObject({ headSha: HEAD_A, ready: true });
    expect(notifications).toHaveLength(0);
  });
});
