export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export type ReviewRecord = {
  id: string;
  author: string;
  state: ReviewDecision;
  commitSha: string;
  body: string;
  submittedAt: string;
  url: string;
};

export type CommentRecord = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  path?: string;
  line?: number | null;
  inReplyToId?: string | null;
};

export type ThreadRecord = {
  id: string;
  path: string;
  line: number;
  isResolved: boolean;
  isBlocking?: boolean;
  comments: readonly CommentRecord[];
};

export type StatusCheck = {
  context: string;
  state: string;
  detailsUrl: string;
};

export type PullRequestFacts = {
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  mergeStateStatus: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null | string;
  statusCheckRollup: readonly StatusCheck[];
};

export type ReviewSnapshot = {
  headSha: string;
  pullRequest: PullRequestFacts;
  reviews: readonly ReviewRecord[];
  issueComments: readonly CommentRecord[];
  reviewComments: readonly CommentRecord[];
  threads: readonly ThreadRecord[];
};

export type ReviewState = ReviewSnapshot & {
  requiredApprovals: number;
  ready: boolean;
  approvals: readonly ReviewRecord[];
  changesRequested: readonly ReviewRecord[];
  error?: string | null;
  lastCheckedAt?: number;
};


export type ReviewSource = {
  fetchSnapshot(ref: string): Promise<ReviewSnapshot>;
};

export type ReviewScheduler = {
  setInterval(callback: () => void | Promise<void>, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
};

export type ReviewWatcherOptions = {
  sessionId: string;
  ref: string;
  source: ReviewSource;
  schedule: ReviewScheduler;
  notify: (state: ReviewState) => void | Promise<void>;
  persist?: (state: ReviewState, fingerprint: string) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  initialFingerprint?: string;
  initialHeadSha?: string;
  requiredApprovals?: number;
  pollIntervalMs?: number;
  now?: () => number;
};

export type ReviewWatcher = {
  start(): Promise<void>;
  refresh(): Promise<void>;
  cancel(): void;
  pause(): void;
  resume(): Promise<void>;
  getState(): ReviewState;
};

export type PullRequestLookup = {
  headSha: string;
  pullRequest?: PullRequestFacts;
  state?: PullRequestFacts["state"];
  mergeable?: PullRequestFacts["mergeable"];
  mergeStateStatus?: string;
  reviewDecision?: PullRequestFacts["reviewDecision"];
  statusCheckRollup?: readonly StatusCheck[];
  threads?: readonly ThreadRecord[];
};

export type PaginatedReviewSource = {
  getPullRequest(ref: string): Promise<PullRequestLookup>;
  listReviews(ref: string, page: number, perPage: number): Promise<readonly ReviewRecord[]>;
  listIssueComments(ref: string, page: number, perPage: number): Promise<readonly CommentRecord[]>;
  listReviewComments(ref: string, page: number, perPage: number): Promise<readonly CommentRecord[]>;
  listThreads?(ref: string, page: number, perPage: number): Promise<readonly ThreadRecord[]>;
  collectThreads?(ref: string, perPage: number): Promise<readonly ThreadRecord[]>;
};

export type GhResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type GhExecutor = (args: readonly string[], cwd?: string) => Promise<GhResult>;

type RawRecord = Record<string, unknown>;
const DEFAULT_REQUIRED_APPROVALS = 2;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_PAGE_SIZE = 100;

function emptyPullRequestFacts(): PullRequestFacts {
  return {
    state: "UNKNOWN",
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    reviewDecision: null,
    statusCheckRollup: [],
  };
}

function asRecord(value: unknown): RawRecord {
  return typeof value === "object" && value !== null ? (value as RawRecord) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function upper(value: unknown, fallback: string): string {
  const result = text(value, fallback).trim().toUpperCase();
  return result || fallback;
}

function reviewerName(reviewItem: ReviewRecord): string {
  return reviewItem.author.trim().toLowerCase();
}

function reviewTimestamp(reviewItem: ReviewRecord): number {
  const time = Date.parse(reviewItem.submittedAt);
  return Number.isFinite(time) ? time : 0;
}

function latestDecisiveReviews(reviews: readonly ReviewRecord[]): Map<string, ReviewRecord> {
  const latest = new Map<string, ReviewRecord>();
  reviews.forEach((reviewItem, index) => {
    if (reviewItem.state !== "APPROVED" && reviewItem.state !== "CHANGES_REQUESTED" && reviewItem.state !== "DISMISSED") return;
    const key = reviewerName(reviewItem);
    if (!key) return;
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, reviewItem);
      return;
    }
    const previousTime = reviewTimestamp(previous);
    const currentTime = reviewTimestamp(reviewItem);
    if (currentTime > previousTime || (currentTime === previousTime && reviews.indexOf(previous) < index)) {
      latest.set(key, reviewItem);
    }
  });
  return latest;
}

export function reviewStateFingerprint(state: ReviewState): string {
  return JSON.stringify({
    ready: state.ready,
    headSha: state.headSha,
    pullRequest: state.pullRequest,
    reviews: state.reviews,
    issueComments: state.issueComments,
    reviewComments: state.reviewComments,
    threads: state.threads,
    approvals: state.approvals,
    changesRequested: state.changesRequested,
    error: state.error ?? null,
  });
}

export function createReviewState(options: { requiredApprovals?: number } = {}): ReviewState {
  const requiredApprovals = Math.max(1, Math.floor(options.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS));
  return {
    requiredApprovals,
    ready: false,
    headSha: "",
    pullRequest: emptyPullRequestFacts(),
    reviews: [],
    issueComments: [],
    reviewComments: [],
    threads: [],
    approvals: [],
    changesRequested: [],
    error: null,
  };
}

export function applyReviewSnapshot(state: ReviewState, next: ReviewSnapshot): ReviewState {
  const latest = latestDecisiveReviews(next.reviews);
  const approvals: ReviewRecord[] = [];
  const changesRequested: ReviewRecord[] = [];
  for (const reviewItem of latest.values()) {
    if (reviewItem.state === "CHANGES_REQUESTED") {
      changesRequested.push(reviewItem);
    } else if (reviewItem.state === "APPROVED" && reviewItem.commitSha === next.headSha) {
      approvals.push(reviewItem);
    }
  }
  const ready = changesRequested.length === 0 && approvals.length >= state.requiredApprovals;
  return {
    requiredApprovals: state.requiredApprovals,
    ready,
    headSha: next.headSha,
    pullRequest: next.pullRequest,
    reviews: [...next.reviews],
    issueComments: [...next.issueComments],
    reviewComments: [...next.reviewComments],
    threads: [...next.threads],
    approvals,
    changesRequested,
    error: null,
    lastCheckedAt: state.lastCheckedAt,
  };
}

async function collectPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<readonly T[]>,
  pageSize: number,
): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await fetchPage(page, pageSize);
    result.push(...rows);
    if (rows.length < pageSize) return result;
  }
}

export async function loadReviewSnapshot(
  source: PaginatedReviewSource,
  ref: string,
  options: { pageSize?: number } = {},
): Promise<ReviewSnapshot> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const firstPullRequest = await source.getPullRequest(ref);
    const firstPullFacts = firstPullRequest.pullRequest ?? {
      state: firstPullRequest.state ?? "UNKNOWN",
      mergeable: firstPullRequest.mergeable ?? "UNKNOWN",
      mergeStateStatus: firstPullRequest.mergeStateStatus ?? "UNKNOWN",
      reviewDecision: firstPullRequest.reviewDecision ?? null,
      statusCheckRollup: firstPullRequest.statusCheckRollup ?? [],
    };
    const [reviews, issueComments, reviewComments, threads] = await Promise.all([
      collectPages(page => source.listReviews(ref, page, pageSize), pageSize),
      collectPages(page => source.listIssueComments(ref, page, pageSize), pageSize),
      collectPages(page => source.listReviewComments(ref, page, pageSize), pageSize),
      source.collectThreads
        ? source.collectThreads(ref, pageSize)
        : source.listThreads
          ? collectPages(page => source.listThreads!(ref, page, pageSize), pageSize)
          : Promise.resolve([...(firstPullRequest.threads ?? [])]),
    ]);
    const lastPullRequest = await source.getPullRequest(ref);
    if (lastPullRequest.headSha !== firstPullRequest.headSha) {
      if (attempt === 1) throw new Error("pull request head changed while collecting review evidence");
      continue;
    }
    return {
      headSha: lastPullRequest.headSha,
      pullRequest: lastPullRequest.pullRequest ?? firstPullFacts,
      reviews,
      issueComments,
      reviewComments,
      threads,
    };
  }
  throw new Error("unable to obtain a stable pull request snapshot");
}

export function createReviewWatcher(options: ReviewWatcherOptions): ReviewWatcher {
  const pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const now = options.now ?? Date.now;
  let state = {
    ...createReviewState({ requiredApprovals: options.requiredApprovals }),
    headSha: options.initialHeadSha ?? "",
  };
  let timer: unknown;
  let active = false;
  let paused = false;
  let cancelled = false;
  let generation = 0;
  let failureCount = 0;
  let lastFingerprint: string | undefined = options.initialFingerprint;
  let refreshInFlight: { generation: number; promise: Promise<void> } | undefined;

  const isAlive = (expectedGeneration: number): boolean =>
    active && !paused && !cancelled && expectedGeneration === generation;

  const notifyIfChanged = async (next: ReviewState, expectedGeneration: number): Promise<void> => {
    if (!isAlive(expectedGeneration)) return;
    const fingerprint = reviewStateFingerprint(next);
    state = next;
    if (fingerprint === lastFingerprint) return;
    try {
      await options.notify(next);
      if (!isAlive(expectedGeneration)) return;
      if (options.persist) {
        await options.persist(next, fingerprint);
        if (!isAlive(expectedGeneration)) return;
      }
      lastFingerprint = fingerprint;
    } catch (error) {
      if (!isAlive(expectedGeneration)) return;
      state = {
        ...state,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: now(),
      };
      if (!options.onError) return;
      try {
        await options.onError(error);
      } catch {
        // Error reporting must not terminate the background watcher.
      }
    }
  };

  const refreshInternal = async (expectedGeneration: number): Promise<void> => {
    if (!isAlive(expectedGeneration)) return;
    try {
      const snapshot = await options.source.fetchSnapshot(options.ref);
      if (!isAlive(expectedGeneration)) return;
      failureCount = 0;
      const next = applyReviewSnapshot(state, snapshot);
      next.lastCheckedAt = now();
      await notifyIfChanged(next, expectedGeneration);
    } catch (error) {
      if (!isAlive(expectedGeneration)) return;
      failureCount = Math.min(failureCount + 1, 8);
      const next: ReviewState = {
        ...state,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        lastCheckedAt: now(),
      };
      await notifyIfChanged(next, expectedGeneration);
    }
  };

  const scheduleNext = (expectedGeneration: number): void => {
    if (!isAlive(expectedGeneration) || timer !== undefined) return;
    const delayMs = Math.min(pollIntervalMs * 2 ** failureCount, MAX_BACKOFF_MS);
    let handle: unknown;
    const callback = async (): Promise<void> => {
      if (timer === handle) timer = undefined;
      options.schedule.clearInterval(handle);
      if (!isAlive(expectedGeneration)) return;
      await refresh();
      scheduleNext(expectedGeneration);
    };
    handle = options.schedule.setInterval(callback, delayMs);
    timer = handle;
  };

  const refresh = async (): Promise<void> => {
    if (!active || paused || cancelled) return;
    if (refreshInFlight?.generation === generation) return refreshInFlight.promise;
    const expectedGeneration = generation;
    let promise: Promise<void>;
    promise = refreshInternal(expectedGeneration).finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = undefined;
    });
    refreshInFlight = { generation: expectedGeneration, promise };
    await promise;
  };

  return {
    async start(): Promise<void> {
      if (cancelled || active) return;
      active = true;
      paused = false;
      generation += 1;
      await refresh();
      scheduleNext(generation);
    },

    refresh,

    cancel(): void {
      generation += 1;
      active = false;
      paused = false;
      cancelled = true;
      if (timer !== undefined) {
        options.schedule.clearInterval(timer);
        timer = undefined;
      }
      state = { ...state, ready: false, error: null };
      lastFingerprint = undefined;
    },

    pause(): void {
      if (cancelled || !active) return;
      generation += 1;
      paused = true;
      active = false;
      if (timer !== undefined) {
        options.schedule.clearInterval(timer);
        timer = undefined;
      }
    },

    async resume(): Promise<void> {
      if (cancelled || active) return;
      paused = false;
      active = true;
      generation += 1;
      await refresh();
      scheduleNext(generation);
    },

    getState(): ReviewState {
      return state;
    },
  };
}

export type PullRequestRef = {
  owner: "Mininglamp-OSS";
  repo: "octo-server";
  number: string;
};

export function parsePullRequestRef(input: string): PullRequestRef {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    return { owner: "Mininglamp-OSS", repo: "octo-server", number: value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("pr must be a pull request number or a GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("pr must use the github.com HTTPS URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[0] !== "Mininglamp-OSS" || parts[1] !== "octo-server" || parts[2] !== "pull" || !/^\d+$/.test(parts[3]!)) {
    throw new Error("pr must target Mininglamp-OSS/octo-server");
  }
  return { owner: "Mininglamp-OSS", repo: "octo-server", number: parts[3]! };
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireArray(stdout: string, label: string): readonly RawRecord[] {
  const parsed = parseJson(stdout, label);
  if (!Array.isArray(parsed)) throw new Error(`${label} returned a non-array response`);
  return parsed.map(value => asRecord(value));
}

function rawUser(value: unknown): string {
  const candidate = asRecord(value);
  return text(candidate.login ?? candidate.name ?? value);
}

function normalizeReview(value: RawRecord): ReviewRecord {
  const state = upper(value.state, "COMMENTED");
  const decision: ReviewDecision = state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED" ? state : "COMMENTED";
  return {
    id: numberText(value.id),
    author: rawUser(value.user ?? value.author),
    state: decision,
    commitSha: text(value.commit_id ?? value.commitSha),
    body: text(value.body),
    submittedAt: text(value.submitted_at ?? value.submittedAt),
    url: text(value.html_url ?? value.url),
  };
}

function normalizeComment(value: RawRecord): CommentRecord {
  const replyTo = asRecord(value.replyTo ?? value.reply_to);
  const replyToId = value.in_reply_to_id ?? value.inReplyToId ?? replyTo.databaseId ?? replyTo.id;
  return {
    id: numberText(value.id ?? value.databaseId),
    author: rawUser(value.user ?? value.author),
    body: text(value.body),
    createdAt: text(value.created_at ?? value.createdAt),
    updatedAt: text(value.updated_at ?? value.updatedAt),
    url: text(value.html_url ?? value.url),
    path: typeof value.path === "string" ? value.path : undefined,
    line: optionalNumber(value.line),
    inReplyToId: typeof replyToId === "number" || typeof replyToId === "string" ? numberText(replyToId) : null,
  };
}

function normalizeThread(value: RawRecord): ThreadRecord {
  const commentsValue = value.comments;
  const commentsRecord = asRecord(commentsValue);
  const commentRows = Array.isArray(commentsValue)
    ? commentsValue
    : Array.isArray(commentsRecord.nodes)
      ? commentsRecord.nodes
      : [];
  const comments = commentRows.map(item => normalizeComment(asRecord(item)));
  return {
    id: numberText(value.id ?? value.databaseId),
    path: text(value.path),
    line: optionalNumber(value.line) ?? 0,
    isResolved: value.isResolved === true || value.is_resolved === true,
    isBlocking: value.isBlocking === true || value.is_blocking === true ? true : undefined,
    comments,
  };
}

function normalizeStatusCheck(value: unknown): StatusCheck {
  const record = asRecord(value);
  return {
    context: text(record.context ?? record.name ?? record.__typename),
    state: upper(record.state ?? record.conclusion ?? record.status, "UNKNOWN"),
    detailsUrl: text(record.detailsUrl ?? record.details_url ?? record.targetUrl ?? record.target_url),
  };
}

function normalizePullRequestFacts(value: RawRecord): PullRequestFacts {
  const checks = Array.isArray(value.statusCheckRollup)
    ? value.statusCheckRollup.map(normalizeStatusCheck)
    : Array.isArray(value.status_check_rollup)
      ? value.status_check_rollup.map(normalizeStatusCheck)
      : [];
  const mergeable = upper(value.mergeable, "UNKNOWN");
  return {
    state: upper(value.state, "UNKNOWN"),
    mergeable,
    mergeStateStatus: upper(value.mergeStateStatus ?? value.mergeable_state, "UNKNOWN"),
    reviewDecision: value.reviewDecision === null || value.review_decision === null
      ? null
      : upper(value.reviewDecision ?? value.review_decision, "UNKNOWN"),
    statusCheckRollup: checks,
  };
}

function githubEndpoint(ref: string, suffix: string): string {
  const parsed = parsePullRequestRef(ref);
  return `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/${suffix}`;
}

export function createGitHubReviewSource(runGh: GhExecutor, cwd?: string): ReviewSource & PaginatedReviewSource {
  const apiPage = async (endpoint: string, label: string): Promise<readonly RawRecord[]> => {
    const result = await runGh(["api", endpoint], cwd);
    if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return requireArray(result.stdout, label);
  };

  const getPullRequest = async (ref: string): Promise<PullRequestLookup> => {
    const parsed = parsePullRequestRef(ref);
    const result = await runGh(
      ["pr", "view", parsed.number, "--repo", `${parsed.owner}/${parsed.repo}`, "--json", "state,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"],
      cwd,
    );
    if (result.code !== 0) throw new Error(`pull request lookup failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    const raw = asRecord(parseJson(result.stdout, "pull request lookup"));
    const pullRequest = normalizePullRequestFacts(raw);
    const head = asRecord(raw.head);
    const headSha = text(raw.headRefOid ?? head.sha).trim();
    if (!headSha) throw new Error("pull request lookup did not return head SHA");
    return { headSha, pullRequest };
  };

  const listReviews = (ref: string, page: number, perPage: number): Promise<readonly ReviewRecord[]> =>
    apiPage(`${githubEndpoint(ref, "reviews")}?per_page=${perPage}&page=${page}`, "pull request reviews").then(rows => rows.map(normalizeReview));

  const listIssueComments = (ref: string, page: number, perPage: number): Promise<readonly CommentRecord[]> => {
    const parsed = parsePullRequestRef(ref);
    return apiPage(`repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}/comments?per_page=${perPage}&page=${page}`, "issue comments").then(rows => rows.map(normalizeComment));
  };

  const listReviewComments = (ref: string, page: number, perPage: number): Promise<readonly CommentRecord[]> =>
    apiPage(`${githubEndpoint(ref, "comments")}?per_page=${perPage}&page=${page}`, "inline review comments").then(rows => rows.map(normalizeComment));

  type ThreadPage = {
    nodes: readonly ThreadRecord[];
    hasNextPage: boolean;
    endCursor: string | null;
  };
  const threadQuery = "query($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:$first,after:$after){nodes{id path line isResolved comments(first:100){nodes{id databaseId author{login} body createdAt updatedAt url path line replyTo{databaseId}}}}pageInfo{hasNextPage endCursor}}}}}";
  const fetchThreadPage = async (ref: string, perPage: number, after: string | null): Promise<ThreadPage> => {
    const parsed = parsePullRequestRef(ref);
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${threadQuery}`,
      "-f",
      `owner=${parsed.owner}`,
      "-f",
      `repo=${parsed.repo}`,
      "-F",
      `number=${parsed.number}`,
      "-F",
      `first=${perPage}`,
    ];
    if (after) args.push("-f", `after=${after}`);
    const result = await runGh(args, cwd);
    if (result.code !== 0) throw new Error(`review threads failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    const parsedRoot = parseJson(result.stdout, "review threads");
    if (typeof parsedRoot !== "object" || parsedRoot === null || Array.isArray(parsedRoot)) {
      throw new Error("review threads returned a non-object response");
    }
    const root = parsedRoot as RawRecord;
    if (Array.isArray(root.errors) && root.errors.length > 0) {
      throw new Error("review threads returned GraphQL errors");
    }
    if (typeof root.data !== "object" || root.data === null || Array.isArray(root.data)) {
      throw new Error("review threads response is missing data");
    }
    const data = root.data as RawRecord;
    if (typeof data.repository !== "object" || data.repository === null || Array.isArray(data.repository)) {
      throw new Error("review threads response is missing repository");
    }
    const repository = data.repository as RawRecord;
    if (typeof repository.pullRequest !== "object" || repository.pullRequest === null || Array.isArray(repository.pullRequest)) {
      throw new Error("review threads response is missing pull request");
    }
    const pullRequest = repository.pullRequest as RawRecord;
    if (typeof pullRequest.reviewThreads !== "object" || pullRequest.reviewThreads === null || Array.isArray(pullRequest.reviewThreads)) {
      throw new Error("review threads response is missing reviewThreads");
    }
    const reviewThreads = pullRequest.reviewThreads as RawRecord;
    if (!Array.isArray(reviewThreads.nodes)) {
      throw new Error("review threads response is missing nodes");
    }
    if (typeof reviewThreads.pageInfo !== "object" || reviewThreads.pageInfo === null || Array.isArray(reviewThreads.pageInfo)) {
      throw new Error("review threads response is missing pageInfo");
    }
    const pageInfo = reviewThreads.pageInfo as RawRecord;
    if (typeof pageInfo.hasNextPage !== "boolean") {
      throw new Error("review threads response has invalid pageInfo");
    }
    const endCursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
    if (pageInfo.hasNextPage && !endCursor) {
      throw new Error("review threads response hasNextPage without endCursor");
    }
    return {
      nodes: reviewThreads.nodes.map(item => normalizeThread(asRecord(item))),
      hasNextPage: pageInfo.hasNextPage,
      endCursor,
    };
  };
  const listThreads = async (ref: string, page: number, perPage: number): Promise<readonly ThreadRecord[]> => {
    let after: string | null = null;
    for (let currentPage = 1; currentPage <= page; currentPage += 1) {
      const current = await fetchThreadPage(ref, perPage, after);
      if (currentPage === page) return current.nodes;
      if (!current.hasNextPage) return [];
      after = current.endCursor;
    }
    return [];
  };
  const collectThreads = async (ref: string, perPage: number): Promise<readonly ThreadRecord[]> => {
    const nodes: ThreadRecord[] = [];
    let after: string | null = null;
    for (;;) {
      const current = await fetchThreadPage(ref, perPage, after);
      nodes.push(...current.nodes);
      if (!current.hasNextPage) return nodes;
      after = current.endCursor;
    }
  };
  const source: ReviewSource & PaginatedReviewSource = {
    getPullRequest,
    listReviews,
    listIssueComments,
    listReviewComments,
    listThreads,
    collectThreads,
    async fetchSnapshot(ref: string): Promise<ReviewSnapshot> {
      return loadReviewSnapshot(source, ref);
    },
  };
  return source;
}
