import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  };
};

type HostPi = {
  pi?: HostPiNamespace;
  zod: ZodLike;
  registerTool: (definition: ToolDefinition) => void;
  on: (event: string, handler: ToolHandler) => void;
};

export type AutoLearnScopeOptions = {
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
  action: SkillAction;
  name: string;
  description: string;
  body: string;
};

type ManageParams = {
  action: ManageAction;
  name: string;
  description?: string;
  body?: string;
};

const SCOPE_VALUES = ["global", "project"] as const;
const LEARN_ACTION_VALUES = ["create", "update"] as const;
const MANAGE_ACTION_VALUES = ["create", "update", "delete"] as const;
const NATIVE_MEMORY_BACKENDS = ["hindsight", "mnemopi", "local"] as const;


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
    if (settings === undefined || settings === null || typeof settings.get !== "function") {
      return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
    }

    const getter = settings.get;
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
    return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
  }
}

function contextSettingsAccessor(ctx: unknown): PublicSettingsAccessor | undefined {
  if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) return undefined;
  try {
    const context = ctx as UnknownRecord;
    const settings = context.settings;
    if (settings === undefined || settings === null) return undefined;
    if (typeof settings !== "object" || Array.isArray(settings)) {
      return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
    }
    const getter = (settings as UnknownRecord).get;
    if (typeof getter !== "function") {
      return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
    }
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
    return { kind: "unavailable", get: () => PUBLIC_SETTING_UNAVAILABLE };
  }
}

function autoLearnEnabled(settings: PublicSettingsAccessor): boolean {
  const enabled = settings.get("autolearn.enabled");
  return enabled === true || settings.kind === "missing";
}

function assertAutoLearnEnabled(
  factorySettings: PublicSettingsAccessor,
  ctx: unknown,
  toolName: string,
): void {
  const settings = contextSettingsAccessor(ctx) ?? factorySettings;
  const enabled = settings.get("autolearn.enabled");
  if (enabled === true || settings.kind === "missing") return;
  if (enabled === false) {
    throw new Error(`Auto-learn is disabled; refusing to execute ${toolName}.`);
  }
  throw new Error(`Auto-learn setting is unavailable; refusing to execute ${toolName}.`);
}

const LEARN_DESCRIPTION = [
  "Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.",
  "Use after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.",
  "`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact.",
  "Managed skills: isolated `~/.omp/agent/managed-skills`; surfaced as normal skills next session; NEVER touch user-authored skills.",
  "Frontmatter: generated from `name` and `description`.",
  "Capture sparingly, specifically: one strong reusable lesson > several vague ones.",
  'Scope defaults to "global"; use `scope: "project"` only when the skill should be saved in this repository.',
].join(" ");
const MANAGE_DESCRIPTION = [
  "Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.",
  "Use: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.",
  "User-authored skills separate; tool NEVER edits them.",
  '`action: "create"` — fails if skill exists; `action: "update"` — overwrites body; fails if skill absent; `action: "delete"` — fails if skill absent.',
  "`name`: kebab-case (lowercase letters, digits, hyphens).",
  "`description`: specific; drives discovery.",
  "No frontmatter in `body`; generated from `name` and `description`.",
  'Scope defaults to "global"; `scope: "project"` writes the isolated project skill under this repository instead.',
].join(" ");
const GUIDANCE =
  "Auto-learn guidance: scope defaults to global. Use native memory/learn for durable facts or conventions; use a procedure/skill only when it is reusable. Choose scope=project only when it should be saved in this repository, check whether an existing skill already covers it, and never put secrets or tokens in a skill.";

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
  return {
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
  if (action !== "delete") {
    if (typeof params.description !== "string" || typeof params.body !== "string") {
      throw new Error(`manage_skill "${action}" requires both "description" and "body".`);
    }
  }
  return {
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

function buildSchemas(z: ZodLike): { learn: Schema; manageSkill: Schema } {
  const learnSkill = z.object({
    action: z.enum(LEARN_ACTION_VALUES),
    name: describeSchema(z.string(), "kebab-case skill name"),
    description: describeSchema(z.string(), "one-line description of when to use the skill"),
    body: describeSchema(z.string(), "the SKILL.md body in markdown (no frontmatter)"),
  });
  const learn = z.object({
    memory: describeSchema(z.string(), "the durable, self-contained lesson to remember (what, when, why)"),
    context: optionalSchema(z, describeSchema(z.string(), "optional source context for the lesson")),
    skill: optionalSchema(z, describeSchema(learnSkill, "also create or enhance a managed skill in the same call")),
    scope: optionalSchema(z, describeSchema(z.enum(SCOPE_VALUES), "where the optional skill is persisted; defaults to global")),
  });

  const manageSkill = z.object({
    action: z.enum(MANAGE_ACTION_VALUES),
    name: describeSchema(z.string(), "kebab-case skill name"),
    description: optionalSchema(
      z,
      describeSchema(z.string(), "one-line description of when to use the skill (required for create/update)"),
    ),
    body: optionalSchema(z, describeSchema(z.string(), "the SKILL.md body in markdown, no frontmatter (required for create/update)")),
    scope: optionalSchema(z, describeSchema(z.enum(SCOPE_VALUES), "where the skill is persisted; defaults to global")),
  });
  if (manageSkill !== null && (typeof manageSkill === "object" || typeof manageSkill === "function")) {
    const candidate = manageSkill as ZodLikeSchema;
    if (typeof candidate.refine === "function") {
      return {
        learn,
        manageSkill: candidate.refine(
          value => {
            if (value === null || typeof value !== "object") return false;
            const params = value as UnknownRecord;
            if (params.action === "delete") return true;
            return (
              (params.action === "create" || params.action === "update") &&
              typeof params.description === "string" &&
              typeof params.body === "string"
            );
          },
          'manage_skill create/update require both "description" and "body" as strings.',
        ),
      };
    }
  }
  return { learn, manageSkill };
}

export function installAutoLearnScope(pi: HostPi, options?: AutoLearnScopeOptions): void {
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
    summary: "Capture a reusable lesson to memory (and optionally a project skill)",
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      assertAutoLearnEnabled(factorySettings, ctx, "learn");
      const params = asRecord(rawParams, "learn");
      const scope = validateScope(params);
      const skill = validateLearnParams(params);
      const invoke = requireNative(ctx, "learn");
      const invokeOptions = { signal, onUpdate };

      if (scope === "global") {
        return invoke(omit(params, "scope"), invokeOptions);
      }

      const memoryParams = omit(params, "scope", "skill");
      const memoryResult = await invoke(memoryParams, invokeOptions);
      if (!skill) return memoryResult;

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
    summary: "Create, update, or delete an isolated project or managed skill",
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      assertAutoLearnEnabled(factorySettings, ctx, "manage_skill");
      const params = asRecord(rawParams, "manage_skill");
      const scope = validateScope(params);
      const nativeParams = omit(params, "scope");
      const manageParams = validateManageParams(nativeParams);
      const invoke = requireNative(ctx, "manage_skill");
      const invokeOptions = { signal, onUpdate };

      if (scope === "global") return invoke(nativeParams, invokeOptions);

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
}

export default function autoLearnScopeExtension(pi: HostPi): void {
  installAutoLearnScope(pi);
}
