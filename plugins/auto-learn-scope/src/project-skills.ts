import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";

export const MAX_PROJECT_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROJECT_SKILLS_DIRECTORY = path.join(".omp", "skills");
const SKILL_FILE_NAME = "SKILL.md";
const TEMP_FILE_PREFIX = ".SKILL.md.tmp-";

export interface ProjectSkillInput {
  cwd: string;
  name: string;
  description?: string;
  body?: string;
}

export interface ProjectSkillDeleteInput {
  cwd: string;
  name: string;
}

export interface ProjectSkillWriter {
  create(input: ProjectSkillInput): Promise<{ path: string }>;
  update(input: ProjectSkillInput): Promise<{ path: string }>;
  delete(input: ProjectSkillDeleteInput): Promise<void>;
}

type PreparedSkill = {
  name: string;
  content: string;
};

type ProjectSkillTarget = {
  root: string;
  name: string;
  ompDirectory: string;
  skillsDirectory: string;
  skillDirectory: string;
  file: string;
};


/**
 * The native managed-skill name policy: trim, normalize case, then apply the
 * restrictive single-component allowlist. Keeping this exact shape is what
 * makes the name safe to interpolate into the project skill path.
 */
export function sanitizeSkillName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error(
      "Invalid project skill name. Use letters, digits, and hyphens (1-64 characters, starting with a letter or digit).",
    );
  }
  const name = raw.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      "Invalid project skill name. Use letters, digits, and hyphens (1-64 characters, starting with a letter or digit).",
    );
  }
  return name;
}

/** Keep generated descriptions on one prompt-safe line, matching native OMP. */
export function sanitizeManagedDescription(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>`]/g, "")
    .replace(/~{2,}/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSkillFrontmatter(name: string, description: string): string {
  const frontmatter = YAML.stringify(
    { name, description: sanitizeManagedDescription(description) },
    null,
    2,
  ).trimEnd();
  return `---\n${frontmatter}\n---\n`;
}

function projectError(name: string, action: string, reason: string): Error {
  return new Error(`Cannot ${action} project skill "${name}": ${reason}`);
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertLexicallyContained(root: string, candidate: string, name: string, action: string): void {
  if (!path.isAbsolute(root) || !isPathWithin(root, candidate)) {
    throw projectError(name, action, "the target path is outside the repository root.");
  }
}

function resolveRepositoryRoot(cwd: unknown, name: string, action: string): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw projectError(name, action, "a working directory is required to resolve a Git repository.");
  }

  let gitRoot: string;
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    gitRoot = output.replace(/(?:\r\n|\n|\r)$/u, "");
  } catch {
    throw projectError(name, action, "the working directory is not inside a Git repository.");
  }

  if (!gitRoot) {
    throw projectError(name, action, "Git did not return a repository root.");
  }

  try {
    const lexicalCwd = path.resolve(cwd);
    const canonicalCwd = realpathSync(lexicalCwd);
    const canonicalGitRoot = realpathSync(path.resolve(gitRoot));
    const relativeRoot = path.relative(canonicalCwd, canonicalGitRoot);
    // Resolve Git's canonical root relationship against the caller's lexical
    // cwd so aliases such as macOS /var remain visible to callers.
    const root = path.resolve(lexicalCwd, relativeRoot);
    // A Git command can return a path that disappears before the write starts.
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) throw new Error("not a directory");
    return root;
  } catch {
    throw projectError(name, action, "the Git repository root is unavailable or is not a directory.");
  }
}

async function lstatOrNull(value: string, name: string, action: string): Promise<Stats | null> {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw projectError(name, action, "the target could not be inspected safely.");
  }
}

async function assertCanonicalWithin(
  root: string,
  candidate: string,
  name: string,
  action: string,
  label: string,
): Promise<void> {
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonicalCandidate = await fs.realpath(candidate);
    if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
      throw projectError(name, action, `${label} resolves outside the repository root.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot ")) throw error;
    throw projectError(name, action, `${label} could not be resolved safely.`);
  }
}

async function inspectDirectory(
  target: ProjectSkillTarget,
  directory: string,
  label: string,
  required: boolean,
): Promise<Stats | null> {
  assertLexicallyContained(target.root, directory, target.name, "access");
  const stat = await lstatOrNull(directory, target.name, "access");
  if (stat === null) {
    if (required) {
      throw projectError(target.name, "access", `the ${label} does not exist; use action "create" first.`);
    }
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw projectError(target.name, "access", `the ${label} is a symlink; refusing a path escape.`);
  }
  if (!stat.isDirectory()) {
    throw projectError(target.name, "access", `the ${label} is not a directory.`);
  }
  await assertCanonicalWithin(target.root, directory, target.name, "access", label);
  return stat;
}

async function ensureDirectory(target: ProjectSkillTarget, directory: string, label: string): Promise<void> {
  const existing = await inspectDirectory(target, directory, label, false);
  if (existing !== null) return;

  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw projectError(target.name, "create", `the ${label} could not be created safely.`);
    }
  }

  const created = await inspectDirectory(target, directory, label, true);
  if (created === null) {
    throw projectError(target.name, "create", `the ${label} could not be created safely.`);
  }
}

async function assertRepositoryRoot(target: ProjectSkillTarget, action: string): Promise<void> {
  assertLexicallyContained(target.root, target.ompDirectory, target.name, action);
  const rootStat = await lstatOrNull(target.root, target.name, action);
  if (rootStat === null) {
    throw projectError(target.name, action, "the repository root disappeared.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw projectError(target.name, action, "the repository root is not a safe directory.");
  }
  await assertCanonicalWithin(target.root, target.root, target.name, action, "repository root");
}

async function assertProjectLayout(target: ProjectSkillTarget, action: string, create: boolean): Promise<void> {
  await assertRepositoryRoot(target, action);
  if (create) {
    await ensureDirectory(target, target.ompDirectory, ".omp directory");
    await ensureDirectory(target, target.skillsDirectory, "skills directory");
    await ensureDirectory(target, target.skillDirectory, "skill directory");
    return;
  }

  await inspectDirectory(target, target.ompDirectory, ".omp directory", true);
  await inspectDirectory(target, target.skillsDirectory, "skills directory", true);
  await inspectDirectory(target, target.skillDirectory, "skill directory", true);
}

function buildTarget(root: string, name: string): ProjectSkillTarget {
  const ompDirectory = path.join(root, ".omp");
  const skillsDirectory = path.join(root, PROJECT_SKILLS_DIRECTORY);
  const skillDirectory = path.join(skillsDirectory, name);
  const file = path.join(skillDirectory, SKILL_FILE_NAME);
  return { root, name, ompDirectory, skillsDirectory, skillDirectory, file };
}

function prepareSkill(input: ProjectSkillInput): PreparedSkill {
  const name = sanitizeSkillName(input?.name);
  if (typeof input?.description !== "string") {
    throw projectError(name, "write", "a non-empty description is required.");
  }
  if (typeof input?.body !== "string") {
    throw projectError(name, "write", "a non-empty body is required.");
  }

  const description = sanitizeManagedDescription(input.description);
  const body = input.body.trim();
  if (!description) {
    throw projectError(name, "write", "a non-empty description is required after prompt-safe cleaning.");
  }
  if (!body) {
    throw projectError(name, "write", "a non-empty body is required.");
  }

  const content = `${toSkillFrontmatter(name, description)}\n${body}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PROJECT_SKILL_BYTES) {
    throw projectError(
      name,
      "write",
      `the final UTF-8 file is ${bytes} bytes; the limit is ${MAX_PROJECT_SKILL_BYTES} bytes. Trim the body or description.`,
    );
  }
  return { name, content };
}

const skillMutationChains = new Map<string, Promise<unknown>>();

function serializeSkillMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = skillMutationChains.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => undefined);
  skillMutationChains.set(key, settled);
  void settled.finally(() => {
    if (skillMutationChains.get(key) === settled) skillMutationChains.delete(key);
  });
  return run;
}

function mutationKey(root: string, name: string, action: string): string {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw projectError(name, action, "the repository root is unavailable for mutation serialization.");
  }
  return `${canonicalRoot}\u0000${name}`;
}

async function assertRegularUniqueFile(target: ProjectSkillTarget, action: string): Promise<Stats> {
  const stat = await lstatOrNull(target.file, target.name, action);
  if (stat === null) {
    throw projectError(target.name, action, `the skill does not exist; use action "create" first.`);
  }
  if (stat.isSymbolicLink()) {
    throw projectError(target.name, action, "SKILL.md is a symlink; refusing to overwrite it.");
  }
  if (!stat.isFile()) {
    throw projectError(target.name, action, "SKILL.md is not a regular file; refusing to overwrite it.");
  }
  if (stat.nlink > 1) {
    throw projectError(
      target.name,
      action,
      `SKILL.md has ${stat.nlink} hard links; refusing to overwrite a shared inode.`,
    );
  }
  await assertCanonicalWithin(target.root, target.file, target.name, action, "SKILL.md");
  return stat;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function writeProjectSkillCreate(target: ProjectSkillTarget, content: string): Promise<{ path: string }> {
  await assertProjectLayout(target, "create", true);
  const existing = await lstatOrNull(target.file, target.name, "create");
  if (existing?.isSymbolicLink()) {
    throw projectError(target.name, "create", "SKILL.md is a symlink; refusing a path escape.");
  }
  if (existing !== null) {
    throw projectError(target.name, "create", "the skill already exists; use action \"update\" instead.");
  }
  await assertCanonicalWithin(target.root, target.skillDirectory, target.name, "create", "skill directory");

  try {
    // O_EXCL is the important part here: a concurrent creator cannot turn a
    // check-then-write into an overwrite, and a final symlink is rejected.
    await fs.writeFile(target.file, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (codeOf(error) === "EEXIST") {
      const raced = await lstatOrNull(target.file, target.name, "create");
      if (raced?.isSymbolicLink()) {
        throw projectError(target.name, "create", "SKILL.md is a symlink; refusing a path escape.");
      }
      throw projectError(target.name, "create", "the skill already exists; use action \"update\" instead.");
    }
    if (codeOf(error) === "ELOOP") {
      throw projectError(target.name, "create", "SKILL.md is a symlink; refusing a path escape.");
    }
    throw projectError(target.name, "create", "SKILL.md could not be created safely.");
  }

  const created = await lstatOrNull(target.file, target.name, "create");
  if (created === null || !created.isFile() || created.nlink !== 1) {
    throw projectError(target.name, "create", "SKILL.md was not created as a private regular file.");
  }
  await assertProjectLayout(target, "create", false);
  await assertCanonicalWithin(target.root, target.file, target.name, "create", "SKILL.md");
  return { path: target.file };
}

let temporaryFileCounter = 0;

async function openExclusiveTemporaryFile(directory: string): Promise<{ file: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = `${process.pid}-${temporaryFileCounter++}-${randomBytes(12).toString("hex")}`;
    const file = path.join(directory, `${TEMP_FILE_PREFIX}${suffix}`);
    try {
      const handle = await fs.open(file, "wx", 0o600);
      return { file, handle };
    } catch (error) {
      if (codeOf(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("temporary-name collision");
}

async function removeTemporaryFile(file: string | undefined): Promise<void> {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") return;
  }
}

async function writeProjectSkillUpdate(target: ProjectSkillTarget, content: string): Promise<{ path: string }> {
  await assertProjectLayout(target, "update", false);
  const original = await assertRegularUniqueFile(target, "update");
  let temporaryFile: string | undefined;
  let handle: FileHandle | undefined;

  try {
    try {
      const opened = await openExclusiveTemporaryFile(target.skillDirectory);
      temporaryFile = opened.file;
      handle = opened.handle;
      await handle.writeFile(content, "utf8");
      await handle.chmod(original.mode & 0o7777);
    } catch (error) {
      throw projectError(target.name, "update", "the temporary file could not be written safely.");
    } finally {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
      }
    }

    await assertProjectLayout(target, "update", false);
    const current = await assertRegularUniqueFile(target, "update");
    if (!sameFileIdentity(original, current)) {
      throw projectError(target.name, "update", "SKILL.md changed while updating; retry the action.");
    }

    if (!temporaryFile) {
      throw projectError(target.name, "update", "the temporary file was not created.");
    }
    const temporaryStat = await lstatOrNull(temporaryFile, target.name, "update");
    if (temporaryStat === null || !temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw projectError(target.name, "update", "the temporary file is not a safe regular file.");
    }
    await assertCanonicalWithin(target.root, target.skillDirectory, target.name, "update", "skill directory");
    // Re-check every repository component immediately before rename. The
    // temporary-file write above may have given a concurrent path swap time
    // to replace any component with a symlink or a different target.
    await assertProjectLayout(target, "update", false);
    const beforeRename = await assertRegularUniqueFile(target, "update");
    if (!sameFileIdentity(original, beforeRename)) {
      throw projectError(target.name, "update", "SKILL.md changed while updating; retry the action.");
    }
    await assertCanonicalWithin(target.root, target.skillDirectory, target.name, "update", "skill directory");

    try {
      // rename(2) replaces the old path atomically; unlike truncating the
      // target handle, readers see either the old complete file or the new one.
      await fs.rename(temporaryFile, target.file);
      temporaryFile = undefined;
    } catch {
      throw projectError(target.name, "update", "SKILL.md could not be replaced atomically.");
    }

    await assertProjectLayout(target, "update", false);
    await assertRegularUniqueFile(target, "update");
    return { path: target.file };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await removeTemporaryFile(temporaryFile);
  }
}

async function deleteProjectSkill(target: ProjectSkillTarget): Promise<void> {
  await assertProjectLayout(target, "delete", false);
  const directory = await inspectDirectory(target, target.skillDirectory, "skill directory", true);
  if (directory === null) {
    throw projectError(target.name, "delete", "the skill does not exist.");
  }
  await assertCanonicalWithin(target.root, target.skillDirectory, target.name, "delete", "skill directory");

  try {
    await fs.rm(target.skillDirectory, { recursive: true, force: false });
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      throw projectError(target.name, "delete", "the skill does not exist.");
    }
    throw projectError(target.name, "delete", "the skill directory could not be removed safely.");
  }

  const remaining = await lstatOrNull(target.skillDirectory, target.name, "delete");
  if (remaining !== null) {
    throw projectError(target.name, "delete", "the skill directory still exists after deletion.");
  }
}

export function createProjectSkillWriter(): ProjectSkillWriter {
  return {
    async create(input: ProjectSkillInput): Promise<{ path: string }> {
      const prepared = prepareSkill(input);
      const root = resolveRepositoryRoot(input.cwd, prepared.name, "create");
      const target = buildTarget(root, prepared.name);
      return serializeSkillMutation(mutationKey(root, prepared.name, "create"), () =>
        writeProjectSkillCreate(target, prepared.content),
      );
    },

    async update(input: ProjectSkillInput): Promise<{ path: string }> {
      const prepared = prepareSkill(input);
      const root = resolveRepositoryRoot(input.cwd, prepared.name, "update");
      const target = buildTarget(root, prepared.name);
      return serializeSkillMutation(mutationKey(root, prepared.name, "update"), () =>
        writeProjectSkillUpdate(target, prepared.content),
      );
    },

    async delete(input: ProjectSkillDeleteInput): Promise<void> {
      const name = sanitizeSkillName(input?.name);
      const root = resolveRepositoryRoot(input?.cwd, name, "delete");
      const target = buildTarget(root, name);
      return serializeSkillMutation(mutationKey(root, name, "delete"), () => deleteProjectSkill(target));
    },
  };
}
