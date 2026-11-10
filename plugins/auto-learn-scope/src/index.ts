import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractUriScheme, InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseReadUrlTarget } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { splitDelimitedPathEntry, splitMixedUrlPathList } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
  createManagedGroupStore,
  type ManagedGroupIndexResult,
  type ManagedGroupStore,
  type ManagedGroupSummaryWork,
} from "./managed-groups";
import { runManagedGroupSummaryWork, type ManagedGroupSummaryOutcome } from "./model-summary";
import { createProjectSkillWriter, type ProjectSkillWriter } from "./project-skills";

type UnknownRecord = Record<string, unknown>;

type Schema = unknown;

type ZodLikeSchema = {
  optional?: () => Schema;
  describe?: (text: string) => Schema;
  refine?: (check: (value: unknown) => boolean, message?: string) => Schema;
};

type ZodLike = {
  object: (shape: UnknownRecord) => Schema;
  enum: (values: readonly [string, ...string[]]) => Schema;
  string: () => Schema;
  optional?: (schema: Schema) => Schema;
};

type InvokeOptions = {
  signal?: unknown;
  onUpdate?: unknown;
};

type NativeInvoker = (params: UnknownRecord, options?: InvokeOptions) => Promise<unknown>;

type ToolHandler = (event: UnknownRecord, ctx: UnknownRecord) => unknown | Promise<unknown>;

type CommandHandler = (args: string, ctx: UnknownRecord) => Promise<void>;

type ToolApprovalTier = "read" | "write" | "exec";

type ToolApproval = ToolApprovalTier | ((params: unknown) => ToolApprovalTier);

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  defaultInactive?: boolean;
  loadMode?: string;
  approval?: ToolApproval;
  strict?: boolean;
  summary?: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<unknown>;
};

type HostPiNamespace = {
  settings?: {
    get?: (key: string) => unknown;
    rawValue?: (setting: unknown) => unknown;
  };
  getAgentDir?: () => string;
  AgentRegistry?: unknown;
};

type HostPi = {
  pi?: HostPiNamespace;
  zod: ZodLike;
  registerTool: (definition: ToolDefinition) => void;
  registerCommand: (name: string, definition: { description: string; handler: CommandHandler }) => void;
  sendMessage: (
    message: { customType: string; content: string; display: true },
    options?: { triggerTurn?: boolean },
  ) => void;
  on: (event: string, handler: ToolHandler) => void;
};

export type AutoLearnScopeOptions = {
  /** Isolated managed-skills root for tests and embedding callers. */
  managedRoot?: string;
  /** Supply a writer in tests instead of touching the repository. */
  writer?: ProjectSkillWriter;
  /** Alias accepted for callers that name the dependency explicitly. */
  projectSkillWriter?: ProjectSkillWriter;
  /** Optional factory hook for tests; the production default is createProjectSkillWriter(). */
  createProjectSkillWriter?: () => ProjectSkillWriter;
};

type Scope = "global" | "project";
type SkillAction = "create" | "update";
type ManageAction = SkillAction | "delete";

type LearnSkill = {
  group?: string;
  action: SkillAction;
  name: string;
  description: string;
  body: string;
};

type ManageParams = {
  group?: string;
  action: ManageAction;
  name: string;
  description?: string;
  body?: string;
};
type ManagedIndexResult = ManagedGroupIndexResult;

type ManagedRootPaths = { root: string; requested: string };

type ManagedGroupRead = { group: string; targetPath: string; directory: boolean };


const SCOPE_VALUES = ["global", "project"] as const;
const LEARN_ACTION_VALUES = ["create", "update"] as const;
const MANAGE_ACTION_VALUES = ["create", "update", "delete"] as const;
const NATIVE_MEMORY_BACKENDS = ["hindsight", "mnemopi", "local"] as const;
const MANAGED_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;


const PUBLIC_SETTING_UNAVAILABLE = Symbol("public setting unavailable");

type PublicSettingsAccessor = {
  kind: "missing" | "available" | "unavailable";
  get: (key: string) => unknown;
};

function publicSettingsAccessor(pi: HostPi): PublicSettingsAccessor {
  try {
    const namespace = pi.pi;
    if (namespace === undefined || namespace === null) {
      return { kind: "missing", get: () => PUBLIC_SETTING_UNAVAILABLE };
    }

    const settings = namespace.settings;
    if (settings === undefined || settings === null) {
      return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
    }
    return settingsAccessor(settings) ?? {
      kind: "unavailable",
      get: () => PUBLIC_SETTING_UNAVAILABLE,
    };
  } catch {
    return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
  }
}

function settingsAccessor(settings: unknown): PublicSettingsAccessor | undefined {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  try {
    const rawValue = (settings as UnknownRecord).rawValue;
    if (typeof rawValue === "function") {
      return {
        kind: "available",
        get(key: string): unknown {
          try {
            return rawValue.call(settings, {
              id: key,
              segments: key.split("."),
              definition: {},
            });
          } catch {
            return PUBLIC_SETTING_UNAVAILABLE;
          }
        },
      };
    }
    const getter = (settings as UnknownRecord).get;
    if (typeof getter !== "function") return undefined;
    return {
      kind: "available",
      get(key: string): unknown {
        try {
          return getter.call(settings, key);
        } catch {
          return PUBLIC_SETTING_UNAVAILABLE;
        }
      },
    };
  } catch {
    return undefined;
  }
}

function contextSettingsAccessor(ctx: unknown): PublicSettingsAccessor | undefined {
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  try {
    const settings = (ctx as UnknownRecord).settings;
    if (settings === undefined || settings === null) return undefined;
    return settingsAccessor(settings) ?? {
      kind: "unavailable",
      get: () => PUBLIC_SETTING_UNAVAILABLE,
    };
  } catch {
    return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
  }
}


function autoLearnEnabled(settings: PublicSettingsAccessor): boolean {
  return settings.get("autolearn.enabled") === true;
}

function assertAutoLearnEnabled(
  factorySettings: PublicSettingsAccessor,
  ctx: unknown,
  toolName: string,
): void {
  const settings = contextSettingsAccessor(ctx) ?? factorySettings;
  const enabled = settings.get("autolearn.enabled");
  if (enabled === true) return;
  if (enabled === false) {
    throw new Error(`Auto-learn is disabled; refusing to execute ${toolName}.`);
  }
  throw new Error(`Auto-learn setting is unavailable; refusing to execute ${toolName}.`);
}

const LEARN_DESCRIPTION = [
  "Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.",
  "Use after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.",
  "`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact.",
  "For a global skill, `skill.group` is required; use a slash-separated path such as `engineering/database/postgresql` to reuse existing groups or create missing levels.",
  "Managed skills live under the OMP agent directory's `managed-skills` folder; never touch user-authored skills.",
  "Frontmatter: generated from `name` and `description`.",
  "Capture sparingly, specifically: one strong reusable lesson > several vague ones.",
  'Scope defaults to "global"; use `scope: "project"` only when the skill should be saved in this repository.',
  "Memory-only learn calls do not need a group.",
].join(" ");
const MANAGE_DESCRIPTION = [
  "Global managed skills are stored as child SKILL.md files under a required `group`; surfaced as group skills in future sessions.",
  "Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.",
  "User-authored skills separate; tool NEVER edits them.",
  '`action: "create"` — fails if skill exists; `action: "update"` — overwrites body; fails if skill absent; `action: "delete"` — fails if skill absent.',
  "`group` is required for global scope and accepts slash-separated kebab-case path segments; `name` is kebab-case.",
  "`description`: specific; drives discovery.",
  "No frontmatter in `body`; generated from `name` and `description`.",
  'Scope defaults to "global"; `scope: "project"` writes the isolated project skill under this repository instead, without a group.',
].join(" ");
const GUIDANCE =
  "Auto-learn guidance: scope defaults to global. Use native memory/learn for durable facts or conventions; use a procedure/skill only when it is reusable. Global skills require an explicit group path such as engineering/database/postgresql: choose the existing group that best fits or name a new nested path. Memory-only learn calls need no group. Choose scope=project only when a skill should be saved in this repository, check whether an existing skill already covers it, and never put secrets or tokens in a skill.";

function asRecord(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} parameters must be an object.`);
  }
  return value as UnknownRecord;
}

function describeSchema(schema: Schema, text: string): Schema {
  if (
    (schema !== null && typeof schema === "object") ||
    typeof schema === "function"
  ) {
    const candidate = schema as ZodLikeSchema;
    if (typeof candidate.describe === "function") return candidate.describe(text);
  }
  return schema;
}

function optionalSchema(z: ZodLike, schema: Schema): Schema {
  if (
    (schema !== null && typeof schema === "object") ||
    typeof schema === "function"
  ) {
    const candidate = schema as ZodLikeSchema;
    if (typeof candidate.optional === "function") return candidate.optional();
  }
  if (typeof z.optional === "function") return z.optional(schema);
  throw new Error("The host zod implementation does not support optional fields.");
}


function omit(record: UnknownRecord, ...keys: string[]): UnknownRecord {
  const result = { ...record };
  for (const key of keys) delete result[key];
  return result;
}

function validateScope(params: UnknownRecord): Scope {
  const scope = params.scope;
  if (scope === undefined || scope === "global") return "global";
  if (scope === "project") return "project";
  throw new Error(`Invalid scope ${JSON.stringify(scope)}; expected "global" or "project".`);
}

function validateLearnParams(params: UnknownRecord): LearnSkill | undefined {
  if (typeof params.memory !== "string") {
    throw new Error('learn requires a string "memory".');
  }
  if (params.context !== undefined && typeof params.context !== "string") {
    throw new Error('learn "context" must be a string when provided.');
  }
  if (params.skill === undefined) return undefined;

  const skill = asRecord(params.skill, "learn skill");
  if (skill.action !== "create" && skill.action !== "update") {
    throw new Error('learn skill "action" must be "create" or "update".');
  }
  if (typeof skill.name !== "string") throw new Error('learn skill requires a string "name".');
  if (typeof skill.description !== "string") {
    throw new Error('learn skill requires a string "description".');
  }
  if (typeof skill.body !== "string") throw new Error('learn skill requires a string "body".');
  if (skill.group !== undefined && typeof skill.group !== "string") {
    throw new Error('learn skill "group" must be a string when provided.');
  }
  return {
    group: typeof skill.group === "string" ? skill.group : undefined,
    action: skill.action,
    name: skill.name,
    description: skill.description,
    body: skill.body,
  };
}

function validateManageParams(params: UnknownRecord): ManageParams {
  const action = params.action;
  if (action !== "create" && action !== "update" && action !== "delete") {
    throw new Error('manage_skill "action" must be "create", "update", or "delete".');
  }
  if (typeof params.name !== "string") throw new Error('manage_skill requires a string "name".');
  if (params.group !== undefined && typeof params.group !== "string") {
    throw new Error('manage_skill "group" must be a string when provided.');
  }
  if (action !== "delete") {
    if (typeof params.description !== "string" || typeof params.body !== "string") {
      throw new Error(`manage_skill "${action}" requires both "description" and "body".`);
    }
  }
  return {
    group: typeof params.group === "string" ? params.group : undefined,
    action,
    name: params.name,
    description: typeof params.description === "string" ? params.description : undefined,
    body: typeof params.body === "string" ? params.body : undefined,
  };
}

function requireNative(ctx: unknown, toolName: string): NativeInvoker {
  const context = asRecord(ctx, "tool context");
  if (typeof context.invokeTool !== "function") {
    throw new Error(`Native ${toolName} capability is unavailable; refusing to bypass it.`);
  }
  return context.invokeTool as NativeInvoker;
}

function contextCwd(ctx: unknown): string {
  const context = asRecord(ctx, "tool context");
  return typeof context.cwd === "string" ? context.cwd : "";
}

function findRepositoryRoot(cwd: string): string | undefined {
  if (!cwd) return undefined;
  let directory = resolve(cwd);
  for (;;) {
    try {
      statSync(join(directory, ".git"));
      return directory;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
}

function normalisedSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function isManagedName(value: unknown): boolean {
  return typeof value === "string" && MANAGED_NAME_PATTERN.test(normalisedSkillName(value));
}
function isManagedGroup(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const group = normalisedSkillName(value);
  if (group.includes("\\")) return false;
  const segments = group.split("/");
  return segments.length > 0 && segments.every(segment => MANAGED_NAME_PATTERN.test(segment));
}

function requireManagedGroup(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  const group = normalisedSkillName(value);
  if (!isManagedGroup(group)) {
    throw new Error(
      `Invalid ${label} "${value}"; use slash-separated lowercase letters, digits, and hyphens (1-64 characters per segment).`,
    );
  }
  return group;
}

function topManagedGroup(group: string): string {
  return group.slice(0, group.indexOf("/") < 0 ? group.length : group.indexOf("/"));
}

function rememberManagedGroupPath(knownGroups: Set<string>, group: string): void {
  const segments = group.split("/");
  for (let count = 1; count <= segments.length; count++) {
    knownGroups.add(segments.slice(0, count).join("/"));
  }
}

function requireManagedName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  const name = normalisedSkillName(value);
  if (!MANAGED_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ${label} "${value}"; use lowercase letters, digits, and hyphens (1-64 characters).`);
  }
  return name;
}

function skillPathHint(cwd: string, name: string): string {
  const root = findRepositoryRoot(cwd) ?? (cwd ? resolve(cwd) : resolve("."));
  return join(root, ".omp", "skills", normalisedSkillName(name), "SKILL.md");
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function errorPath(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const path = (error as UnknownRecord).path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return undefined;
}

function errorStringField(error: unknown, key: string): string | undefined {
  if (error !== null && typeof error === "object") {
    const value = (error as UnknownRecord)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function contentOf(result: unknown): unknown[] {
  if (result !== null && typeof result === "object") {
    const content = (result as UnknownRecord).content;
    if (Array.isArray(content)) return [...content];
  }
  return [];
}

function detailsOf(result: unknown): UnknownRecord {
  if (result !== null && typeof result === "object") {
    const details = (result as UnknownRecord).details;
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      return { ...(details as UnknownRecord) };
    }
  }
  return {};
}

function textContent(text: string): UnknownRecord {
  return { type: "text", text };
}

function combineProjectSkillResult(
  memoryResult: unknown,
  skill: LearnSkill,
  path: string,
  writerResult: unknown,
): UnknownRecord {
  const projectSkill = {
    action: skill.action,
    name: skill.name,
    path,
    result: writerResult,
  };
  return {
    ...(memoryResult !== null && typeof memoryResult === "object" ? (memoryResult as UnknownRecord) : {}),
    memory: memoryResult,
    skill: projectSkill,
    content: [
      ...contentOf(memoryResult),
      textContent(`Saved project skill "${skill.name}" at ${path}.`),
    ],
    details: {
      ...detailsOf(memoryResult),
      memory: memoryResult,
      skill: projectSkill,
    },
  };
}

function partialProjectSkillResult(
  memoryResult: unknown,
  skill: LearnSkill,
  path: string,
  reason: string,
): UnknownRecord {
  const projectSkill = { action: skill.action, name: skill.name, path };
  return {
    ...(memoryResult !== null && typeof memoryResult === "object" ? (memoryResult as UnknownRecord) : {}),
    memory: memoryResult,
    skill: projectSkill,
    reason,
    isError: true,
    content: [
      ...contentOf(memoryResult),
      textContent(
        `Memory was saved, but the project skill "${skill.name}" could not be written at ${path}: ${reason}`,
      ),
    ],
    details: {
      ...detailsOf(memoryResult),
      memory: memoryResult,
      skill: projectSkill,
      reason,
      partial: true,
    },
  };
}

function projectWriterFrom(options?: AutoLearnScopeOptions): ProjectSkillWriter {
  if (options?.writer) return options.writer;
  if (options?.projectSkillWriter) return options.projectSkillWriter;
  if (options?.createProjectSkillWriter) return options.createProjectSkillWriter();
  return createProjectSkillWriter();
}

// Freeze symlinked ancestors too; append a missing suffix to the nearest existing real path.
function canonicalManagedRootPath(root: string): string {
  let current = resolve(root);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...suffix);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && typeof (error as UnknownRecord).code === "string"
          ? (error as UnknownRecord).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) {
          current = resolve(dirname(current), readlinkSync(current));
          continue;
        }
      } catch (linkError) {
        const linkCode =
          linkError !== null && typeof linkError === "object" && typeof (linkError as UnknownRecord).code === "string"
            ? (linkError as UnknownRecord).code
            : undefined;
        if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") throw linkError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(relative(parent, current));
      current = parent;
    }
  }
}


function managedRootFrom(pi: HostPi, options?: AutoLearnScopeOptions): ManagedRootPaths {
  let requested: string;
  if (options?.managedRoot !== undefined) {
    if (typeof options.managedRoot !== "string" || options.managedRoot.trim().length === 0) {
      throw new Error("managedRoot must be a non-empty path when provided.");
    }
    requested = resolve(options.managedRoot);
  } else {
    const namespace = pi.pi;
    if (!namespace || typeof namespace.getAgentDir !== "function") {
      throw new Error("OMP host does not expose pi.getAgentDir(); provide options.managedRoot explicitly.");
    }
    const agentDir = namespace.getAgentDir.call(namespace);
    if (typeof agentDir !== "string" || agentDir.trim().length === 0) {
      throw new Error("OMP host pi.getAgentDir() did not return an agent directory.");
    }
    requested = join(resolve(agentDir), "managed-skills");
  }
  return { root: canonicalManagedRootPath(requested), requested };
}

function pathWithinManagedRoot(roots: ManagedRootPaths, candidate: string): string | undefined {
  if (canonicalManagedRootPath(roots.requested) !== roots.root) {
    throw new Error("The managed-skills root symlink target changed after extension initialization.");
  }
  const canonicalCandidate = canonicalManagedRootPath(resolve(candidate));
  if (canonicalManagedRootPath(roots.requested) !== roots.root) {
    throw new Error("The managed-skills root symlink target changed after extension initialization.");
  }
  const rootRelative = relative(roots.root, canonicalCandidate);
  if (
    rootRelative === "" ||
    (rootRelative !== ".." && !rootRelative.startsWith(`..${sep}`) && !isAbsolute(rootRelative))
  ) {
    return canonicalCandidate;
  }
  return undefined;
}

function samePathTarget(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}


function rememberManagedGroups(
  root: string,
  groupStore: ManagedGroupStore,
  knownGroups: Set<string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error !== null && typeof error === "object" && (error as UnknownRecord).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isManagedName(entry.name)) continue;
    const group = normalisedSkillName(entry.name);
    if (entry.name === group && groupStore.isGroup(group)) knownGroups.add(group);
  }
}

function assertGroupNotShadowed(
  skills: unknown[] | undefined,
  roots: ManagedRootPaths,
  group: string,
  verifiedGroup: boolean,
): void {
  if (!skills) {
    throw new Error("OMP current-session skills are unavailable; cannot verify group-name conflicts.");
  }

  const candidate = skills.find(
    (entry): entry is UnknownRecord =>
      entry !== null && typeof entry === "object" && (entry as UnknownRecord).name === group,
  );
  if (!candidate) return;
  const groupIndex = resolve(roots.root, group, "SKILL.md");
  const activePath =
    typeof candidate.filePath === "string" && candidate.filePath.length > 0
      ? pathWithinManagedRoot(roots, candidate.filePath) ?? resolve(candidate.filePath)
      : undefined;
  if (verifiedGroup && activePath && samePathTarget(activePath, groupIndex)) return;
  throw new Error(
    `Cannot create managed skill group "${group}": active same-named skill conflict; OMP resolves its top-level skill name to "${
      typeof candidate.filePath === "string" ? candidate.filePath : "<missing file path>"
    }" instead of a verified managed group index.`,
  );
}

function nativeToolFailed(result: unknown): boolean {
  return (
    result instanceof Error ||
    (result !== null && typeof result === "object" && (result as UnknownRecord).isError === true)
  );
}

function storeStatus(error: unknown, key: "skillStatus" | "indexStatus"): string {
  if (error !== null && typeof error === "object") {
    const status = (error as UnknownRecord)[key];
    if (typeof status === "string" && status.length > 0) return status;
  }
  return "unknown";
}

function indexResultsFrom(value: unknown): ManagedIndexResult[] {
  if (value !== null && typeof value === "object" && Array.isArray((value as UnknownRecord).indexes)) {
    return (value as UnknownRecord).indexes as ManagedIndexResult[];
  }
  throw new Error("Managed group mutation error omitted its per-index results.");
}

function managedSkillOutcome(
  action: ManageAction,
  name: string,
  group: string,
  memorySaved: boolean,
  memoryResult: unknown,
  mutationPath: string | undefined,
  mutationIndexes: ManagedIndexResult[] | undefined,
  failed: boolean,
  error: unknown,
  summaryPending = false,
): UnknownRecord {
  const path = failed ? errorPath(error) : mutationPath;
  const skillPath = failed ? errorStringField(error, "skillPath") ?? path : path;
  const skillStatus = failed ? storeStatus(error, "skillStatus") : action === "delete" ? "deleted" : "written";
  const indexes = failed ? indexResultsFrom(error) : mutationIndexes;
  if (!indexes || indexes.length === 0) {
    throw new Error("Managed group mutation returned no per-index results.");
  }
  const primaryIndex = indexes[0];
  if (!primaryIndex) throw new Error("Managed group mutation returned an invalid per-index result list.");
  const indexStatus = failed ? storeStatus(error, "indexStatus") : primaryIndex.status;
  const indexPath = (failed ? errorStringField(error, "indexPath") : undefined) ?? primaryIndex.path;
  const reason = failed ? errorReason(error) : undefined;
  const skill = {
    action,
    name,
    group,
    status: skillStatus,
    ...(skillPath ? { path: skillPath } : {}),
  };
  const index = { status: indexStatus, path: indexPath };
  const indexSummary = indexes
    .map(
      item =>
        `${item.group}: ${item.status} at ${item.path}${item.needsRebuild ? " (needs rebuild)" : ""}${
          item.reason ? ` (${item.reason})` : ""
        }`,
    )
    .join("; ");
  const message = failed
    ? `${memorySaved ? "Memory was saved, but " : ""}managed skill "${name}" in group "${group}" failed (skillStatus=${skillStatus}, indexStatus=${indexStatus}${path ? `, path=${path}` : ""}): ${reason}; indexes: ${indexSummary}.`
    : `${memorySaved ? "Memory was saved and " : ""}${action === "delete" ? "deleted" : `${action}d`} managed skill "${name}" in group "${group}"${path ? ` at ${path}` : ""}; indexes: ${indexSummary}.${summaryPending ? " Summary update is queued; its completion is not implied by this result." : ""}`;
  return {
    ...(memorySaved && memoryResult !== null && typeof memoryResult === "object"
      ? (memoryResult as UnknownRecord)
      : {}),
    ...(memorySaved ? { memory: memoryResult, memoryStatus: "written" } : {}),
    skill,
    index,
    skillStatus,
    indexStatus,
    indexes,
    ...(path ? { path } : {}),
    ...(skillPath ? { skillPath } : {}),
    indexPath,
    ...(failed ? { reason, isError: true } : {}),
    ...(summaryPending ? { summaryStatus: "pending" } : {}),
    content: [
      ...(memorySaved ? contentOf(memoryResult) : []),
      textContent(message),
    ],
    details: {
      ...(memorySaved ? detailsOf(memoryResult) : {}),
      ...(memorySaved ? { memory: memoryResult, memoryStatus: "written" } : {}),
      skill,
      index,
      skillStatus,
      indexStatus,
      indexes,
      ...(path ? { path } : {}),
      ...(skillPath ? { skillPath } : {}),
      indexPath,
      ...(summaryPending ? { summaryStatus: "pending" } : {}),
      ...(failed ? { reason, partial: memorySaved } : {}),
    },
  };
}


// Match tool and background work to the registered live session before using session-local state.
function activeSessionFor(pi: HostPi, ctx: unknown): UnknownRecord | undefined {
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  const context = ctx as UnknownRecord;
  const agent = context.agent;
  const contextSessionManager = context.sessionManager;
  if (
    agent === null ||
    typeof agent !== "object" ||
    typeof (agent as UnknownRecord).id !== "string" ||
    contextSessionManager === null ||
    typeof contextSessionManager !== "object"
  ) {
    return undefined;
  }
  try {
    const agentId = (agent as UnknownRecord).id as string;
    const getContextSessionId = Reflect.get(contextSessionManager, "getSessionId");
    if (typeof getContextSessionId !== "function") return undefined;
    const contextSessionId = Reflect.apply(getContextSessionId, contextSessionManager, []);
    if (typeof contextSessionId !== "string" || contextSessionId.length === 0) return undefined;

    const registryProvider = pi.pi?.AgentRegistry;
    if (
      registryProvider === null ||
      (typeof registryProvider !== "object" && typeof registryProvider !== "function")
    ) {
      return undefined;
    }
    const getRegistry = Reflect.get(registryProvider, "global");
    if (typeof getRegistry !== "function") return undefined;
    const registry = Reflect.apply(getRegistry, registryProvider, []);
    if (registry === null || typeof registry !== "object") return undefined;
    const getAgent = Reflect.get(registry, "get");
    if (typeof getAgent !== "function") return undefined;
    const registeredAgent = Reflect.apply(getAgent, registry, [agentId]);
    if (registeredAgent === null || typeof registeredAgent !== "object") return undefined;

    const session = Reflect.get(registeredAgent, "session");
    if (!session || typeof session !== "object") return undefined;
    const sessionManager = Reflect.get(session, "sessionManager");
    if (sessionManager === null || typeof sessionManager !== "object") return undefined;
    const getSessionId = Reflect.get(sessionManager, "getSessionId");
    if (typeof getSessionId !== "function") return undefined;
    const registeredSessionId = Reflect.apply(getSessionId, sessionManager, []);
    if (registeredSessionId !== contextSessionId) return undefined;
    return session as UnknownRecord;
  } catch {
    return undefined;
  }
}

function activeSessionSkillsFor(pi: HostPi, ctx: unknown): unknown[] | undefined {
  const session = activeSessionFor(pi, ctx);
  try {
    const skills = session ? Reflect.get(session, "skills") : undefined;
    return Array.isArray(skills) ? skills : undefined;
  } catch {
    return undefined;
  }
}


function skillRouteParts(requestPath: string): string[] | undefined {
  const router = InternalUrlRouter.instance();
  const { path: normalizedPath } = router.split(requestPath.trim());
  if (extractUriScheme(normalizedPath) !== "skill" || !router.canResolve(normalizedPath)) return undefined;
  let host: string;
  let pathname: string;
  try {
    const url = parseInternalUrl(normalizedPath);
    host = url.rawHost || url.hostname;
    pathname = url.pathname;
  } catch {
    return undefined;
  }
  if (!host || pathname.startsWith("//")) return undefined;
  let route = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (route.endsWith("/")) route = route.slice(0, -1);
  if (route.includes("\\") || route.includes("?") || route.includes("#")) return undefined;
  const encodedParts = route ? route.split("/") : [];
  if (encodedParts.some(part => part.length === 0)) return undefined;
  let parts: string[];
  try {
    parts = encodedParts.map(part => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  const decodedPath = parts.join("/");
  if (
    parts.some(part => !part || part === "." || part.includes("\\")) ||
    decodedPath.startsWith("/") ||
    decodedPath.split(/[\\/]/).includes("..")
  ) {
    return undefined;
  }
  return [host, ...parts];
}

function activeSkillTarget(
  skills: unknown[],
  routeParts: string[],
  directory = false,
): { name: string; targetPath: string; directory: boolean } | undefined {
  const [host, ...pathParts] = routeParts;
  if (!host) return undefined;
  let candidate: UnknownRecord | undefined;
  let remainingPath = pathParts;
  // OMP checks exactly <host>/<first path segment> before falling back to the bare host skill.
  if (pathParts.length > 0) {
    const namespaceName = `${host}/${pathParts[0]}`;
    const match = skills.find(
      (entry): entry is UnknownRecord =>
        entry !== null && typeof entry === "object" && (entry as UnknownRecord).name === namespaceName,
    );
    if (match) {
      candidate = match;
      remainingPath = pathParts.slice(1);
    }
  }
  candidate ??= skills.find(
    (entry): entry is UnknownRecord =>
      entry !== null && typeof entry === "object" && (entry as UnknownRecord).name === host,
  );
  if (!candidate || typeof candidate.name !== "string" || typeof candidate.filePath !== "string") {
    return undefined;
  }
  const filePath = resolve(candidate.filePath);
  const baseDir = typeof candidate.baseDir === "string" ? resolve(candidate.baseDir) : dirname(filePath);
  return {
    name: candidate.name,
    targetPath: remainingPath.length === 0 ? (directory ? baseDir : filePath) : resolve(baseDir, ...remainingPath),
    directory: remainingPath.length === 0 && directory,
  };
}

function managedGroupForRead(
  roots: ManagedRootPaths,
  groupStore: ManagedGroupStore,
  knownGroups: Set<string>,
  routeParts: string[],
  skills: unknown[],
  directoryRequested: boolean,
): ManagedGroupRead | undefined {
  const target = activeSkillTarget(skills, routeParts, directoryRequested);
  if (!target) return undefined;
  const targetPath = pathWithinManagedRoot(roots, target.targetPath);
  if (!targetPath) return undefined;

  let directory = target.directory;
  try {
    directory = statSync(targetPath).isDirectory();
  } catch {
    if (directoryRequested && routeParts.at(-1) !== "SKILL.md") directory = true;
  }

  const relativePath = relative(roots.root, targetPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }
  const targetParts = relativePath.split(/[\\/]/);
  const directoryParts = directory ? targetParts : targetParts.slice(0, -1);
  if (directoryParts.length === 0 || !isManagedName(directoryParts[0])) return undefined;

  let group: string | undefined;
  for (let count = 1; count <= directoryParts.length; count++) {
    const segments = directoryParts.slice(0, count);
    if (segments.some(segment => segment !== normalisedSkillName(segment) || !isManagedName(segment))) break;
    const candidate = segments.join("/");
    if (groupStore.isGroup(candidate) || knownGroups.has(candidate)) group = candidate;
  }
  return group ? { group, targetPath, directory } : undefined;
}

async function readPathEntries(requestPath: string, cwd: string): Promise<string[]> {
  const router = InternalUrlRouter.instance();
  const mixedParts = await splitMixedUrlPathList(
    requestPath,
    cwd,
    part => parseReadUrlTarget(part) !== null || router.canResolve(part),
  );
  if (mixedParts) return mixedParts;
  if (router.canResolve(requestPath)) {
    return (
      (await splitDelimitedPathEntry(requestPath, cwd, {
        routedUrlPredicate: part => router.canResolve(part),
      })) ?? [requestPath]
    );
  }
  if (parseReadUrlTarget(requestPath) !== null) return [requestPath];
  if (requestPath.toLowerCase().includes("skill:")) {
    return (await splitDelimitedPathEntry(requestPath, cwd)) ?? [requestPath];
  }
  return [requestPath];
}

function mayAddressKnownManagedTopGroup(
  routeParts: string[],
  groupStore: ManagedGroupStore,
  knownGroups: Set<string>,
): boolean {
  for (let index = 0; index < routeParts.length && index < 2; index++) {
    const candidate = routeParts[index];
    if (!candidate) continue;
    const group = topManagedGroup(candidate);
    if (!isManagedName(group)) continue;
    if (knownGroups.has(group) || groupStore.isGroup(group)) return true;
    for (const known of knownGroups) {
      if (known.startsWith(`${group}/`)) return true;
    }
  }
  return false;
}


async function managedGroupReadsForRead(
  pi: HostPi,
  roots: ManagedRootPaths,
  groupStore: ManagedGroupStore,
  knownGroups: Set<string>,
  event: UnknownRecord,
  ctx: unknown,
): Promise<{ reads: ManagedGroupRead[]; skills: unknown[] } | undefined> {
  if (event.toolName !== "read") return undefined;
  const input = event.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const inputRecord = input as UnknownRecord;
  const requestPath = inputRecord.path;
  if (typeof requestPath !== "string" || !requestPath.toLowerCase().includes("skill:")) return undefined;
  const context = ctx !== null && typeof ctx === "object" && !Array.isArray(ctx) ? (ctx as UnknownRecord) : {};
  const cwd = typeof context.cwd === "string" ? context.cwd : "";
  const entries = await readPathEntries(requestPath, cwd);
  const routes: string[][] = [];
  for (const entry of entries) {
    const routeParts = skillRouteParts(entry);
    if (routeParts) routes.push(routeParts);
  }
  if (routes.length === 0) return undefined;
  const skills = activeSessionSkillsFor(pi, ctx);
  if (!skills) {
    if (routes.some(route => mayAddressKnownManagedTopGroup(route, groupStore, knownGroups))) {
      throw new Error("OMP current-session skills are unavailable; cannot verify this possible managed skill read.");
    }
    return undefined;
  }
  const directoryRequested = inputRecord.directory === true;
  const reads: ManagedGroupRead[] = [];
  for (const routeParts of routes) {
    const read = managedGroupForRead(
      roots,
      groupStore,
      knownGroups,
      routeParts,
      skills,
      directoryRequested,
    );
    if (read) reads.push(read);
  }
  return { reads, skills };
}

function assertGroupIndexLinksVisible(
  skills: unknown[],
  roots: ManagedRootPaths,
  indexPath: string,
): void {
  const canonicalIndexPath = pathWithinManagedRoot(roots, indexPath);
  if (!canonicalIndexPath) throw new Error("Managed skill index is outside the managed-skills root.");
  const relativeIndexPath = relative(roots.root, canonicalIndexPath);
  const indexParts = relativeIndexPath.split(/[\\/]/);
  if (indexParts.at(-1) === "SKILL.md") {
    const indexGroup = indexParts.slice(0, -1).join("/");
    if (isManagedGroup(indexGroup)) {
      const route = `${indexGroup}/SKILL.md`;
      const actual = activeSkillTarget(skills, [...indexGroup.split("/"), "SKILL.md"]);
      const expectedPath = resolve(roots.root, indexGroup, "SKILL.md");
      if (actual) {
        const actualPath = pathWithinManagedRoot(roots, actual.targetPath) ?? resolve(actual.targetPath);
        if (!samePathTarget(actualPath, expectedPath)) {
          throw new Error(
            `OMP resolves "skill://${route}" to active skill "${actual.name}" at "${actual.targetPath}", ` +
              `masking the managed group index at "${expectedPath}".`,
          );
        }
      }
    }
  }
  const index = readFileSync(canonicalIndexPath, "utf8");
  const links = /^[ \t]+Read: skill:\/\/([^\/\s]+(?:\/[^\/\s]+)+\/SKILL\.md)[ \t]*\r?$/gm;
  for (const match of index.matchAll(links)) {
    const route = match[1];
    if (!route) continue;
    const routeParts = skillRouteParts(`skill://${route}`);
    if (!routeParts || routeParts.length < 3) continue;
    const actual = activeSkillTarget(skills, routeParts);
    if (!actual) continue;
    const expectedPath = resolve(roots.root, ...routeParts);
    const actualPath = pathWithinManagedRoot(roots, actual.targetPath) ?? resolve(actual.targetPath);
    if (samePathTarget(actualPath, expectedPath)) continue;
    throw new Error(
      `OMP resolves "skill://${route}" to active skill "${actual.name}" at "${actual.targetPath}", ` +
        `masking the managed group entry at "${expectedPath}".`,
    );
  }
}

function buildSchemas(z: ZodLike): { learn: Schema; manageSkill: Schema } {
  const learnSkill = z.object({
    group: optionalSchema(
      z,
      describeSchema(z.string(), "required for a global skill; slash-separated kebab-case group path, e.g. engineering/database/postgresql"),
    ),
    action: z.enum(LEARN_ACTION_VALUES),
    name: describeSchema(z.string(), "kebab-case skill name"),
    description: describeSchema(z.string(), "one-line description of when to use the skill"),
    body: describeSchema(z.string(), "the SKILL.md body in markdown (no frontmatter)"),
  });
  const learnSchema = z.object({
    memory: describeSchema(z.string(), "the durable, self-contained lesson to remember (what, when, why)"),
    context: optionalSchema(z, describeSchema(z.string(), "optional source context for the lesson")),
    skill: optionalSchema(z, describeSchema(learnSkill, "also create or enhance a skill in a global group or project scope")),
    scope: optionalSchema(z, describeSchema(z.enum(SCOPE_VALUES), "where the optional skill is persisted; defaults to global")),
  });
  const learnCandidate = learnSchema as ZodLikeSchema;
  const learn =
    (learnSchema !== null && (typeof learnSchema === "object" || typeof learnSchema === "function") &&
      typeof learnCandidate.refine === "function")
      ? learnCandidate.refine(
          value => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
            const params = value as UnknownRecord;
            if (params.scope === "project" || params.skill === undefined) return true;
            if (params.skill === null || typeof params.skill !== "object" || Array.isArray(params.skill)) return false;
            const skill = params.skill as UnknownRecord;
            return isManagedGroup(skill.group) && isManagedName(skill.name);
          },
          'global learn with "skill" requires a valid skill "group" and "name".',
        )
      : learnSchema;

  const manageSkillSchema = z.object({
    group: optionalSchema(
      z,
      describeSchema(z.string(), "required for global scope; slash-separated kebab-case group path, e.g. engineering/database/postgresql"),
    ),
    action: z.enum(MANAGE_ACTION_VALUES),
    name: describeSchema(z.string(), "kebab-case skill name"),
    description: optionalSchema(
      z,
      describeSchema(z.string(), "one-line description of when to use the skill (required for create/update)"),
    ),
    body: optionalSchema(z, describeSchema(z.string(), "the SKILL.md body in markdown, no frontmatter (required for create/update)")),
    scope: optionalSchema(z, describeSchema(z.enum(SCOPE_VALUES), "where the skill is persisted; defaults to global")),
  });
  const manageCandidate = manageSkillSchema as ZodLikeSchema;
  const manageSkill =
    (manageSkillSchema !== null && (typeof manageSkillSchema === "object" || typeof manageSkillSchema === "function") &&
      typeof manageCandidate.refine === "function")
      ? manageCandidate.refine(
          value => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
            const params = value as UnknownRecord;
            if (params.scope !== "project" && (!isManagedGroup(params.group) || !isManagedName(params.name))) return false;
            if (params.action === "delete") return true;
            return (
              (params.action === "create" || params.action === "update") &&
              typeof params.description === "string" &&
              typeof params.body === "string"
            );
          },
          'global manage_skill requires a valid "group" and "name"; create/update require "description" and "body".',
        )
      : manageSkillSchema;
  return { learn, manageSkill };
}

export function installAutoLearnScope(pi: HostPi, options?: AutoLearnScopeOptions): void {
  const managedRoots = managedRootFrom(pi, options);
  const managedRoot = managedRoots.root;
  const groupStore = createManagedGroupStore(managedRoot);
  const knownGroups = new Set<string>();
  rememberManagedGroups(managedRoot, groupStore, knownGroups);
  const { learn: learnParameters, manageSkill: manageSkillParameters } = buildSchemas(pi.zod);
  const writer = projectWriterFrom(options);
  const factorySettings = publicSettingsAccessor(pi);
  // SDK derives hidden capture tools from initialTools, so only explicitly enabled native tools may activate wrappers.
  const enabledAtRegistration = factorySettings.get("autolearn.enabled") === true;
  const memoryBackend = factorySettings.get("memory.backend");
  const learnDefaultInactive =
    !enabledAtRegistration ||
    !NATIVE_MEMORY_BACKENDS.includes(memoryBackend as (typeof NATIVE_MEMORY_BACKENDS)[number]);
  const manageDefaultInactive = !enabledAtRegistration;
  const learnApproval: ToolApproval =
    factorySettings.kind === "missing"
      ? "write"
      : params => {
          const input =
            params !== null && typeof params === "object" ? (params as UnknownRecord) : {};
          return input.skill || factorySettings.get("memory.backend") === "local" ? "write" : "read";
        };

  function summaryContextOptions(
    ctx: unknown,
    work: ManagedGroupSummaryWork,
    force: boolean,
    failedDependencies: ReadonlySet<string>,
  ) {
    const context = ctx !== null && typeof ctx === "object" && !Array.isArray(ctx) ? (ctx as UnknownRecord) : {};
    const modelApi = context.models !== null && typeof context.models === "object"
      ? (context.models as UnknownRecord)
      : {};
    const resolve = modelApi.resolve;
    const sessionManager = context.sessionManager !== null && typeof context.sessionManager === "object"
      ? (context.sessionManager as UnknownRecord)
      : {};
    let sessionId: string | undefined;
    if (typeof sessionManager.getSessionId === "function") {
      const resolvedSessionId = Reflect.apply(sessionManager.getSessionId, sessionManager, []);
      if (typeof resolvedSessionId === "string" && resolvedSessionId.length > 0) sessionId = resolvedSessionId;
    }
    const session = activeSessionFor(pi, ctx);
    let settings: Settings | undefined;
    try {
      settings = session?.settings as Settings | undefined;
    } catch {
      settings = undefined;
    }
    return {
      store: groupStore,
      work,
      force,
      settings,
      registry: context.modelRegistry as ModelRegistry | undefined,
      sessionId,
      resolveModel(spec: string): Model | undefined {
        if (typeof resolve !== "function") return undefined;
        return Reflect.apply(resolve, modelApi, [spec]) as Model | undefined;
      },
      failedDependencies,
    };
  }

  function sendSummaryMessage(outcome: ManagedGroupSummaryOutcome): void {
    try {
      pi.sendMessage(
        { customType: "auto-learn-scope:managed-skill-summary", content: outcome.message, display: true },
        { triggerTurn: false },
      );
    } catch {
      // Durable summary state remains available if a host cannot display the message.
    }
  }

  function notifySummaryOutcome(
    ctx: unknown,
    outcome: ManagedGroupSummaryOutcome,
    sendCustomWhenNoUI = true,
  ): void {
    const context = ctx !== null && typeof ctx === "object" && !Array.isArray(ctx) ? (ctx as UnknownRecord) : {};
    const ui = context.ui !== null && typeof context.ui === "object" ? (context.ui as UnknownRecord) : {};
    const hasUI = context.hasUI === true;
    if (hasUI && typeof ui.notify === "function") {
      const severity = outcome.status === "failed" || outcome.status === "blocked" || outcome.status === "conflict"
        ? "warning"
        : "info";
      try {
        Reflect.apply(ui.notify, ui, [outcome.message, severity]);
        return;
      } catch {
        // Fall back to a visible custom message if the host notification surface is unavailable.
      }
    }
    const isIdle = typeof context.isIdle === "function" && Reflect.apply(context.isIdle, context, []) === true;
    if (sendCustomWhenNoUI && isIdle) sendSummaryMessage(outcome);
  }
  async function executeSummaryWork(
    ctx: unknown,
    work: ManagedGroupSummaryWork,
    force: boolean,
    failedDependencies: Set<string>,
    sendCustomWhenNoUI = true,
  ): Promise<ManagedGroupSummaryOutcome> {
    let outcome: ManagedGroupSummaryOutcome;
    try {
      outcome = await runManagedGroupSummaryWork(
        summaryContextOptions(ctx, work, force, failedDependencies),
      );
    } catch (error) {
      outcome = {
        group: work.group,
        status: "failed",
        message: `${work.group}: summary work failed unexpectedly: ${errorReason(error)}`,
      };
    }
    if (outcome.status === "generated" || outcome.status === "skipped") {
      failedDependencies.delete(work.group);
    } else {
      failedDependencies.add(work.group);
    }
    notifySummaryOutcome(ctx, outcome, sendCustomWhenNoUI);
    return outcome;
  }


  async function runSummaryWorkBatch(
    ctx: unknown,
    works: ManagedGroupSummaryWork[],
    force: boolean,
  ): Promise<ManagedGroupSummaryOutcome[]> {
    const failedDependencies = new Set<string>();
    const outcomes: ManagedGroupSummaryOutcome[] = [];
    for (const work of works) {
      const outcome = await executeSummaryWork(ctx, work, force, failedDependencies, false);
      outcomes.push(outcome);
      sendSummaryMessage(outcome);
    }
    return outcomes;
  }


  let automaticDrain: Promise<void> | undefined;
  let restartAfterDrainContext: unknown;
  let restartAfterDrainRequested = false;


  async function drainAutomaticSummaryWork(ctx: unknown): Promise<void> {
    const attempted = new Set<string>();
    const failedDependencies = new Set<string>();
    while (true) {
      let pending: ManagedGroupSummaryWork[];
      try {
        pending = groupStore.pendingSummaryWork();
      } catch (error) {
        notifySummaryOutcome(ctx, {
          group: "<managed skills>",
          status: "failed",
          message: `Automatic managed skill summary recovery failed: ${errorReason(error)}`,
        });
        return;
      }
      const work = pending.find(candidate =>
        candidate.trigger === "automatic" &&
        !attempted.has(`${candidate.group}\0${candidate.operationId}\0${candidate.generation}`),
      );
      if (!work) return;
      attempted.add(`${work.group}\0${work.operationId}\0${work.generation}`);
      await executeSummaryWork(ctx, work, false, failedDependencies);
    }
  }

  function startAutomaticSummaryWork(ctx: unknown): void {
    if (automaticDrain) {
      // The active drain clears its flag only after the last empty scan returns.
      // Work queued in this gap must schedule one more scan.
      restartAfterDrainContext = ctx;
      restartAfterDrainRequested = true;
      return;
    }
    const running = drainAutomaticSummaryWork(ctx);
    automaticDrain = running;
    void running.finally(() => {
      if (automaticDrain !== running) return;
      automaticDrain = undefined;
      if (!restartAfterDrainRequested) return;
      const nextContext = restartAfterDrainContext;
      restartAfterDrainContext = undefined;
      restartAfterDrainRequested = false;
      startAutomaticSummaryWork(nextContext);
    }).catch(() => undefined);
  }

  pi.registerTool({
    name: "learn",
    label: "Learn",
    description: LEARN_DESCRIPTION,
    parameters: learnParameters,
    defaultInactive: learnDefaultInactive,
    loadMode: "essential",
    approval: learnApproval,
    strict: true,
    summary: "Capture a reusable lesson to memory (and optionally a grouped global or project skill)",
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      assertAutoLearnEnabled(factorySettings, ctx, "learn");
      const params = asRecord(rawParams, "learn");
      const scope = validateScope(params);
      const skill = validateLearnParams(params);
      const managedSkill =
        scope === "global" && skill
          ? {
              ...skill,
              group: requireManagedGroup(skill.group, 'learn skill "group"'),
              name: requireManagedName(skill.name, "learn skill name"),
            }
          : skill;
      if (scope === "global" && managedSkill?.action === "create" && managedSkill.group) {
        const topGroup = topManagedGroup(managedSkill.group);
        assertGroupNotShadowed(activeSessionSkillsFor(pi, ctx), managedRoots, topGroup, groupStore.isGroup(topGroup));
      }
      const invoke = requireNative(ctx, "learn");
      const invokeOptions = { signal, onUpdate };

      if (!skill) {
        const memoryParams = scope === "global" ? omit(params, "scope") : omit(params, "scope", "skill");
        return invoke(memoryParams, invokeOptions);
      }

      const memoryParams = omit(params, "scope", "skill");
      const memoryResult = await invoke(memoryParams, invokeOptions);
      if (nativeToolFailed(memoryResult)) return memoryResult;
      if (!managedSkill) return memoryResult;

      if (scope === "global") {
        const group = managedSkill.group;
        if (!group) throw new Error('learn skill "group" is required for global scope.');
        try {
          const result = groupStore.mutate({
            group,
            action: managedSkill.action,
            name: managedSkill.name,
            description: managedSkill.description,
            body: managedSkill.body,
          });
          rememberManagedGroupPath(knownGroups, group);
          if (result.summaryQueued) startAutomaticSummaryWork(ctx);
          return managedSkillOutcome(
            managedSkill.action,
            managedSkill.name,
            group,
            true,
            memoryResult,
            result.path,
            result.indexes,
            false,
            undefined,
            result.summaryQueued,
          );
        } catch (error) {
          return managedSkillOutcome(
            managedSkill.action,
            managedSkill.name,
            group,
            true,
            memoryResult,
            undefined,
            undefined,
            true,
            error,
          );
        }
      }

      const cwd = contextCwd(ctx);
      const hintedPath = skillPathHint(cwd, skill.name);
      try {
        const input = {
          cwd,
          name: skill.name,
          description: skill.description,
          body: skill.body,
        };
        const result =
          skill.action === "create"
            ? await writer.create(input)
            : await writer.update(input);
        const path =
          result !== null && typeof result === "object" && typeof result.path === "string"
            ? result.path
            : hintedPath;
        return combineProjectSkillResult(memoryResult, skill, path, result);
      } catch (error) {
        return partialProjectSkillResult(memoryResult, skill, errorPath(error) ?? hintedPath, errorReason(error));
      }
    },
  });

  pi.registerTool({
    name: "manage_skill",
    label: "Manage Skill",
    description: MANAGE_DESCRIPTION,
    parameters: manageSkillParameters,
    defaultInactive: manageDefaultInactive,
    loadMode: "essential",
    approval: "write",
    strict: true,
    summary: "Create, update, or delete a grouped global or isolated project skill",
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      assertAutoLearnEnabled(factorySettings, ctx, "manage_skill");
      const params = asRecord(rawParams, "manage_skill");
      const scope = validateScope(params);
      const nativeParams = omit(params, "scope");
      const manageParams = validateManageParams(nativeParams);

      if (scope === "global") {
        const group = requireManagedGroup(manageParams.group, 'manage_skill "group"');
        const name = requireManagedName(manageParams.name, "manage_skill name");
        if (manageParams.action === "create") {
          const topGroup = topManagedGroup(group);
          assertGroupNotShadowed(activeSessionSkillsFor(pi, ctx), managedRoots, topGroup, groupStore.isGroup(topGroup));
        }
        try {
          const result = groupStore.mutate({
            group,
            action: manageParams.action,
            name,
            ...(manageParams.action === "delete"
              ? {}
              : { description: manageParams.description ?? "", body: manageParams.body ?? "" }),
          });
          rememberManagedGroupPath(knownGroups, group);
          if (result.summaryQueued) startAutomaticSummaryWork(ctx);
          return managedSkillOutcome(
            manageParams.action,
            name,
            group,
            false,
            undefined,
            result.path,
            result.indexes,
            false,
            undefined,
            result.summaryQueued,
          );
        } catch (error) {
          return managedSkillOutcome(
            manageParams.action,
            name,
            group,
            false,
            undefined,
            undefined,
            undefined,
            true,
            error,
          );
        }
      }

      requireNative(ctx, "manage_skill");
      const cwd = contextCwd(ctx);
      const input = {
        cwd,
        name: manageParams.name,
        ...(manageParams.action === "delete"
          ? {}
          : { description: manageParams.description ?? "", body: manageParams.body ?? "" }),
      };
      try {
        if (manageParams.action === "create") {
          const result = await writer.create(input);
          return {
            content: [textContent(`Created project skill "${manageParams.name}" at ${result.path}.`)],
            details: { action: "create", name: manageParams.name, path: result.path, projectSkill: result },
          };
        }
        if (manageParams.action === "update") {
          const result = await writer.update(input);
          return {
            content: [textContent(`Updated project skill "${manageParams.name}" at ${result.path}.`)],
            details: { action: "update", name: manageParams.name, path: result.path, projectSkill: result },
          };
        }
        await writer.delete({ cwd, name: manageParams.name });
        return {
          content: [textContent(`Deleted project skill "${manageParams.name}".`)],
          details: { action: "delete", name: manageParams.name },
        };
      } catch (error) {
        throw new Error(
          `Project manage_skill ${manageParams.action} for "${manageParams.name}" failed: ${errorReason(error)}`,
        );
      }
    },
  });

  pi.on("before_agent_start", event => {
    if (!autoLearnEnabled(factorySettings)) {
      return { systemPrompt: event.systemPrompt };
    }
    return {
      systemPrompt: [...(Array.isArray(event.systemPrompt) ? event.systemPrompt : []), GUIDANCE],
    };
  });

  const scanManagedGroups = (): void => {
    groupStore.scan();
    rememberManagedGroups(managedRoot, groupStore, knownGroups);
  };

  pi.registerCommand("refresh-managed-skills", {
    description: "Refresh every managed skill group bottom-up; use --force to skip the judge and regenerate all summaries.",
    async handler(args, ctx): Promise<void> {
      const normalizedArgs = args.trim();
      if (normalizedArgs !== "" && normalizedArgs !== "--force") {
        const outcome: ManagedGroupSummaryOutcome = {
          group: "<managed skills>",
          status: "failed",
          message: "Usage: /refresh-managed-skills [--force]",
        };
        notifySummaryOutcome(ctx, outcome, false);
        sendSummaryMessage(outcome);
        return;
      }
      const force = normalizedArgs === "--force";
      try {
        scanManagedGroups();
        const work = groupStore.queueManualSummaryWork();
        const outcomes = await runSummaryWorkBatch(ctx, work, force);
        if (outcomes.length === 0) {
          const outcome: ManagedGroupSummaryOutcome = {
            group: "<managed skills>",
            status: "generated",
            message: "No managed skill groups were found.",
          };
          notifySummaryOutcome(ctx, outcome, false);
          sendSummaryMessage(outcome);
        }
      } catch (error) {
        const outcome: ManagedGroupSummaryOutcome = {
          group: "<managed skills>",
          status: "failed",
          message: `Managed skill summary refresh failed: ${errorReason(error)}`,
        };
        notifySummaryOutcome(ctx, outcome, false);
        sendSummaryMessage(outcome);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    startAutomaticSummaryWork(ctx);
  });
  pi.on("session_switch", (_event, ctx) => {
    try {
      groupStore.beginSession();
    } catch (error) {
      notifySummaryOutcome(ctx, {
        group: "<managed skills>",
        status: "failed",
        message: `Managed skill session recovery failed: ${errorReason(error)}`,
      });
      return;
    }
    startAutomaticSummaryWork(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    let batch: { reads: ManagedGroupRead[]; skills: unknown[] } | undefined;
    try {
      batch = await managedGroupReadsForRead(pi, managedRoots, groupStore, knownGroups, event, ctx);
    } catch (error) {
      return {
        block: true,
        reason: `Managed skill read could not be verified: ${errorReason(error)}`,
      };
    }
    if (!batch || batch.reads.length === 0) return;
    const refreshGroups = new Set<string>();
    for (const read of batch.reads) {
      const { group, targetPath, directory } = read;
      try {
        const isGroup = groupStore.isGroup(group);
        if (!isGroup) {
          if (!knownGroups.has(group)) continue;
          return {
            block: true,
            reason: `Managed skill group "${group}" no longer has a valid index; resolve the conflict and refresh managed skills.`,
          };
        }
        const relativePath = relative(resolve(managedRoot), resolve(targetPath));
        const targetParts = relativePath.split(/[\\/]/);
        if (!directory && targetParts.at(-1) === "SKILL.md") {
          const indexGroup = targetParts.slice(0, -1).join("/");
          if (indexGroup && groupStore.isGroup(indexGroup)) {
            assertGroupIndexLinksVisible(batch.skills, managedRoots, targetPath);
          }
        }
        refreshGroups.add(group);
      } catch (error) {
        return {
          block: true,
          reason: `Managed skill group "${group}" could not refresh before read: ${errorReason(error)}`,
        };
      }
    }
    for (const group of refreshGroups) {
      try {
        rememberManagedGroupPath(knownGroups, group);
        groupStore.refresh(group);
      } catch (error) {
        return {
          block: true,
          reason: `Managed skill group "${group}" could not refresh before read: ${errorReason(error)}`,
        };
      }
    }
  });
}

export default function autoLearnScopeExtension(pi: HostPi, options?: AutoLearnScopeOptions): void {
  installAutoLearnScope(pi, options);
}
