import { readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createManagedGroupStore, type ManagedGroupStore } from "./managed-groups";
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

type CommandHandler = (args: string, ctx: UnknownRecord) => unknown | Promise<unknown>;

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
  getActiveSkills?: () => unknown;
};

type HostPi = {
  pi?: HostPiNamespace;
  zod: ZodLike;
  registerTool: (definition: ToolDefinition) => void;
  registerCommand: (name: string, definition: { description: string; handler: CommandHandler }) => void;
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
  "For a global skill, `skill.group` is required; choose the existing managed-skill group that best fits or create a new one by name.",
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
  "`group` and `name`: kebab-case (lowercase letters, digits, hyphens); group is required for global scope.",
  "`description`: specific; drives discovery.",
  "No frontmatter in `body`; generated from `name` and `description`.",
  'Scope defaults to "global"; `scope: "project"` writes the isolated project skill under this repository instead, without a group.',
].join(" ");
const GUIDANCE =
  "Auto-learn guidance: scope defaults to global. Use native memory/learn for durable facts or conventions; use a procedure/skill only when it is reusable. Global skills require an explicit group: choose the existing group that best fits or name a new group. Memory-only learn calls need no group. Choose scope=project only when a skill should be saved in this repository, check whether an existing skill already covers it, and never put secrets or tokens in a skill.";

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

function managedRootFrom(pi: HostPi, options?: AutoLearnScopeOptions): string {
  if (options?.managedRoot !== undefined) {
    if (typeof options.managedRoot !== "string" || options.managedRoot.trim().length === 0) {
      throw new Error("managedRoot must be a non-empty path when provided.");
    }
    return resolve(options.managedRoot);
  }
  const namespace = pi.pi;
  if (!namespace || typeof namespace.getAgentDir !== "function") {
    throw new Error("OMP host does not expose pi.getAgentDir(); provide options.managedRoot explicitly.");
  }
  const agentDir = namespace.getAgentDir.call(namespace);
  if (typeof agentDir !== "string" || agentDir.trim().length === 0) {
    throw new Error("OMP host pi.getAgentDir() did not return an agent directory.");
  }
  return join(resolve(agentDir), "managed-skills");
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

function assertGroupNotShadowed(pi: HostPi, managedRoot: string, group: string): void {
  const namespace = pi.pi;
  if (!namespace || typeof namespace.getActiveSkills !== "function") {
    throw new Error("OMP host does not expose pi.getActiveSkills(); cannot verify group-name conflicts.");
  }
  let skills: unknown;
  try {
    skills = namespace.getActiveSkills.call(namespace);
  } catch (error) {
    throw new Error(`OMP host active skills are unavailable; cannot verify group-name conflicts: ${errorReason(error)}`);
  }
  if (!Array.isArray(skills)) {
    throw new Error("OMP host returned no active-skill list; cannot verify group-name conflicts.");
  }

  const groupIndex = resolve(managedRoot, group, "SKILL.md");
  for (const entry of skills) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as UnknownRecord;
    if (candidate.name !== group) continue;
    if (typeof candidate.filePath !== "string" || candidate.filePath.length === 0) {
      throw new Error(`Cannot create managed skill group "${group}": an active same-named skill has no file path.`);
    }
    const activePath = resolve(candidate.filePath);
    throw new Error(
      `Cannot create managed skill group "${group}": an active skill with the same name resolves to "${candidate.filePath}"${
        activePath === groupIndex ? " but that path is not a verified managed group index" : ""
      }.`,
    );
  }
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

function managedSkillOutcome(
  action: ManageAction,
  name: string,
  group: string,
  managedRoot: string,
  memorySaved: boolean,
  memoryResult: unknown,
  mutationPath: string | undefined,
  failed: boolean,
  error: unknown,
): UnknownRecord {
  const path = failed ? errorPath(error) : mutationPath;
  const skillPath = failed ? errorStringField(error, "skillPath") ?? path : path;
  const skillStatus = failed ? storeStatus(error, "skillStatus") : action === "delete" ? "deleted" : "written";
  const indexStatus = failed ? storeStatus(error, "indexStatus") : "written";
  const indexPath = failed ? errorStringField(error, "indexPath") ?? join(managedRoot, group, "SKILL.md") : join(managedRoot, group, "SKILL.md");
  const reason = failed ? errorReason(error) : undefined;
  const skill = {
    action,
    name,
    group,
    status: skillStatus,
    ...(skillPath ? { path: skillPath } : {}),
  };
  const index = { status: indexStatus, path: indexPath };
  const message = failed
    ? `${memorySaved ? "Memory was saved, but " : ""}managed skill "${name}" in group "${group}" failed (skillStatus=${skillStatus}, indexStatus=${indexStatus}${path ? `, path=${path}` : ""}): ${reason}`
    : `${memorySaved ? "Memory was saved and " : ""}${action === "delete" ? "deleted" : `${action}d`} managed skill "${name}" in group "${group}"${path ? ` at ${path}` : ""}; group index ${indexStatus} at ${indexPath}.`;
  return {
    ...(memorySaved && memoryResult !== null && typeof memoryResult === "object"
      ? (memoryResult as UnknownRecord)
      : {}),
    ...(memorySaved ? { memory: memoryResult, memoryStatus: "written" } : {}),
    skill,
    index,
    skillStatus,
    indexStatus,
    ...(path ? { path } : {}),
    ...(skillPath ? { skillPath } : {}),
    indexPath,
    ...(failed ? { reason, isError: true } : {}),
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
      ...(path ? { path } : {}),
      ...(skillPath ? { skillPath } : {}),
      indexPath,
      ...(failed ? { reason, partial: memorySaved } : {}),
    },
  };
}

function managedGroupForRead(pi: HostPi, managedRoot: string, event: UnknownRecord): string | undefined {
  if (event.toolName !== "read") return undefined;
  const input = event.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const requestPath = (input as UnknownRecord).path;
  if (typeof requestPath !== "string" || !requestPath.trim().startsWith("skill://")) return undefined;
  const route = requestPath.trim().slice("skill://".length);
  if (!route || route.startsWith("/") || /(^|\/)\.{1,2}(\/|$)|\/\//.test(route)) return undefined;
  const namespace = pi.pi;
  if (!namespace || typeof namespace.getActiveSkills !== "function") return undefined;

  let skills: unknown;
  try {
    skills = namespace.getActiveSkills.call(namespace);
  } catch {
    return undefined;
  }
  if (!Array.isArray(skills)) return undefined;

  let resolvedName = "";
  let resolvedFilePath = "";
  let longestName = -1;
  let ambiguous = false;
  for (const entry of skills) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as UnknownRecord;
    if (typeof candidate.name !== "string" || typeof candidate.filePath !== "string") continue;
    if (route !== candidate.name && !route.startsWith(`${candidate.name}/`)) continue;
    if (candidate.name.length > longestName) {
      resolvedName = candidate.name;
      resolvedFilePath = candidate.filePath;
      longestName = candidate.name.length;
      ambiguous = false;
    } else if (candidate.name.length === longestName) {
      ambiguous = true;
    }
  }
  if (longestName < 0 || ambiguous || resolvedName.length === 0 || resolvedFilePath.length === 0) {
    return undefined;
  }

  const relativePath = relative(resolve(managedRoot), resolve(resolvedFilePath));
  const parts = relativePath.split(/[\\/]/);
  if (parts[0] === ".." || (parts.length !== 2 && parts.length !== 3)) return undefined;
  if (parts.at(-1) !== "SKILL.md" || !isManagedName(parts[0])) return undefined;
  const group = parts[0];
  const routeGroup = route.slice(0, route.indexOf("/") < 0 ? route.length : route.indexOf("/"));
  if (group !== normalisedSkillName(group) || routeGroup !== group) return undefined;
  if (parts.length === 3 && !isManagedName(parts[1])) return undefined;
  return group;
}

function buildSchemas(z: ZodLike): { learn: Schema; manageSkill: Schema } {
  const learnSkill = z.object({
    group: optionalSchema(
      z,
      describeSchema(z.string(), "required for a global scope skill; kebab-case managed-skill group name"),
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
            return isManagedName(skill.group) && isManagedName(skill.name);
          },
          'global learn with "skill" requires a valid skill "group" and "name".',
        )
      : learnSchema;

  const manageSkillSchema = z.object({
    group: optionalSchema(
      z,
      describeSchema(z.string(), "required for global scope; kebab-case managed-skill group name"),
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
            if (params.scope !== "project" && (!isManagedName(params.group) || !isManagedName(params.name))) return false;
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
  const managedRoot = managedRootFrom(pi, options);
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
              group: requireManagedName(skill.group, 'learn skill "group"'),
              name: requireManagedName(skill.name, "learn skill name"),
            }
          : skill;
      if (scope === "global" && managedSkill?.action === "create" && managedSkill.group) {
        if (!groupStore.isGroup(managedSkill.group)) {
          assertGroupNotShadowed(pi, managedRoot, managedSkill.group);
        }
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
          knownGroups.add(group);
          return managedSkillOutcome(
            managedSkill.action,
            managedSkill.name,
            group,
            managedRoot,
            true,
            memoryResult,
            result.path,
            false,
            undefined,
          );
        } catch (error) {
          return managedSkillOutcome(
            managedSkill.action,
            managedSkill.name,
            group,
            managedRoot,
            true,
            memoryResult,
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
        const group = requireManagedName(manageParams.group, 'manage_skill "group"');
        const name = requireManagedName(manageParams.name, "manage_skill name");
        if (manageParams.action === "create" && !groupStore.isGroup(group)) {
          assertGroupNotShadowed(pi, managedRoot, group);
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
          knownGroups.add(group);
          return managedSkillOutcome(
            manageParams.action,
            name,
            group,
            managedRoot,
            false,
            undefined,
            result.path,
            false,
            undefined,
          );
        } catch (error) {
          return managedSkillOutcome(
            manageParams.action,
            name,
            group,
            managedRoot,
            false,
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
    description:
      "Scan managed skill groups; enter this command in an interactive/RPC session to refresh discovery via /reload-plugins.",
    handler: (_args, _ctx) => {
      scanManagedGroups();
      throw new Error(
        "Managed skill groups were scanned, but discovery was not reloaded. " +
        "In an interactive/RPC session, enter /refresh-managed-skills; otherwise start a new session.",
      );
    },
  });

  pi.on("input", event => {
    const text = event.text;
    if (typeof text !== "string" || !/^\/refresh-managed-skills(?:\s+refresh)?\s*$/.test(text)) {
      return;
    }
    scanManagedGroups();
    return { text: "/reload-plugins" };
  });

  pi.on("tool_call", event => {
    const group = managedGroupForRead(pi, managedRoot, event);
    if (!group) return;
    try {
      const isGroup = groupStore.isGroup(group);
      if (!isGroup) {
        if (!knownGroups.has(group)) return;
        return {
          block: true,
          reason: `Managed skill group "${group}" no longer has a valid index; resolve the conflict and refresh managed skills.`,
        };
      }
      knownGroups.add(group);
      groupStore.refresh(group);
    } catch (error) {
      return {
        block: true,
        reason: `Managed skill group "${group}" could not refresh before read: ${errorReason(error)}`,
      };
    }
  });
}

export default function autoLearnScopeExtension(pi: HostPi, options?: AutoLearnScopeOptions): void {
  installAutoLearnScope(pi, options);
}
