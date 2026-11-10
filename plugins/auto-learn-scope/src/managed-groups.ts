import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { withFileLockSync } from "@oh-my-pi/pi-utils";
import {
  MAX_PROJECT_SKILL_BYTES,
  sanitizeManagedDescription,
  sanitizeSkillName,
  toSkillFrontmatter,
} from "./project-skills";

const SKILL_FILE_NAME = "SKILL.md";
const GROUP_MARKER = "<!-- auto-learn-scope managed skill group index -->";
const TEMP_FILE_PREFIX = ".managed-skill.tmp-";

type WriteStatus = "not-written" | "written" | "unknown";

export interface ManagedGroupInput {
  group: string;
  action: "create" | "update" | "delete";
  name: string;
  description?: string;
  body?: string;
}

export interface ManagedGroupStore {
  scan(): void;
  refresh(group: string): void;
  mutate(input: ManagedGroupInput): { path: string };
  isGroup(group: string): boolean;
}

export type ManagedGroupError = Error & {
  skillStatus: WriteStatus;
  indexStatus: WriteStatus;
  path: string;
  skillPath: string;
  indexPath: string;
};

type GroupMember = {
  name: string;
  description: string;
  directory: string;
  directoryPath: string;
  file: string;
  directoryStat: Stats;
  fileStat: Stats;
  writable: boolean;
};

type GroupSnapshot = {
  name: string;
  directory: string;
  directoryStat: Stats | null;
  index: string;
  indexStat: Stats | null;
  indexContents: string | null;
  members: GroupMember[];
};

let temporaryFileCounter = 0;

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function lstatOrNull(value: string): Stats | null {
  try {
    return lstatSync(value);
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function makeError(
  group: string,
  action: string,
  reason: string,
  targetPath: string,
  skillPath: string,
  indexPath: string,
  skillStatus: WriteStatus = "not-written",
  indexStatus: WriteStatus = "not-written",
): ManagedGroupError {
  const error = new Error(`Cannot ${action} managed skill group "${group}": ${reason}`) as ManagedGroupError;
  error.skillStatus = skillStatus;
  error.indexStatus = indexStatus;
  error.path = targetPath;
  error.skillPath = skillPath;
  error.indexPath = indexPath;
  return error;
}
function mergeWriteStatus(left: WriteStatus, right: WriteStatus): WriteStatus {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "written" || right === "written") return "written";
  return "not-written";
}

function ensureManagedError(
  error: unknown,
  group: string,
  action: string,
  targetPath: string,
  skillPath: string,
  indexPath: string,
  skillStatus: WriteStatus = "not-written",
  indexStatus: WriteStatus = "not-written",
): ManagedGroupError {
  if (
    error instanceof Error &&
    "skillStatus" in error &&
    "indexStatus" in error &&
    "path" in error &&
    "skillPath" in error &&
    "indexPath" in error
  ) {
    const managedError = error as ManagedGroupError;
    managedError.skillStatus = mergeWriteStatus(managedError.skillStatus, skillStatus);
    managedError.indexStatus = mergeWriteStatus(managedError.indexStatus, indexStatus);
    return managedError;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return makeError(group, action, reason, targetPath, skillPath, indexPath, skillStatus, indexStatus);
}

function sanitizeGroupName(raw: unknown, root: string): string {
  try {
    return sanitizeSkillName(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw makeError(
      typeof raw === "string" ? raw : "<invalid>",
      "access",
      message,
      root,
      root,
      root,
    );
  }
}

function normalizeMemberName(raw: unknown, group: string, file: string, index: string): string {
  try {
    return sanitizeSkillName(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, "scan", `invalid skill name in frontmatter at ${file}: ${reason}`, file, file, index);
  }
}

function parseFrontmatter(
  content: string,
  group: string,
  file: string,
  action: string,
  skillPath: string,
  indexPath: string,
): Record<string, unknown> {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw makeError(group, action, `SKILL.md at ${file} has no valid YAML frontmatter.`, file, skillPath, indexPath);
  }

  let value: unknown;
  try {
    value = YAML.parse(match[1]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, action, `frontmatter at ${file} is not valid YAML: ${reason}`, file, skillPath, indexPath);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw makeError(group, action, `frontmatter at ${file} must be a YAML mapping.`, file, skillPath, indexPath);
  }
  return value as Record<string, unknown>;
}

function assertSafeRoot(root: string, group: string, action: string, allowMissing: boolean): boolean {
  const stat = lstatOrNull(root);
  if (stat === null) {
    if (allowMissing) return false;
    throw makeError(group, action, "the managed-skills root does not exist.", root, root, root);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw makeError(group, action, "the managed-skills root is not a safe directory.", root, root, root);
  }
  try {
    realpathSync(root);
  } catch {
    throw makeError(group, action, "the managed-skills root could not be resolved safely.", root, root, root);
  }
  return true;
}

function assertCanonicalWithin(
  root: string,
  candidate: string,
  group: string,
  action: string,
  skillPath: string = candidate,
  indexPath: string = path.join(root, group, SKILL_FILE_NAME),
): void {
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalCandidate = realpathSync(candidate);
    if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
      throw makeError(group, action, `${candidate} resolves outside the managed-skills root.`, candidate, skillPath, indexPath);
    }
  } catch (error) {
    if (error instanceof Error && "skillStatus" in error) throw error;
    throw makeError(group, action, `${candidate} could not be resolved safely.`, candidate, skillPath, indexPath);
  }
}

function readMember(
  root: string,
  group: string,
  directoryName: string,
  action: string,
): GroupMember | null {
  const directoryPath = path.join(root, group, directoryName);
  let directoryStat: Stats | null;
  try {
    directoryStat = lstatOrNull(directoryPath);
  } catch (error) {
    throw ensureManagedError(error, group, action, directoryPath, path.join(directoryPath, SKILL_FILE_NAME), path.join(root, group, SKILL_FILE_NAME));
  }
  if (directoryStat === null || (!directoryStat.isDirectory() && !directoryStat.isSymbolicLink())) return null;

  const file = path.join(directoryPath, SKILL_FILE_NAME);
  let fileStat: Stats | null;
  try {
    fileStat = lstatOrNull(file);
  } catch (error) {
    throw ensureManagedError(error, group, action, file, file, path.join(root, group, SKILL_FILE_NAME));
  }
  if (fileStat === null) return null;
  if (directoryStat.isDirectory()) assertCanonicalWithin(root, directoryPath, group, action);

  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, action, `could not read member SKILL.md at ${file}: ${reason}`, file, file, path.join(root, group, SKILL_FILE_NAME));
  }
  const parsed = parseFrontmatter(content, group, file, action, file, path.join(root, group, SKILL_FILE_NAME));
  if (typeof parsed.name !== "string") {
    throw makeError(group, action, `member SKILL.md at ${file} must have a frontmatter name.`, file, file, path.join(root, group, SKILL_FILE_NAME));
  }
  const name = normalizeMemberName(parsed.name, group, file, path.join(root, group, SKILL_FILE_NAME));
  if (typeof parsed.description !== "string") {
    throw makeError(group, action, `member SKILL.md at ${file} must have a frontmatter description.`, file, file, path.join(root, group, SKILL_FILE_NAME));
  }
  const description = parsed.description;
  if (!description.trim()) {
    throw makeError(group, action, `member SKILL.md at ${file} has an empty description.`, file, file, path.join(root, group, SKILL_FILE_NAME));
  }

  return {
    name,
    description,
    directory: directoryName,
    directoryPath,
    file,
    directoryStat,
    fileStat,
    writable: directoryStat.isDirectory() && !directoryStat.isSymbolicLink() && fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.nlink === 1,
  };
}

function readGroupMembers(root: string, group: string, action: string): GroupMember[] {
  const directory = path.join(root, group);
  let children: string[];
  try {
    children = readdirSync(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, action, `could not scan group directory ${directory}: ${reason}`, directory, path.join(directory, SKILL_FILE_NAME), path.join(directory, SKILL_FILE_NAME));
  }

  const members: GroupMember[] = [];
  for (const child of children) {
    if (child === SKILL_FILE_NAME || child.startsWith(TEMP_FILE_PREFIX)) continue;
    const member = readMember(root, group, child, action);
    if (member) members.push(member);
  }
  members.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0);

  const seen = new Map<string, GroupMember>();
  for (const member of members) {
    const previous = seen.get(member.name);
    if (previous) {
      throw makeError(
        group,
        action,
        `duplicate skill name "${member.name}" conflicts between ${previous.file} and ${member.file}.`,
        member.file,
        member.file,
        path.join(directory, SKILL_FILE_NAME),
      );
    }
    seen.set(member.name, member);
  }
  return members;
}

function topLevelIndexIsMarked(root: string, group: string): boolean {
  const index = path.join(root, group, SKILL_FILE_NAME);
  try {
    const stat = lstatOrNull(index);
    if (!stat) return false;
    return readFileSync(index, "utf8").includes(GROUP_MARKER);
  } catch {
    return false;
  }
}

function hasDirectMemberSkills(directory: string): boolean {
  let children: string[];
  try {
    children = readdirSync(directory);
  } catch {
    return false;
  }
  for (const child of children) {
    if (child === SKILL_FILE_NAME) continue;
    const childPath = path.join(directory, child);
    try {
      const stat = lstatOrNull(childPath);
      if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
      if (lstatOrNull(path.join(childPath, SKILL_FILE_NAME))) return true;
    } catch {
      // Unreadable ordinary entries are not enough evidence to treat a skill as a group.
    }
  }
  return false;
}

function isGroupCandidate(root: string, group: string): boolean {
  const directory = path.join(root, group);
  let stat: Stats | null;
  try {
    stat = lstatOrNull(directory);
  } catch {
    return false;
  }
  if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) return false;

  let indexStat: Stats | null;
  try {
    indexStat = lstatOrNull(path.join(directory, SKILL_FILE_NAME));
  } catch {
    return false;
  }
  if (indexStat?.isFile()) return topLevelIndexIsMarked(root, group);
  if (indexStat?.isSymbolicLink() && topLevelIndexIsMarked(root, group)) return true;
  return hasDirectMemberSkills(directory);
}

function validateGroupIndex(snapshot: GroupSnapshot, action: string): void {
  if (!snapshot.indexStat) return;
  if (snapshot.indexStat.isSymbolicLink()) {
    throw makeError(snapshot.name, action, `group index ${snapshot.index} is a symlink; refusing to replace its target.`, snapshot.index, snapshot.index, snapshot.index);
  }
  if (!snapshot.indexStat.isFile()) {
    throw makeError(snapshot.name, action, `group index ${snapshot.index} is not a regular file.`, snapshot.index, snapshot.index, snapshot.index);
  }
  const contents = snapshot.indexContents ?? "";
  if (!contents.includes(GROUP_MARKER)) {
    if (snapshot.members.length > 0) {
      throw makeError(snapshot.name, action, `group index ${snapshot.index} is unmarked user data; refusing to overwrite it.`, snapshot.index, snapshot.index, snapshot.index);
    }
    throw makeError(snapshot.name, action, `SKILL.md at ${snapshot.index} is not a marked managed group index.`, snapshot.index, snapshot.index, snapshot.index);
  }
  const frontmatter = parseFrontmatter(contents, snapshot.name, snapshot.index, action, snapshot.index, snapshot.index);
  if (frontmatter.name !== snapshot.name) {
    throw makeError(snapshot.name, action, `group index name must match directory name "${snapshot.name}".`, snapshot.index, snapshot.index, snapshot.index);
  }
  if (typeof frontmatter.description !== "string") {
    throw makeError(snapshot.name, action, `group index ${snapshot.index} must have a description.`, snapshot.index, snapshot.index, snapshot.index);
  }
}

function inspectGroup(
  root: string,
  group: string,
  action: string,
  allowEmpty: boolean,
): GroupSnapshot | null {
  if (!assertSafeRoot(root, group, action, true)) return null;
  const directory = path.join(root, group);
  const directoryStat = lstatOrNull(directory);
  if (directoryStat === null) {
    if (allowEmpty) {
      return {
        name: group,
        directory,
        directoryStat: null,
        index: path.join(directory, SKILL_FILE_NAME),
        indexStat: null,
        indexContents: null,
        members: [],
      };
    }
    return null;
  }
  if (directoryStat.isSymbolicLink()) {
    throw makeError(group, action, `group directory ${directory} is a symlink; refusing to follow it for writes.`, directory, directory, path.join(directory, SKILL_FILE_NAME));
  }
  if (!directoryStat.isDirectory()) {
    throw makeError(group, action, `group path ${directory} is not a directory.`, directory, directory, path.join(directory, SKILL_FILE_NAME));
  }
  assertCanonicalWithin(root, directory, group, action);

  const index = path.join(directory, SKILL_FILE_NAME);
  let indexStat: Stats | null;
  let indexContents: string | null = null;
  try {
    indexStat = lstatOrNull(index);
    if (indexStat && !indexStat.isSymbolicLink() && indexStat.isFile()) {
      indexContents = readFileSync(index, "utf8");
    } else if (indexStat?.isSymbolicLink()) {
      // Keep link targets read-only while determining whether this is a marked empty group.
      try {
        indexContents = readFileSync(index, "utf8");
      } catch {
        indexContents = null;
      }
    }
  } catch (error) {
    throw ensureManagedError(error, group, action, index, index, index);
  }

  const members = readGroupMembers(root, group, action);
  if (indexStat) {
    if (indexStat.isSymbolicLink()) {
      if (members.length > 0 || indexContents?.includes(GROUP_MARKER)) {
        throw makeError(group, action, `group index ${index} is a symlink; refusing to replace its target.`, index, index, index);
      }
      if (!allowEmpty) return null;
      throw makeError(group, action, `SKILL.md at ${index} is a symlinked non-group skill and conflicts with group "${group}".`, index, index, index);
    }
    if (indexContents?.includes(GROUP_MARKER)) {
      const snapshot: GroupSnapshot = { name: group, directory, directoryStat, index, indexStat, indexContents, members };
      validateGroupIndex(snapshot, action);
      return snapshot;
    }
    if (members.length > 0) {
      throw makeError(group, action, `group index ${index} is unmarked user data; refusing to overwrite it.`, index, index, index);
    }
    if (!allowEmpty) return null;
    throw makeError(group, action, `SKILL.md at ${index} is unmarked user data and conflicts with group "${group}".`, index, index, index);
  }

  if (members.length === 0 && !allowEmpty) return null;
  return { name: group, directory, directoryStat, index, indexStat: null, indexContents: null, members };
}

function encodeSkillUriSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildGroupIndex(group: string, members: GroupMember[]): string {
  const summary = members.length === 0
    ? `${group} managed skills.`
    : `${group}: ${members.map(member => member.description).join(" ")}`;
  const description = Array.from(sanitizeManagedDescription(summary)).slice(0, 200).join("");
  const sections = members.length === 0
    ? "No skills are currently in this group."
    : members.map(member => `- ${member.name}: ${member.description}\n  Read: skill://${encodeSkillUriSegment(group)}/${encodeSkillUriSegment(member.directory)}/SKILL.md`).join("\n");
  return `${toSkillFrontmatter(group, description)}\n${GROUP_MARKER}\n\n# ${group}\n\n${sections}\n`;
}

function openTemporaryFile(directory: string, mode = 0o666): { file: string; descriptor: number } {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = `${process.pid}-${temporaryFileCounter++}-${randomBytes(12).toString("hex")}`;
    const file = path.join(directory, `${TEMP_FILE_PREFIX}${suffix}`);
    try {
      return { file, descriptor: openSync(file, "wx", mode) };
    } catch (error) {
      if (codeOf(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("temporary managed-skill filename collision");
}

function removeTemporaryFile(file: string | undefined): void {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") return;
  }
}

function writeTemporaryFile(file: string, descriptor: number, content: string, mode?: number): void {
  writeFileSync(descriptor, content, "utf8");
  if (mode !== undefined) chmodSync(file, mode & 0o7777);
  fsyncSync(descriptor);
}

function assertSameDirectory(
  snapshot: GroupSnapshot,
  root: string,
  action: string,
  skillPath: string = snapshot.index,
): void {
  const current = lstatOrNull(snapshot.directory);
  if (!current || !snapshot.directoryStat || current.isSymbolicLink() || !current.isDirectory() || !sameFileIdentity(snapshot.directoryStat, current)) {
    throw makeError(snapshot.name, action, "the group directory changed while the operation was in progress.", snapshot.directory, skillPath, snapshot.index);
  }
  assertCanonicalWithin(root, snapshot.directory, snapshot.name, action, skillPath, snapshot.index);
}

function writeGroupIndex(
  root: string,
  snapshot: GroupSnapshot,
  action: string,
  skillStatus: WriteStatus,
  skillPath: string = snapshot.index,
): void {
  const content = buildGroupIndex(snapshot.name, snapshot.members);
  if (snapshot.indexContents === content) return;

  let temporaryFile: string | undefined;
  let descriptor: number | undefined;
  let committed = false;
  let expectedStat: Stats | null = null;
  try {
    assertSameDirectory(snapshot, root, action, skillPath);
    const current = lstatOrNull(snapshot.index);
    if (snapshot.indexStat) {
      if (
        !current ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFileIdentity(snapshot.indexStat, current)
      ) {
        throw makeError(snapshot.name, action, `group index ${snapshot.index} changed while rebuilding.`, snapshot.index, skillPath, snapshot.index, skillStatus, "not-written");
      }
      if (current.nlink > 1) {
        throw makeError(snapshot.name, action, `group index ${snapshot.index} has ${current.nlink} hard links; refusing to replace a shared inode.`, snapshot.index, skillPath, snapshot.index, skillStatus, "not-written");
      }
      if (snapshot.indexContents === content) return;
    } else if (current !== null) {
      throw makeError(snapshot.name, action, `group index ${snapshot.index} appeared while rebuilding; refusing to overwrite it.`, snapshot.index, skillPath, snapshot.index, skillStatus, "not-written");
    }

    const opened = openTemporaryFile(snapshot.directory);
    temporaryFile = opened.file;
    descriptor = opened.descriptor;
    writeTemporaryFile(temporaryFile, descriptor, content, snapshot.indexStat?.mode);
    closeSync(descriptor);
    descriptor = undefined;
    expectedStat = lstatSync(temporaryFile);
    if (!expectedStat.isFile() || expectedStat.nlink !== 1) {
      throw makeError(snapshot.name, action, "the temporary group index is not a private regular file.", temporaryFile, skillPath, snapshot.index, skillStatus, "not-written");
    }

    assertSameDirectory(snapshot, root, action, skillPath);
    const beforeCommit = lstatOrNull(snapshot.index);
    if (snapshot.indexStat) {
      if (
        !beforeCommit ||
        beforeCommit.isSymbolicLink() ||
        !beforeCommit.isFile() ||
        beforeCommit.nlink > 1 ||
        !sameFileIdentity(snapshot.indexStat, beforeCommit)
      ) {
        throw makeError(snapshot.name, action, `group index ${snapshot.index} changed before atomic replacement.`, snapshot.index, skillPath, snapshot.index, skillStatus, "not-written");
      }
      renameSync(temporaryFile, snapshot.index);
      temporaryFile = undefined;
      committed = true;
    } else {
      if (beforeCommit !== null) {
        throw makeError(snapshot.name, action, `group index ${snapshot.index} appeared before creation.`, snapshot.index, skillPath, snapshot.index, skillStatus, "not-written");
      }
      linkSync(temporaryFile, snapshot.index);
      committed = true;
      unlinkSync(temporaryFile);
      temporaryFile = undefined;
    }

    const written = lstatOrNull(snapshot.index);
    if (!written || written.isSymbolicLink() || !written.isFile() || written.nlink !== 1 || !sameFileIdentity(expectedStat, written)) {
      throw makeError(snapshot.name, action, `group index ${snapshot.index} could not be verified after writing.`, snapshot.index, skillPath, snapshot.index, skillStatus, "unknown");
    }
    assertSameDirectory(snapshot, root, action, skillPath);
  } catch (error) {
    throw ensureManagedError(
      error,
      snapshot.name,
      action,
      snapshot.index,
      skillPath,
      snapshot.index,
      skillStatus,
      committed ? "unknown" : "not-written",
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original failure is more useful than a second close error.
      }
    }
    removeTemporaryFile(temporaryFile);
  }
}

function refreshGroupLocked(root: string, group: string, action: string, skillStatus: WriteStatus): void {
  const snapshot = inspectGroup(root, group, action, false);
  if (!snapshot) return;
  writeGroupIndex(root, snapshot, action, skillStatus);
}

function makeGroupMemberContent(
  group: string,
  name: string,
  description: unknown,
  body: unknown,
  action: string,
  root: string,
): string {
  const groupDirectory = path.join(root, group);
  const index = path.join(groupDirectory, SKILL_FILE_NAME);
  const file = path.join(groupDirectory, name, SKILL_FILE_NAME);
  if (typeof description !== "string" || typeof body !== "string") {
    throw makeError(group, action, "a non-empty description and body are required.", file, file, index);
  }
  const cleanedDescription = sanitizeManagedDescription(description);
  const cleanedBody = body.trim();
  if (!cleanedDescription) {
    throw makeError(group, action, "a non-empty description is required after prompt-safe cleaning.", file, file, index);
  }
  if (!cleanedBody) {
    throw makeError(group, action, "a non-empty body is required.", file, file, index);
  }
  const content = `${toSkillFrontmatter(name, cleanedDescription)}\n${cleanedBody}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PROJECT_SKILL_BYTES) {
    throw makeError(group, action, `the final UTF-8 skill file is ${bytes} bytes; the limit is ${MAX_PROJECT_SKILL_BYTES} bytes.`, file, file, index);
  }
  return content;
}

function ensureRootDirectory(root: string, group: string, action: string): void {
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, action, `the managed-skills root could not be created safely: ${reason}`, root, root, root);
  }
  assertSafeRoot(root, group, action, false);
}

function ensureGroupDirectory(root: string, group: string, action: string): boolean {
  const directory = path.join(root, group);
  const existing = lstatOrNull(directory);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw makeError(group, action, `group directory ${directory} is a symlink; refusing to follow it.`, directory, directory, path.join(directory, SKILL_FILE_NAME));
    }
    if (!existing.isDirectory()) {
      throw makeError(group, action, `group path ${directory} is not a directory.`, directory, directory, path.join(directory, SKILL_FILE_NAME));
    }
    assertCanonicalWithin(root, directory, group, action);
    return false;
  }
  let createdByThisCall = false;
  try {
    mkdirSync(directory);
    createdByThisCall = true;
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError(group, action, `group directory could not be created safely: ${reason}`, directory, directory, path.join(directory, SKILL_FILE_NAME));
    }
  }
  const created = lstatOrNull(directory);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw makeError(group, action, `group directory ${directory} was not created as a safe directory.`, directory, directory, path.join(directory, SKILL_FILE_NAME));
  }
  assertCanonicalWithin(root, directory, group, action);
  return createdByThisCall;
}

function ensureMemberDirectory(snapshot: GroupSnapshot, name: string, action: string): { path: string; stat: Stats } {
  assertSameDirectory(snapshot, path.dirname(snapshot.directory), action);
  const directory = path.join(snapshot.directory, name);
  const existing = lstatOrNull(directory);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw makeError(snapshot.name, action, `member directory ${directory} is a symlink; refusing to write through it.`, directory, path.join(directory, SKILL_FILE_NAME), snapshot.index);
    }
    throw makeError(snapshot.name, action, `member directory ${directory} already exists; refusing to overwrite it.`, directory, path.join(directory, SKILL_FILE_NAME), snapshot.index);
  }
  try {
    mkdirSync(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(snapshot.name, action, `member directory could not be created safely: ${reason}`, directory, path.join(directory, SKILL_FILE_NAME), snapshot.index);
  }
  const stat = lstatOrNull(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw makeError(snapshot.name, action, `member directory ${directory} was not created as a safe directory.`, directory, path.join(directory, SKILL_FILE_NAME), snapshot.index);
  }
  assertCanonicalWithin(path.dirname(snapshot.directory), directory, snapshot.name, action);
  return { path: directory, stat };
}
function createMemberFile(
  snapshot: GroupSnapshot,
  directory: { path: string; stat: Stats },
  content: string,
  action: string,
): string {
  const file = path.join(directory.path, SKILL_FILE_NAME);
  let temporaryFile: string | undefined;
  let descriptor: number | undefined;
  let committed = false;
  let expectedStat: Stats | null = null;
  try {
    const existing = lstatOrNull(file);
    if (existing) {
      throw makeError(snapshot.name, action, `member SKILL.md ${file} already exists; refusing to overwrite it.`, file, file, snapshot.index);
    }
    const opened = openTemporaryFile(directory.path);
    temporaryFile = opened.file;
    descriptor = opened.descriptor;
    writeTemporaryFile(temporaryFile, descriptor, content);
    closeSync(descriptor);
    descriptor = undefined;
    expectedStat = lstatSync(temporaryFile);
    if (!expectedStat.isFile() || expectedStat.nlink !== 1) {
      throw makeError(snapshot.name, action, "the temporary member file is not a private regular file.", temporaryFile, file, snapshot.index);
    }
    assertSameDirectory(snapshot, path.dirname(snapshot.directory), action);
    const currentDirectory = lstatOrNull(directory.path);
    if (!currentDirectory || currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || !sameFileIdentity(directory.stat, currentDirectory)) {
      throw makeError(snapshot.name, action, `member directory ${directory.path} changed while creating the skill.`, directory.path, file, snapshot.index);
    }
    if (lstatOrNull(file) !== null) {
      throw makeError(snapshot.name, action, `member SKILL.md ${file} appeared while creating the skill.`, file, file, snapshot.index);
    }
    linkSync(temporaryFile, file);
    committed = true;
    unlinkSync(temporaryFile);
    temporaryFile = undefined;
    const written = lstatOrNull(file);
    if (!written || written.isSymbolicLink() || !written.isFile() || written.nlink !== 1 || !sameFileIdentity(expectedStat, written)) {
      throw makeError(snapshot.name, action, `member SKILL.md ${file} could not be verified after writing.`, file, file, snapshot.index, "unknown", "not-written");
    }
    return file;
  } catch (error) {
    throw ensureManagedError(error, snapshot.name, action, file, file, snapshot.index, committed ? "written" : "not-written", "not-written");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the originating error.
      }
    }
    removeTemporaryFile(temporaryFile);
  }
}

function assertWritableMember(snapshot: GroupSnapshot, member: GroupMember, root: string, action: string): Stats {
  if (!member.writable) {
    const reason = member.directoryStat.isSymbolicLink()
      ? "the member directory is a symlink; refusing to write through it."
      : member.fileStat.isSymbolicLink()
        ? "member SKILL.md is a symlink; refusing to overwrite its target."
        : member.fileStat.nlink > 1
          ? `member SKILL.md has ${member.fileStat.nlink} hard links; refusing to overwrite a shared inode.`
          : "member SKILL.md is not a private regular file.";
    throw makeError(snapshot.name, action, reason, member.file, member.file, snapshot.index);
  }
  assertSameDirectory(snapshot, root, action);
  const currentDirectory = lstatOrNull(member.directoryPath);
  if (!currentDirectory || currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || !sameFileIdentity(member.directoryStat, currentDirectory)) {
    throw makeError(snapshot.name, action, `member directory ${member.directoryPath} changed while the operation was in progress.`, member.file, member.file, snapshot.index);
  }
  assertCanonicalWithin(root, member.directoryPath, snapshot.name, action);
  const currentFile = lstatOrNull(member.file);
  if (!currentFile || currentFile.isSymbolicLink() || !currentFile.isFile() || currentFile.nlink > 1 || !sameFileIdentity(member.fileStat, currentFile)) {
    throw makeError(snapshot.name, action, `member SKILL.md ${member.file} changed or is linked; refusing to replace it.`, member.file, member.file, snapshot.index);
  }
  return currentFile;
}

function updateMemberFile(
  root: string,
  snapshot: GroupSnapshot,
  member: GroupMember,
  content: string,
  action: string,
): void {
  const original = assertWritableMember(snapshot, member, root, action);
  let temporaryFile: string | undefined;
  let descriptor: number | undefined;
  let committed = false;
  let expectedStat: Stats | null = null;
  try {
    const opened = openTemporaryFile(member.directoryPath);
    temporaryFile = opened.file;
    descriptor = opened.descriptor;
    writeTemporaryFile(temporaryFile, descriptor, content, original.mode);
    closeSync(descriptor);
    descriptor = undefined;
    expectedStat = lstatSync(temporaryFile);
    if (!expectedStat.isFile() || expectedStat.nlink !== 1) {
      throw makeError(snapshot.name, action, "the temporary member file is not a private regular file.", temporaryFile, member.file, snapshot.index);
    }

    assertWritableMember(snapshot, member, root, action);
    const beforeRename = lstatOrNull(member.file);
    if (!beforeRename || !sameFileIdentity(original, beforeRename) || beforeRename.isSymbolicLink() || beforeRename.nlink > 1) {
      throw makeError(snapshot.name, action, `member SKILL.md ${member.file} changed before atomic replacement.`, member.file, member.file, snapshot.index);
    }
    renameSync(temporaryFile, member.file);
    temporaryFile = undefined;
    committed = true;

    const written = lstatOrNull(member.file);
    if (!written || written.isSymbolicLink() || !written.isFile() || written.nlink !== 1 || !sameFileIdentity(expectedStat, written)) {
      throw makeError(snapshot.name, action, `member SKILL.md ${member.file} could not be verified after writing.`, member.file, member.file, snapshot.index, "unknown", "not-written");
    }
  } catch (error) {
    throw ensureManagedError(error, snapshot.name, action, member.file, member.file, snapshot.index, committed ? "written" : "not-written", "not-written");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the originating error.
      }
    }
    removeTemporaryFile(temporaryFile);
  }
}

function deleteMemberDirectory(root: string, snapshot: GroupSnapshot, member: GroupMember, action: string): void {
  assertWritableMember(snapshot, member, root, action);
  try {
    rmSync(member.directoryPath, { recursive: true, force: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(
      snapshot.name,
      action,
      `member directory ${member.directoryPath} could not be removed safely: ${reason}`,
      member.file,
      member.file,
      snapshot.index,
      "unknown",
      "not-written",
    );
  }
  try {
    if (lstatOrNull(member.directoryPath)) {
      throw makeError(snapshot.name, action, `member directory ${member.directoryPath} still exists after deletion.`, member.file, member.file, snapshot.index, "unknown", "not-written");
    }
  } catch (error) {
    if (error instanceof Error && "skillStatus" in error) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(snapshot.name, action, `member directory ${member.directoryPath} could not be verified after deletion: ${reason}`, member.file, member.file, snapshot.index, "unknown", "not-written");
  }
}

function findMember(snapshot: GroupSnapshot, name: string, action: string): GroupMember {
  const member = snapshot.members.find(candidate => candidate.name === name);
  if (!member) {
    throw makeError(snapshot.name, action, `skill "${name}" does not exist in this group.`, path.join(snapshot.directory, name, SKILL_FILE_NAME), path.join(snapshot.directory, name, SKILL_FILE_NAME), snapshot.index);
  }
  return member;
}

function validateDirectoryGroupName(entry: string, root: string): string {
  let normalized: string;
  try {
    normalized = sanitizeSkillName(entry);
  } catch {
    throw makeError(entry, "scan", `invalid managed skill group directory name "${entry}".`, path.join(root, entry), path.join(root, entry, SKILL_FILE_NAME), path.join(root, entry, SKILL_FILE_NAME));
  }
  if (normalized !== entry) {
    throw makeError(entry, "scan", `managed skill group directory name "${entry}" is not canonical.`, path.join(root, entry), path.join(root, entry, SKILL_FILE_NAME), path.join(root, entry, SKILL_FILE_NAME));
  }
  return entry;
}

export function createManagedGroupStore(rootPath: string): ManagedGroupStore {
  if (typeof rootPath !== "string" || rootPath.trim() === "") {
    throw makeError("<invalid>", "scan", "a managed-skills root directory is required.", String(rootPath), String(rootPath), String(rootPath));
  }
  const root = path.resolve(rootPath);

  function groupIndex(group: string): string {
    return path.join(root, group, SKILL_FILE_NAME);
  }

  function groupSkillPath(group: string, name: string): string {
    return path.join(root, group, name, SKILL_FILE_NAME);
  }
  function isGroup(rawGroup: string): boolean {
    const group = sanitizeGroupName(rawGroup, root);
    if (!assertSafeRoot(root, group, "isGroup", true)) return false;

    const directory = path.join(root, group);
    let directoryStat: Stats | null;
    try {
      directoryStat = lstatOrNull(directory);
    } catch {
      return false;
    }
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    assertCanonicalWithin(root, directory, group, "isGroup");

    const index = groupIndex(group);
    let indexStat: Stats | null;
    try {
      indexStat = lstatOrNull(index);
    } catch {
      return false;
    }
    if (!indexStat || !indexStat.isFile() || indexStat.isSymbolicLink()) return false;

    try {
      return readFileSync(index, "utf8").includes(GROUP_MARKER);
    } catch {
      return false;
    }
  }


  function withGroupLock<T>(group: string, action: string, operation: () => T): T {
    try {
      const lockTarget = path.join(root, `.auto-learn-scope-managed-${group}`);
      return withFileLockSync(lockTarget, operation);
    } catch (error) {
      throw ensureManagedError(error, group, action, groupIndex(group), groupIndex(group), groupIndex(group));
    }
  }

  function scan(): void {
    if (!assertSafeRoot(root, "<scan>", "scan", true)) return;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError("<scan>", "scan", `the managed-skills root could not be scanned: ${reason}`, root, root, root);
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      if (isGroupCandidate(root, entry)) candidates.push(validateDirectoryGroupName(entry, root));
    }
    candidates.sort();

    for (const group of candidates) {
      withGroupLock(group, "scan", () => {
        if (isGroupCandidate(root, group)) refreshGroupLocked(root, group, "scan", "not-written");
      });
    }
  }

  function refresh(rawGroup: string): void {
    const group = sanitizeGroupName(rawGroup, root);
    if (!assertSafeRoot(root, group, "refresh", true)) return;
    if (!isGroupCandidate(root, group)) return;
    withGroupLock(group, "refresh", () => {
      if (isGroupCandidate(root, group)) refreshGroupLocked(root, group, "refresh", "not-written");
    });
  }

  function mutate(input: ManagedGroupInput): { path: string } {
    const group = sanitizeGroupName(input?.group, root);
    const action = input?.action;
    if (action !== "create" && action !== "update" && action !== "delete") {
      throw makeError(group, "mutate", "action must be create, update, or delete.", groupIndex(group), groupIndex(group), groupIndex(group));
    }
    let name: string;
    try {
      name = sanitizeSkillName(input?.name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError(group, action, reason, groupIndex(group), groupIndex(group), groupIndex(group));
    }

    const prepared = action === "delete"
      ? null
      : makeGroupMemberContent(group, name, input?.description, input?.body, action, root);
    const targetSkillPath = groupSkillPath(group, name);
    ensureRootDirectory(root, group, action);

    return withGroupLock(group, action, () => {
      let createdGroupDirectory: string | undefined;
      let createdMemberDirectory: string | undefined;
      let skillStatus: WriteStatus = "not-written";
      try {
        const before = inspectGroup(root, group, action, action === "create");
        if (action === "create") {
          if (!before) {
            throw makeError(group, action, "the group could not be prepared safely.", groupIndex(group), targetSkillPath, groupIndex(group));
          }
          if (before.members.some(member => member.name === name)) {
            throw makeError(group, action, `skill \"${name}\" already exists; use action \"update\" instead.`, targetSkillPath, targetSkillPath, groupIndex(group));
          }
          const memberDirectoryPath = path.join(before.directory, name);
          if (lstatOrNull(memberDirectoryPath)) {
            throw makeError(group, action, `member directory ${memberDirectoryPath} already exists; refusing to overwrite it.`, targetSkillPath, targetSkillPath, groupIndex(group));
          }

          if (ensureGroupDirectory(root, group, action)) createdGroupDirectory = before.directory;
          const snapshot = inspectGroup(root, group, action, true);
          if (!snapshot) {
            throw makeError(group, action, "the group directory disappeared before creation.", before.directory, targetSkillPath, groupIndex(group));
          }
          if (snapshot.members.some(member => member.name === name) || lstatOrNull(memberDirectoryPath)) {
            throw makeError(group, action, `skill \"${name}\" or its target directory already exists.`, targetSkillPath, targetSkillPath, groupIndex(group));
          }
          const memberDirectory = ensureMemberDirectory(snapshot, name, action);
          createdMemberDirectory = memberDirectory.path;
          const file = createMemberFile(snapshot, memberDirectory, prepared!, action);
          skillStatus = "written";
          createdGroupDirectory = undefined;
          createdMemberDirectory = undefined;

          const after = inspectGroup(root, group, action, false);
          if (!after) {
            throw makeError(group, action, "the group disappeared after the skill was written.", groupIndex(group), file, groupIndex(group), "written", "not-written");
          }
          writeGroupIndex(root, after, action, "written", file);
          return { path: file };
        }

        if (!before) {
          throw makeError(group, action, `group \"${group}\" does not exist or has no managed members.`, groupIndex(group), targetSkillPath, groupIndex(group));
        }
        const member = findMember(before, name, action);
        if (action === "update") {
          assertWritableMember(before, member, root, action);
          updateMemberFile(root, before, member, prepared!, action);
          skillStatus = "written";
        } else {
          deleteMemberDirectory(root, before, member, action);
          skillStatus = "written";
        }

        const after = inspectGroup(root, group, action, false);
        if (!after) {
          throw makeError(group, action, "the group disappeared after the skill was changed.", groupIndex(group), member.file, groupIndex(group), "written", "not-written");
        }
        writeGroupIndex(root, after, action, "written", member.file);
        return { path: member.file };
      } catch (error) {
        const errorSkillStatus = mergeWriteStatus(
          error instanceof Error && "skillStatus" in error ? (error as ManagedGroupError).skillStatus : "not-written",
          skillStatus,
        );
        const errorIndexStatus = error instanceof Error && "indexStatus" in error
          ? (error as ManagedGroupError).indexStatus
          : "not-written";
        if (createdMemberDirectory && errorSkillStatus === "not-written") {
          try {
            const file = path.join(createdMemberDirectory, SKILL_FILE_NAME);
            if (!lstatOrNull(file) && readdirSync(createdMemberDirectory).length === 0) {
              rmSync(createdMemberDirectory, { recursive: false, force: false });
            }
          } catch {
            // A failed cleanup must not hide the original operation error.
          }
        }
        if (createdGroupDirectory && errorSkillStatus === "not-written") {
          try {
            if (readdirSync(createdGroupDirectory).length === 0) {
              rmSync(createdGroupDirectory, { recursive: false, force: false });
            }
          } catch {
            // A failed cleanup must not hide the original operation error.
          }
        }
        throw ensureManagedError(
          error,
          group,
          action,
          targetSkillPath,
          targetSkillPath,
          groupIndex(group),
          errorSkillStatus,
          errorIndexStatus,
        );
      }
    });
  }

  const store = { scan, refresh, mutate, isGroup };
  scan();
  return store;
}
