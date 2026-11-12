import type { Buffer } from "node:buffer";
import { createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  isRecord,
  OctoCliError,
  runOctoCliEnvelope,
  type OctoCliEnvelope,
  type OctoCliEnvironment,
} from "./backend.ts";

type JsonRecord = Record<string, unknown>;

export type LoopIdentity = Readonly<JsonRecord>;

export interface LoopPagination {
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

export interface LoopRead<T> {
  readonly data: T;
  readonly identity: LoopIdentity;
  readonly _pagination?: LoopPagination;
}

export interface LoopAttachment extends JsonRecord {
  readonly id: string;
}

export interface LoopComment extends JsonRecord {
  readonly comment_id: string;
  readonly task_id: string;
  readonly parent_id: string | null;
  readonly content: string;
  readonly attachments: readonly LoopAttachment[];
}

export interface LoopCommentSnapshot {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly commentId: string;
  readonly identity: LoopIdentity;
  readonly comment: LoopComment;
}

export interface LoopCommentInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly parentCommentId?: string;
  readonly editingCommentId?: string;
  readonly content: string;
  readonly attachmentIds?: readonly string[];
  readonly suppressExpertIds?: readonly string[];
}

interface NormalizedLoopCommentInput extends LoopCommentInput {
  readonly attachmentIds: readonly string[];
  readonly suppressExpertIds: readonly string[];
}

export type LoopCommentPreviewInput = LoopCommentInput;

export interface LoopPreviewExpert extends JsonRecord {
  readonly expert_id: string;
  readonly name: string;
  readonly source: string;
  readonly reason: string;
}


export interface LoopCommentPreview {
  readonly input: LoopCommentPreviewInput;
  readonly identity: LoopIdentity;
  readonly experts: readonly LoopPreviewExpert[];
}

export class LoopMutationOutcomeUnknownError extends Error {
  readonly outcome = "unknown";
  readonly operation: "create" | "update";
  readonly diagnostics: string;
  readonly errorType?: string;

  constructor(operation: "create" | "update", diagnostics: string, cause?: unknown) {
    super(diagnostics, { cause });
    this.name = "LoopMutationOutcomeUnknownError";
    this.operation = operation;
    this.diagnostics = diagnostics;
    this.errorType = cause instanceof OctoCliError ? cause.errorType : undefined;
  }
}

export class LoopMutationConfirmedResponseError extends Error {
  readonly outcome = "confirmed";
  readonly operation: "create" | "update";
  readonly diagnostics: string;
  readonly result: unknown;

  constructor(operation: "create" | "update", diagnostics: string, result: unknown, cause?: unknown) {
    super(diagnostics, { cause });
    this.name = "LoopMutationConfirmedResponseError";
    this.operation = operation;
    this.diagnostics = diagnostics;
    this.result = result;
  }
}

export class LoopMutationConfirmedCleanupError extends LoopMutationConfirmedResponseError {
  readonly cleanupDiagnostics: string;

  constructor(
    operation: "create" | "update",
    cleanupError: unknown,
    result: unknown,
    responseDiagnostics?: string,
  ) {
    const cleanupDiagnostics = errorText(cleanupError);
    const diagnostics = [
      `Loop comment ${operation} was confirmed by octo-cli`,
      responseDiagnostics ? `response identity was invalid: ${responseDiagnostics}` : undefined,
      `private credential snapshot cleanup failed: ${cleanupDiagnostics}`,
    ].filter((part): part is string => part !== undefined).join("; ");
    super(operation, diagnostics, result, cleanupError);
    this.name = "LoopMutationConfirmedCleanupError";
    this.cleanupDiagnostics = cleanupDiagnostics;
  }
}


const PAGE_SIZE = 20;
const MAX_COMMENT_RECORDS = 2_000;
const credentialHmacKeySymbol = Symbol.for("oh-my-pi.octo.loop.credential-hmac-key.v1");
const credentialProofsSymbol = Symbol.for("oh-my-pi.octo.loop.credential-proofs.v1");
const verifiedPreviewsSymbol = Symbol.for("oh-my-pi.octo.loop.verified-previews.v1");
const credentialSnapshotsSymbol = Symbol.for("oh-my-pi.octo.loop.credential-snapshots.v1");
const globalCredentialState = globalThis as unknown as Record<PropertyKey, unknown>;
const existingCredentialHmacKey = globalCredentialState[credentialHmacKeySymbol];
const credentialHmacKey = (() => {
  if (existingCredentialHmacKey instanceof Uint8Array && existingCredentialHmacKey.byteLength === 32) {
    return existingCredentialHmacKey;
  }
  if (existingCredentialHmacKey !== undefined) {
    throw new Error("Invalid process-wide Octo Loop credential proof key");
  }
  const generated = randomBytes(32);
  Object.defineProperty(globalThis, credentialHmacKeySymbol, {
    value: generated,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return generated;
})();
const existingCredentialProofs = globalCredentialState[credentialProofsSymbol];
const credentialProofs = (() => {
  if (existingCredentialProofs instanceof WeakMap) {
    return existingCredentialProofs as WeakMap<object, string>;
  }
  if (existingCredentialProofs !== undefined) {
    throw new Error("Invalid process-wide Octo Loop credential proof registry");
  }
  const generated = new WeakMap<object, string>();
  Object.defineProperty(globalThis, credentialProofsSymbol, {
    value: generated,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return generated;
})();
const existingVerifiedPreviews = globalCredentialState[verifiedPreviewsSymbol];
const verifiedPreviews = (() => {
  if (existingVerifiedPreviews instanceof WeakSet) {
    return existingVerifiedPreviews as WeakSet<object>;
  }
  if (existingVerifiedPreviews !== undefined) {
    throw new Error("Invalid process-wide Octo Loop preview registry");
  }
  const generated = new WeakSet<object>();
  Object.defineProperty(globalThis, verifiedPreviewsSymbol, {
    value: generated,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return generated;
})();
const existingCredentialSnapshots = globalCredentialState[credentialSnapshotsSymbol];
const credentialSnapshots = (() => {
  if (existingCredentialSnapshots instanceof WeakMap) {
    return existingCredentialSnapshots as WeakMap<object, LoopCredentialSnapshot>;
  }
  if (existingCredentialSnapshots !== undefined) {
    throw new Error("Invalid process-wide Octo Loop credential snapshot registry");
  }
  const generated = new WeakMap<object, LoopCredentialSnapshot>();
  Object.defineProperty(globalThis, credentialSnapshotsSymbol, {
    value: generated,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return generated;
})();
const PROFILE_FILES = ["config.json", "credentials.enc", "cred.salt"] as const;

interface LoopCredentialSnapshot {
  readonly octoEnv: Readonly<Record<string, string>>;
  readonly profileDir?: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly proof: string;
}
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;


function requireRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`octo-cli returned invalid ${description}`);
  return value;
}

function requireUuid(value: unknown, description: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${description}; expected a UUID`);
  }
  return value.toLowerCase();
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") throw new Error(`octo-cli returned invalid ${description}`);
  return value;
}

function requireIdentifier(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`octo-cli returned invalid ${description}`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function credentialProof(
  octoEnv: Readonly<Record<string, string>>,
  profileDir: string | undefined,
  files: ReadonlyMap<string, Buffer>,
): string {
  const hmac = createHmac("sha256", credentialHmacKey);
  hmac.update("profile-dir\u0000").update(profileDir ?? "<task-mode>").update("\u0000");
  for (const [key, value] of Object.entries(octoEnv).sort(([left], [right]) => left.localeCompare(right))) {
    hmac.update(key).update("\u0000").update(value).update("\u0000");
  }
  for (const [name, contents] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hmac.update(name).update("\u0000").update(contents).update("\u0000");
  }
  return hmac.digest("hex");
}

function sameProfileFiles(left: ReadonlyMap<string, Buffer>, right: ReadonlyMap<string, Buffer>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, contents] of left) {
    if (!right.get(name)?.equals(contents)) return false;
  }
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfLoopAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
}

async function readProfileFiles(
  profileDir: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of PROFILE_FILES) {
    throwIfLoopAborted(signal);
    try {
      files.set(name, await readFile(join(profileDir, name), { signal }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (signal?.aborted) throwIfLoopAborted(signal);
      throw new Error("Could not safely capture the active Octo CLI profile.", { cause: error });
    }
  }
  return files;
}

async function captureCredentialSnapshot(signal?: AbortSignal): Promise<LoopCredentialSnapshot> {
  throwIfLoopAborted(signal);
  const octoEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith("OCTO_") && typeof entry[1] === "string",
    ),
  );
  const home = process.env.HOME || homedir();
  const taskMode = octoEnv.OCTO_CREDENTIAL_MODE === "task";
  const profileDir = taskMode
    ? undefined
    : resolve(octoEnv.OCTO_CONFIG_DIR || join(home, ".octo-cli"));
  let files: ReadonlyMap<string, Buffer> = new Map();
  if (profileDir) {
    const first = await readProfileFiles(profileDir, signal);
    files = await readProfileFiles(profileDir, signal);
    if (!sameProfileFiles(first, files)) {
      throw new Error("The active Octo CLI profile changed while being captured; retry the read or preview.");
    }
  }
  const currentOctoEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith("OCTO_") && typeof entry[1] === "string",
    ),
  );
  const currentHome = process.env.HOME || homedir();
  const currentProfileDir = taskMode
    ? undefined
    : resolve(currentOctoEnv.OCTO_CONFIG_DIR || join(currentHome, ".octo-cli"));
  if (!isDeepStrictEqual(octoEnv, currentOctoEnv) || profileDir !== currentProfileDir) {
    throw new Error("The active Octo CLI environment or profile path changed while being captured.");
  }
  const frozenEnv = Object.freeze(octoEnv);
  return Object.freeze({
    octoEnv: frozenEnv,
    profileDir,
    files,
    proof: credentialProof(frozenEnv, profileDir, files),
  });
}

async function assertCurrentCredentialSnapshot(
  expected: LoopCredentialSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const current = await captureCredentialSnapshot(signal);
  if (current.proof !== expected.proof) {
    throw new Error(
      "The active Octo CLI identity or profile changed after preview; re-read and preview again before submitting.",
    );
  }
}

interface CredentialSnapshotRun<T> {
  readonly value: T;
  readonly cleanupError?: unknown;
  readonly cleanupFailed?: boolean;
}

async function withCredentialSnapshot<T>(
  snapshot: LoopCredentialSnapshot,
  run: (environment: OctoCliEnvironment) => Promise<T>,
  signal?: AbortSignal,
): Promise<CredentialSnapshotRun<T>> {
  throwIfLoopAborted(signal);
  const directory = await mkdtemp(join(tmpdir(), "omp-octo-loop-"));
  let value: T | undefined;
  let runError: unknown;
  let runFailed = false;
  try {
    throwIfLoopAborted(signal);
    await chmod(directory, 0o700);
    for (const [name, contents] of snapshot.files) {
      throwIfLoopAborted(signal);
      await writeFile(join(directory, name), contents, { flag: "wx", mode: 0o600 });
    }
    await assertCurrentCredentialSnapshot(snapshot, signal);
    throwIfLoopAborted(signal);
    // Task credentials are supplied by the task environment, not the host's saved profile.
    const values = { ...snapshot.octoEnv, OCTO_CONFIG_DIR: directory };
    value = await run({ values, replaceOcto: true });
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (runFailed) {
    if (cleanupFailed) {
      const cleanupDiagnostic = `Temporary credential snapshot cleanup also failed: ${errorText(cleanupError)}`;
      if (runError instanceof OctoCliError) {
        throw new OctoCliError(
          `${runError.message}; ${cleanupDiagnostic}`,
          runError.certainty,
          runError.errorType,
          runError.name,
        );
      }
      throw new Error(`${errorText(runError)}; ${cleanupDiagnostic}`, { cause: runError });
    }
    throw runError;
  }
  return cleanupFailed
    ? { value: value as T, cleanupError, cleanupFailed: true }
    : { value: value as T };
}

function identityFromEnvelope(envelope: OctoCliEnvelope, proof: string): LoopIdentity {
  const identity = requireRecord(envelope.identity, "identity");
  if (Object.keys(identity).length === 0) throw new Error("octo-cli returned an empty identity");
  const frozen = deepFreeze(identity);
  credentialProofs.set(frozen, proof);
  return frozen;
}

function credentialProofFor(identity: LoopIdentity): string | undefined {
  return credentialProofs.get(identity);
}

export function sameLoopIdentity(left: LoopIdentity, right: LoopIdentity): boolean {
  const leftProof = credentialProofFor(left);
  return leftProof !== undefined && leftProof === credentialProofFor(right) && isDeepStrictEqual(left, right);
}

function assertExpectedIdentity(actual: LoopIdentity, expected: LoopIdentity | undefined): void {
  if (expected && !sameLoopIdentity(actual, expected)) {
    throw new Error("The active Octo Loop identity changed; re-read the resource before continuing.");
  }
}

function isLoopCommentMutation(args: readonly string[]): boolean {
  return (
    args[0] === "loop" && args[1] === "task" && args[2] === "comment" && args[3] === "create"
  ) || (
    args[0] === "loop" && args[1] === "comment" && args[2] === "update"
  );
}

async function runLoopCli(
  args: string[],
  input?: string,
  signal?: AbortSignal,
  snapshot?: LoopCredentialSnapshot,
): Promise<{
  envelope: OctoCliEnvelope;
  identity: LoopIdentity;
  cleanupError?: unknown;
  cleanupFailed?: boolean;
}> {
  if (signal?.aborted && isLoopCommentMutation(args)) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("The operation was aborted.");
    throw new OctoCliError(
      `${reason.message}; the comment write was not started.`,
      "rejected",
      undefined,
      "AbortError",
    );
  }
  const credentials = snapshot ?? await captureCredentialSnapshot(signal);
  let runStarted = false;
  let runResult: CredentialSnapshotRun<OctoCliEnvelope>;
  try {
    runResult = await withCredentialSnapshot(credentials, (environment) => {
      runStarted = true;
      return runOctoCliEnvelope(args, input, signal, environment);
    }, signal);
  } catch (error) {
    if (isLoopCommentMutation(args) && !runStarted) {
      const diagnostics = errorText(error);
      throw new OctoCliError(
        `${diagnostics}; the comment write was not started.`,
        "rejected",
      );
    }
    throw error;
  }
  const envelope = runResult.value;
  let identity: LoopIdentity;
  try {
    identity = identityFromEnvelope(envelope, credentials.proof);
  } catch (error) {
    if (!isLoopCommentMutation(args)) throw error;
    const operation = args[3] === "create" ? "create" : "update";
    const result = { data: envelope.data };
    if (runResult.cleanupFailed) {
      throw new LoopMutationConfirmedCleanupError(
        operation,
        runResult.cleanupError,
        result,
        errorText(error),
      );
    }
    throw new LoopMutationConfirmedResponseError(
      operation,
      `Loop comment ${operation} was confirmed by octo-cli, but its response identity could not be validated: ${errorText(error)}`,
      result,
      error,
    );
  }
  if (runResult.cleanupFailed && !isLoopCommentMutation(args)) {
    throw new Error(
      `The Octo Loop operation completed, but its private credential snapshot could not be removed: ${errorText(runResult.cleanupError)}`,
      { cause: runResult.cleanupError },
    );
  }
  return {
    envelope,
    identity,
    ...(runResult.cleanupFailed
      ? { cleanupError: runResult.cleanupError, cleanupFailed: true }
      : {}),
  };
}

function requirePagination(value: unknown, requestedPage: number): LoopPagination {
  const pagination = requireRecord(value, "Loop pagination");
  const page = pagination.page;
  const pageSize = pagination.page_size;
  const total = pagination.total;
  if (typeof page !== "number" || !Number.isInteger(page) || page !== requestedPage || page < 1) {
    throw new Error("octo-cli returned invalid Loop pagination page");
  }
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("octo-cli returned invalid Loop pagination page_size");
  }
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) {
    throw new Error("octo-cli returned invalid Loop pagination total");
  }
  return Object.freeze({ page, page_size: pageSize, total });
}

async function readAllPages<T>(
  command: (page: number) => string[],
  parse: (value: unknown) => T,
  keyOf: (value: T) => string,
  signal?: AbortSignal,
  totalCap?: number,
  snapshot?: LoopCredentialSnapshot,
): Promise<LoopRead<readonly T[]>> {
  const credentials = snapshot ?? await captureCredentialSnapshot(signal);
  const values: T[] = [];
  const seen = new Set<string>();
  let identity: LoopIdentity | undefined;
  let firstPagination: LoopPagination | undefined;
  let finalPagination: LoopPagination | undefined;
  for (let page = 1; ; page += 1) {
    const { envelope, identity: pageIdentity } = await runLoopCli(command(page), undefined, signal, credentials);
    if (!Array.isArray(envelope.data)) throw new Error("octo-cli returned invalid Loop page data");
    const pagination = requirePagination(envelope._pagination, page);
    if (
      firstPagination &&
      (pagination.page_size !== firstPagination.page_size || pagination.total !== firstPagination.total)
    ) {
      throw new Error("Octo Loop pagination changed while reading; no complete list can be confirmed.");
    }
    firstPagination ??= pagination;
    const expectedPageLength = Math.min(
      pagination.page_size,
      Math.max(0, pagination.total - (page - 1) * pagination.page_size),
    );
    if (envelope.data.length !== expectedPageLength) {
      throw new Error(
        `octo-cli returned ${envelope.data.length} records for Loop page ${page}; expected ${expectedPageLength}, so a complete list cannot be confirmed.`,
      );
    }
    if (identity && !sameLoopIdentity(identity, pageIdentity)) {
      throw new Error("The Octo Loop identity changed during pagination; no partial list was returned.");
    }
    if (totalCap !== undefined && pagination.total >= totalCap) {
      throw new Error(
        `Octo Loop comment pagination reached the CLI's ${totalCap}-record limit; truncation is possible and a complete list cannot be confirmed.`,
      );
    }
    if (pagination.total === 0 && envelope.data.length > 0) {
      throw new Error("octo-cli returned Loop page data with a zero pagination total");
    }
    identity ??= pageIdentity;
    finalPagination = pagination;
    for (const item of envelope.data) {
      const value = parse(item);
      const key = keyOf(value);
      if (seen.has(key)) throw new Error(`octo-cli returned duplicate Loop record ${key}`);
      seen.add(key);
      values.push(value);
    }
    if (values.length > pagination.total) {
      throw new Error("octo-cli returned more Loop records than its pagination total");
    }

    const pageCount = pagination.total === 0 ? 1 : Math.ceil(pagination.total / pagination.page_size);
    if (page >= pageCount) break;
  }
  if (!identity || !finalPagination) throw new Error("octo-cli returned no Loop pages");
  if (values.length !== finalPagination.total) {
    throw new Error(
      `Octo Loop pagination returned ${values.length} records but declared ${finalPagination.total}; a complete list cannot be confirmed.`,
    );
  }
  return {
    data: deepFreeze(values),
    identity,
    _pagination: finalPagination,
  };
}

function parseTask(value: unknown, expectedWorkspaceId?: string): Readonly<JsonRecord> {
  const task = requireRecord(value, "Loop task");
  const taskId = requireUuid(task.task_id, "Loop task_id");
  if (expectedWorkspaceId && task.workspace_id !== undefined) {
    const workspaceId = requireUuid(task.workspace_id, "Loop task workspace_id");
    if (workspaceId !== expectedWorkspaceId) {
      throw new Error(`octo-cli returned Loop task ${taskId} from a different workspace`);
    }
  }
  return deepFreeze(task);
}

function parseWorkspace(value: unknown): Readonly<JsonRecord> {
  const workspace = requireRecord(value, "Loop workspace");
  requireUuid(workspace.workspace_id, "Loop workspace_id");
  return deepFreeze(workspace);
}

function parseComment(value: unknown, taskId: string): LoopComment {
  const comment = requireRecord(value, "Loop comment");
  requireUuid(comment.comment_id, "Loop comment_id");
  const responseTaskId = requireUuid(comment.task_id, "Loop comment task_id");
  if (responseTaskId !== taskId) throw new Error("octo-cli returned a comment belonging to a different task");
  if (comment.parent_id !== null) requireUuid(comment.parent_id, "Loop comment parent_id");
  requireString(comment.content, "Loop comment content");
  if (!Array.isArray(comment.attachments)) throw new Error("octo-cli returned invalid Loop comment attachments");
  for (const attachmentValue of comment.attachments) {
    const attachment = requireRecord(attachmentValue, "Loop comment attachment");
    requireUuid(attachment.id, "Loop comment attachment id");
  }
  return deepFreeze(comment) as LoopComment;
}

export async function readLoopWorkspaces(signal?: AbortSignal): Promise<LoopRead<readonly Readonly<JsonRecord>[]>> {
  return readAllPages(
    (page) => ["loop", "workspace", "list", "--page", String(page), "--page-size", String(PAGE_SIZE)],
    parseWorkspace,
    (workspace) => requireUuid(workspace.workspace_id, "Loop workspace_id"),
    signal,
  );
}

export async function readLoopTasks(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<LoopRead<readonly Readonly<JsonRecord>[]>> {
  const selectedWorkspaceId = requireUuid(workspaceId, "workspace id");
  return readAllPages(
    (page) => [
      "loop", "task", "list", "--workspace-id", selectedWorkspaceId,
      "--page", String(page), "--page-size", String(PAGE_SIZE),
    ],
    (value) => parseTask(value, selectedWorkspaceId),
    (task) => requireUuid(task.task_id, "Loop task_id"),
    signal,
  );
}

export async function readLoopTask(
  workspaceId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<LoopRead<Readonly<JsonRecord>>> {
  const selectedWorkspaceId = requireUuid(workspaceId, "workspace id");
  const selectedTaskId = requireUuid(taskId, "task id");
  const { envelope, identity } = await runLoopCli([
    "loop", "task", "get", selectedTaskId, "--workspace-id", selectedWorkspaceId,
  ], undefined, signal);
  const task = parseTask(envelope.data, selectedWorkspaceId);
  if (requireUuid(task.task_id, "Loop task_id") !== selectedTaskId) {
    throw new Error("octo-cli returned a different Loop task than requested");
  }
  return { data: task, identity };
}
async function readLoopCommentsWithSnapshot(
  workspaceId: string,
  taskId: string,
  signal?: AbortSignal,
  snapshot?: LoopCredentialSnapshot,
): Promise<LoopRead<readonly LoopComment[]>> {
  const selectedWorkspaceId = requireUuid(workspaceId, "workspace id");
  const selectedTaskId = requireUuid(taskId, "task id");
  return readAllPages(
    (page) => [
      "loop", "task", "comment", "list", selectedTaskId, "--workspace-id", selectedWorkspaceId,
      "--page", String(page), "--page-size", String(PAGE_SIZE),
    ],
    (value) => parseComment(value, selectedTaskId),
    (comment) => requireUuid(comment.comment_id, "Loop comment_id"),
    signal,
    MAX_COMMENT_RECORDS,
    snapshot,
  );
}

export function readLoopComments(
  workspaceId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<LoopRead<readonly LoopComment[]>> {
  return readLoopCommentsWithSnapshot(workspaceId, taskId, signal);
}

async function readLoopCommentWithSnapshot(
  workspaceId: string,
  taskId: string,
  commentId: string,
  signal?: AbortSignal,
  snapshot?: LoopCredentialSnapshot,
): Promise<LoopCommentSnapshot> {
  const selectedWorkspaceId = requireUuid(workspaceId, "workspace id");
  const selectedTaskId = requireUuid(taskId, "task id");
  const selectedCommentId = requireUuid(commentId, "comment id");
  const comments = await readLoopCommentsWithSnapshot(
    selectedWorkspaceId,
    selectedTaskId,
    signal,
    snapshot,
  );
  let match: LoopComment | undefined;
  for (const comment of comments.data) {
    if (requireUuid(comment.comment_id, "Loop comment_id") !== selectedCommentId) continue;
    if (match) throw new Error(`Loop comment ${selectedCommentId} appeared more than once in task ${selectedTaskId}`);
    match = comment;
  }
  if (!match) throw new Error(`Loop comment ${selectedCommentId} was not found in task ${selectedTaskId}`);
  return deepFreeze({
    workspaceId: selectedWorkspaceId,
    taskId: selectedTaskId,
    commentId: selectedCommentId,
    identity: comments.identity,
    comment: match,
  }) as LoopCommentSnapshot;
}

export function readLoopComment(
  workspaceId: string,
  taskId: string,
  commentId: string,
  signal?: AbortSignal,
): Promise<LoopCommentSnapshot> {
  return readLoopCommentWithSnapshot(workspaceId, taskId, commentId, signal);
}

export async function currentLoopIdentity(signal?: AbortSignal): Promise<LoopIdentity> {
  const { identity } = await runLoopCli([
    "loop", "workspace", "list", "--page", "1", "--page-size", "1",
  ], undefined, signal);
  return identity;
}

function normalizeCreateInput(input: LoopCommentInput): NormalizedLoopCommentInput {
  const workspaceId = requireUuid(input.workspaceId, "workspace id");
  const taskId = requireUuid(input.taskId, "task id");
  if (typeof input.content !== "string" || input.content.trim().length === 0) {
    throw new Error("Loop comment content must be a non-empty string");
  }
  const parentCommentId = input.parentCommentId === undefined
    ? undefined
    : requireUuid(input.parentCommentId, "parent comment id");
  if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) {
    throw new Error("Loop comment attachment_ids must be an array");
  }
  if (input.suppressExpertIds !== undefined && !Array.isArray(input.suppressExpertIds)) {
    throw new Error("Loop comment suppress_expert_ids must be an array");
  }
  const attachmentIds = (input.attachmentIds ?? []).map((id) => requireUuid(id, "attachment id"));
  const suppressExpertIds = (input.suppressExpertIds ?? []).map((id) =>
    requireUuid(id, "suppressed expert id")
  );
  return deepFreeze({
    workspaceId,
    taskId,
    ...(parentCommentId ? { parentCommentId } : {}),
    content: input.content,
    attachmentIds,
    suppressExpertIds,
  });
}

function normalizePreviewInput(input: LoopCommentPreviewInput): LoopCommentPreviewInput {
  const workspaceId = requireUuid(input.workspaceId, "workspace id");
  const taskId = requireUuid(input.taskId, "task id");
  if (typeof input.content !== "string") throw new Error("Loop comment content must be a string");
  const parentCommentId = input.parentCommentId === undefined
    ? undefined
    : requireUuid(input.parentCommentId, "parent comment id");
  const editingCommentId = input.editingCommentId === undefined
    ? undefined
    : requireUuid(input.editingCommentId, "editing comment id");
  if (parentCommentId && editingCommentId) {
    throw new Error("A Loop comment preview cannot be both a reply and an update");
  }
  if (editingCommentId && (input.attachmentIds !== undefined || input.suppressExpertIds !== undefined)) {
    throw new Error("Loop comment update previews cannot change attachments or expert suppressions");
  }
  if (!editingCommentId && input.content.trim().length === 0) {
    throw new Error("Loop comment content must be a non-empty string");
  }
  if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) {
    throw new Error("Loop comment preview attachment_ids must be an array");
  }
  if (input.suppressExpertIds !== undefined && !Array.isArray(input.suppressExpertIds)) {
    throw new Error("Loop comment preview suppress_expert_ids must be an array");
  }
  const attachmentIds = input.attachmentIds === undefined
    ? editingCommentId ? undefined : []
    : input.attachmentIds.map((id) => requireUuid(id, "attachment id"));
  const suppressExpertIds = input.suppressExpertIds === undefined
    ? editingCommentId ? undefined : []
    : input.suppressExpertIds.map((id) => requireUuid(id, "suppressed expert id"));
  return deepFreeze({
    workspaceId,
    taskId,
    content: input.content,
    ...(parentCommentId ? { parentCommentId } : {}),
    ...(editingCommentId ? { editingCommentId } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds } : {}),
    ...(suppressExpertIds !== undefined ? { suppressExpertIds } : {}),
  });
}


function previewBody(input: LoopCommentPreviewInput): JsonRecord {
  return {
    content: input.content,
    ...(input.parentCommentId ? { parent_comment_id: input.parentCommentId } : {}),
    ...(input.editingCommentId ? { editing_comment_id: input.editingCommentId } : {}),
    ...(input.attachmentIds ? { attachment_ids: input.attachmentIds } : {}),
    ...(input.suppressExpertIds ? { suppress_expert_ids: input.suppressExpertIds } : {}),
  };
}

function parsePreviewExperts(value: unknown): readonly LoopPreviewExpert[] {
  const data = requireRecord(value, "Loop comment preview data");
  if (!Array.isArray(data.experts)) throw new Error("octo-cli returned Loop comment preview without an experts array");
  const experts = data.experts.map((expertValue) => {
    const expert = requireRecord(expertValue, "Loop comment preview expert");
    return deepFreeze({
      ...expert,
      expert_id: requireIdentifier(expert.expert_id, "preview expert_id"),
      name: requireString(expert.name, "preview expert name"),
      source: requireString(expert.source, "preview expert source"),
      reason: requireString(expert.reason, "preview expert reason"),
    }) as LoopPreviewExpert;
  });
  return deepFreeze(experts);
}

function mutationUnknown(
  operation: "create" | "update",
  error: unknown,
  message: string,
): Error {
  if (
    error instanceof LoopMutationOutcomeUnknownError ||
    error instanceof LoopMutationConfirmedResponseError
  ) {
    return error;
  }
  if (error instanceof OctoCliError && error.certainty === "rejected") return error;
  const diagnostics = error instanceof Error ? error.message : String(error);
  return new LoopMutationOutcomeUnknownError(
    operation,
    `${message}: ${diagnostics}; re-read the Loop resource to verify its current state. Do not retry automatically.`,
    error,
  );
}


export async function createLoopComment(
  preview: LoopCommentPreview,
  signal?: AbortSignal,
): Promise<LoopRead<unknown>> {
  if (!verifiedPreviews.delete(preview)) throw new Error("The Loop comment preview is not a verified preview result");
  if (preview.input.editingCommentId) throw new Error("An update preview cannot be used to create a comment");
  const credentialSnapshot = credentialSnapshots.get(preview);
  credentialSnapshots.delete(preview);
  if (!credentialSnapshot) throw new Error("The Loop comment preview has no pinned CLI credentials");
  const input = normalizeCreateInput(preview.input);
  if (preview.input.workspaceId !== input.workspaceId || preview.input.taskId !== input.taskId) {
    throw new Error("The Loop comment preview scope changed before creation");
  }
  await assertCurrentCredentialSnapshot(credentialSnapshot, signal);
  try {
    const { envelope, identity, cleanupError, cleanupFailed } = await runLoopCli([
      "loop", "task", "comment", "create", input.taskId,
      "--workspace-id", input.workspaceId,
      "--data", "@-",
    ], JSON.stringify({
      content: input.content,
      ...(input.parentCommentId ? { parent_comment_id: input.parentCommentId } : {}),
      attachment_ids: input.attachmentIds,
      suppress_expert_ids: input.suppressExpertIds,
    }), signal, credentialSnapshot);
    if (!sameLoopIdentity(identity, preview.identity)) {
      const cleanupDiagnostics = cleanupFailed
        ? ` Temporary credential snapshot cleanup also failed: ${errorText(cleanupError)}`
        : "";
      throw new LoopMutationOutcomeUnknownError(
        "create",
        `Loop comment creation outcome is unknown because the pinned CLI identity changed after preview; re-read the task before retrying.${cleanupDiagnostics}`,
      );
    }
    const result = { data: envelope.data, identity };
    if (cleanupFailed) throw new LoopMutationConfirmedCleanupError("create", cleanupError, result);
    return result;
  } catch (error) {
    throw mutationUnknown("create", error, "Loop comment creation outcome is unknown");
  }
}

export async function updateLoopComment(
  snapshot: LoopCommentSnapshot,
  content: string,
  preview: LoopCommentPreview,
  signal?: AbortSignal,
): Promise<LoopCommentSnapshot> {
  if (!verifiedPreviews.delete(preview)) throw new Error("The Loop comment preview is not a verified preview result");
  const credentialSnapshot = credentialSnapshots.get(preview);
  credentialSnapshots.delete(preview);
  if (!credentialSnapshot) throw new Error("The Loop comment preview has no pinned CLI credentials");
  const workspaceId = requireUuid(snapshot.workspaceId, "workspace id");
  const taskId = requireUuid(snapshot.taskId, "task id");
  const commentId = requireUuid(snapshot.commentId, "comment id");
  if (
    requireUuid(snapshot.comment.comment_id, "Loop comment_id") !== commentId ||
    requireUuid(snapshot.comment.task_id, "Loop comment task_id") !== taskId
  ) {
    throw new Error("The Loop comment snapshot does not match its comment and task identifiers");
  }
  if (typeof content !== "string") throw new Error("Loop comment content must be a string");
  if (
    preview.input.workspaceId !== workspaceId ||
    preview.input.taskId !== taskId ||
    preview.input.editingCommentId !== commentId ||
    preview.input.content !== content ||
    preview.input.attachmentIds !== undefined ||
    preview.input.suppressExpertIds !== undefined ||
    !sameLoopIdentity(preview.identity, snapshot.identity)
  ) {
    throw new Error("The Loop comment preview does not match this comment snapshot and replacement content");
  }
  await assertCurrentCredentialSnapshot(credentialSnapshot, signal);
  const current = await readLoopCommentWithSnapshot(
    workspaceId,
    taskId,
    commentId,
    signal,
    credentialSnapshot,
  );
  if (!sameLoopIdentity(current.identity, snapshot.identity)) {
    throw new Error("The Octo Loop identity changed since this comment was read; re-read before writing");
  }
  if (current.comment.content !== snapshot.comment.content) {
    throw new Error("The Loop comment changed since it was read; re-read the latest comment before writing");
  }
  await assertCurrentCredentialSnapshot(credentialSnapshot, signal);
  if (content === current.comment.content) return current;
  await assertCurrentCredentialSnapshot(credentialSnapshot, signal);

  try {
    const { identity, cleanupError, cleanupFailed } = await runLoopCli([
      "loop", "comment", "update", commentId,
      "--workspace-id", workspaceId,
      "--data", "@-",
    ], JSON.stringify({ content }), signal, credentialSnapshot);
    if (!sameLoopIdentity(identity, snapshot.identity)) {
      const cleanupDiagnostics = cleanupFailed
        ? ` Temporary credential snapshot cleanup also failed: ${errorText(cleanupError)}`
        : "";
      throw new LoopMutationOutcomeUnknownError(
        "update",
        `Loop comment update outcome is unknown because the pinned CLI identity changed after preview; re-read the comment before retrying.${cleanupDiagnostics}`,
      );
    }
    const result = {
      workspaceId,
      taskId,
      commentId,
      identity,
      comment: deepFreeze({ ...current.comment, content }) as LoopComment,
    };
    if (cleanupFailed) throw new LoopMutationConfirmedCleanupError("update", cleanupError, result);
    return result;
  } catch (error) {
    throw mutationUnknown("update", error, "Loop comment update outcome is unknown");
  }
}

export async function previewLoopComment(
  input: LoopCommentPreviewInput,
  expectedIdentity?: LoopIdentity,
  signal?: AbortSignal,
): Promise<LoopCommentPreview> {
  const normalized = normalizePreviewInput(input);
  const credentialSnapshot = await captureCredentialSnapshot(signal);
  let parentIdentity: LoopIdentity | undefined;
  if (normalized.parentCommentId) {
    const parent = await readLoopCommentWithSnapshot(
      normalized.workspaceId,
      normalized.taskId,
      normalized.parentCommentId,
      signal,
      credentialSnapshot,
    );
    assertExpectedIdentity(parent.identity, expectedIdentity);
    parentIdentity = parent.identity;
  }
  const { envelope, identity } = await runLoopCli([
    "loop", "task", "comment", "preview", normalized.taskId,
    "--workspace-id", normalized.workspaceId,
    "--data", "@-",
  ], JSON.stringify(previewBody(normalized)), signal, credentialSnapshot);
  assertExpectedIdentity(identity, expectedIdentity);
  if (parentIdentity && !sameLoopIdentity(identity, parentIdentity)) {
    throw new Error("The Octo Loop identity changed between reply target read and preview");
  }
  if (credentialProofs.get(identity) !== credentialSnapshot.proof) {
    throw new Error("The Octo Loop credentials changed while previewing the comment");
  }
  const experts = parsePreviewExperts(envelope.data);
  const preview = deepFreeze({ input: normalized, identity, experts });
  verifiedPreviews.add(preview);
  credentialSnapshots.set(preview, credentialSnapshot);
  return preview;

}
