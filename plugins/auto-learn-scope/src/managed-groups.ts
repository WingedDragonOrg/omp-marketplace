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
  statSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import * as path from "node:path";
import { parseFrontmatter as parseOmpFrontmatter, withFileLockSync } from "@oh-my-pi/pi-utils";
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

export interface ManagedGroupIndexResult {
  group: string;
  path: string;
  status: WriteStatus;
  needsRebuild: boolean;
  reason?: "failed" | "not-attempted";
}

export interface ManagedGroupMutation {
  path: string;
  indexes: ManagedGroupIndexResult[];
}

export interface ManagedGroupStore {
  scan(): void;
  refresh(group: string): void;
  mutate(input: ManagedGroupInput): ManagedGroupMutation;
  isGroup(group: string): boolean;
}

export type ManagedGroupError = Error & {
  skillStatus: WriteStatus;
  indexStatus: WriteStatus;
  path: string;
  skillPath: string;
  indexPath: string;
  indexes: ManagedGroupIndexResult[];
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

type GroupEntry = {
  kind: "group" | "skill";
  name: string;
  description: string;
  uri: string;
};

type GroupTree = {
  group: string;
  children: GroupTree[];
};

type GroupSnapshot = {
  name: string;
  displayName: string;
  directory: string;
  directoryStat: Stats | null;
  index: string;
  indexStat: Stats | null;
  indexContents: string | null;
  members: GroupMember[];
  childGroups: GroupEntry[];
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
  error.indexes = [];
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
    if (!Array.isArray(managedError.indexes)) managedError.indexes = [];
    managedError.skillStatus = mergeWriteStatus(managedError.skillStatus, skillStatus);
    managedError.indexStatus = mergeWriteStatus(managedError.indexStatus, indexStatus);
    return managedError;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return makeError(group, action, reason, targetPath, skillPath, indexPath, skillStatus, indexStatus);
}

function sanitizeGroupName(raw: unknown, root: string): string {
  try {
    if (typeof raw !== "string" || raw.includes("\\") || raw.startsWith("/") || path.isAbsolute(raw)) {
      throw new Error("group must be a non-empty slash-separated path of valid skill names.");
    }
    const segments = raw.split("/");
    if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
      throw new Error("group must be a non-empty slash-separated path of valid skill names.");
    }
    return segments.map(segment => sanitizeSkillName(segment)).join("/");
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
    value = parseOmpFrontmatter(content.replace(/^\uFEFF/, ""), { level: "fatal", rawKeys: true }).frontmatter;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(group, action, `frontmatter at ${file} is not valid YAML: ${reason}`, file, skillPath, indexPath);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw makeError(group, action, `frontmatter at ${file} must be a YAML mapping.`, file, skillPath, indexPath);
  }
  return value as Record<string, unknown>;
}

function resolveManagedRoot(rootPath: string): string {
  const requestedRoot = path.resolve(rootPath);
  let existing = requestedRoot;
  while (true) {
    if (lstatOrNull(existing)) {
      return path.resolve(realpathSync(existing), path.relative(existing, requestedRoot));
    }
    const parent = path.dirname(existing);
    if (parent === existing) return requestedRoot;
    existing = parent;
  }
}

function assertSafeRoot(root: string, group: string, action: string, allowMissing: boolean): boolean {
  const stat = lstatOrNull(root);
  if (stat === null) {
    if (!allowMissing) {
      throw makeError(group, action, "the managed-skills root does not exist.", root, root, root);
    }
    let ancestor = root;
    let ancestorStat = lstatOrNull(ancestor);
    while (ancestorStat === null) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
      ancestorStat = lstatOrNull(ancestor);
    }
    try {
      if (!ancestorStat || realpathSync(ancestor) !== ancestor) {
        throw makeError(group, action, "the managed-skills root ancestry changed from its startup path.", root, root, root);
      }
    } catch (error) {
      if (error instanceof Error && "skillStatus" in error) throw error;
      throw makeError(group, action, "the managed-skills root ancestry could not be resolved safely.", root, root, root);
    }
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw makeError(group, action, "the managed-skills root is not a safe directory.", root, root, root);
  }
  try {
    if (realpathSync(root) !== root) {
      throw makeError(group, action, "the managed-skills root no longer resolves to its startup path.", root, root, root);
    }
  } catch (error) {
    if (error instanceof Error && "skillStatus" in error) throw error;
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
    if (canonicalRoot !== root) {
      throw makeError(group, action, `${root} no longer resolves to the fixed managed-skills root.`, candidate, skillPath, indexPath);
    }
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

function hasGroupMarker(contents: string): boolean {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/.exec(contents);
  if (!frontmatter) return false;
  return contents.slice(frontmatter[0].length).split(/\r?\n/, 1)[0] === GROUP_MARKER;
}

function readIndexContents(index: string, group: string, action: string): { stat: Stats | null; contents: string | null } {
  try {
    const stat = lstatOrNull(index);
    if (!stat) return { stat: null, contents: null };
    if (stat.isSymbolicLink()) {
      if (!statSync(index).isFile()) return { stat, contents: null };
      return { stat, contents: readFileSync(index, "utf8") };
    }
    if (!stat.isFile()) return { stat, contents: null };
    return { stat, contents: readFileSync(index, "utf8") };
  } catch (error) {
    throw ensureManagedError(error, group, action, index, index, index);
  }
}

function discoverGroupTree(root: string, group: string, action: string): GroupTree | null {
  const directory = path.join(root, group);
  const directoryStat = lstatOrNull(directory);
  if (!directoryStat || (!directoryStat.isDirectory() && !directoryStat.isSymbolicLink())) return null;
  const index = path.join(directory, SKILL_FILE_NAME);
  const indexInfo = readIndexContents(index, group, action);
  if (indexInfo.stat && !indexInfo.stat.isSymbolicLink()) {
    if (!indexInfo.stat.isFile() || !hasGroupMarker(indexInfo.contents ?? "")) return null;
  }
  if (indexInfo.stat?.isSymbolicLink()) {
    if (hasGroupMarker(indexInfo.contents ?? "")) {
      throw makeError(group, action, `group index ${index} is a symlink; refusing to replace its target.`, index, index, index);
    }
    return null;
  }
  let children: string[];
  try {
    children = readdirSync(directory);
  } catch (error) {
    throw ensureManagedError(error, group, action, directory, index, index);
  }
  const childGroups: GroupTree[] = [];
  let hasDirectMembers = false;
  for (const child of children) {
    if (child === SKILL_FILE_NAME || child.startsWith(TEMP_FILE_PREFIX)) continue;
    const childPath = path.join(directory, child);
    const childStat = lstatOrNull(childPath);
    if (!childStat || (!childStat.isDirectory() && !childStat.isSymbolicLink())) continue;
    const childGroup = path.join(group, child);
    const childTree = discoverGroupTree(root, childGroup, action);
    if (childTree) {
      validateDirectoryGroupName(child, root);
      childGroups.push(childTree);
    } else if (lstatOrNull(path.join(childPath, SKILL_FILE_NAME))) {
      hasDirectMembers = true;
    }
  }

  if (!indexInfo.stat && !hasDirectMembers && childGroups.length === 0) return null;
  if (directoryStat.isSymbolicLink()) {
    throw makeError(group, action, `group directory ${directory} is a symlink; refusing to follow it for writes.`, directory, directory, index);
  }
  assertCanonicalWithin(root, directory, group, action);
  return { group, children: childGroups };
}

function discoverDirectChildGroups(root: string, group: string, action: string): GroupTree[] {
  const directory = path.join(root, group);
  let children: string[];
  try {
    children = readdirSync(directory);
  } catch (error) {
    throw ensureManagedError(error, group, action, directory, path.join(directory, SKILL_FILE_NAME), path.join(directory, SKILL_FILE_NAME));
  }
  const groups: GroupTree[] = [];
  for (const child of children) {
    if (child === SKILL_FILE_NAME || child.startsWith(TEMP_FILE_PREFIX)) continue;
    const childPath = path.join(directory, child);
    const childStat = lstatOrNull(childPath);
    if (!childStat || (!childStat.isDirectory() && !childStat.isSymbolicLink())) continue;
    const childTree = discoverGroupTree(root, path.join(group, child), action);
    if (childTree) {
      validateDirectoryGroupName(child, root);
      groups.push(childTree);
    }
  }
  return groups;
}

function readGroupMembers(
  root: string,
  group: string,
  action: string,
  childGroups: GroupTree[],
): GroupMember[] {
  const directory = path.join(root, group);
  let children: string[];
  try {
    children = readdirSync(directory);
  } catch (error) {
    throw ensureManagedError(error, group, action, directory, path.join(directory, SKILL_FILE_NAME), path.join(directory, SKILL_FILE_NAME));
  }

  const groupDirectories = new Set(childGroups.map(child => path.basename(child.group)));
  const members: GroupMember[] = [];
  for (const child of children) {
    if (child === SKILL_FILE_NAME || child.startsWith(TEMP_FILE_PREFIX) || groupDirectories.has(child)) continue;
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

function groupIndexEntry(root: string, child: GroupTree, action: string): GroupEntry {
  const index = path.join(root, child.group, SKILL_FILE_NAME);
  const { stat, contents } = readIndexContents(index, child.group, action);
  let source = contents;
  if (!stat) {
    const snapshot = inspectGroup(root, child.group, action, true);
    if (!snapshot) {
      throw makeError(child.group, action, `group index ${index} could not be generated safely.`, index, index, index);
    }
    source = buildGroupIndex(snapshot);
  } else if (stat.isSymbolicLink() || !stat.isFile() || !hasGroupMarker(contents ?? "")) {
    throw makeError(child.group, action, `group index ${index} is not a valid marked index.`, index, index, index);
  }
  const parsed = parseFrontmatter(source!, child.group, index, action, index, index);
  const displayName = path.basename(child.group);
  if (parsed.name !== displayName || typeof parsed.description !== "string") {
    throw makeError(child.group, action, `group index ${index} has invalid name or description metadata.`, index, index, index);
  }
  const uri = `skill://${child.group.split("/").map(encodeSkillUriSegment).join("/")}/SKILL.md`;
  return { kind: "group", name: displayName, description: parsed.description, uri };
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
  if (!hasGroupMarker(contents)) {
    throw makeError(snapshot.name, action, `group index ${snapshot.index} is unmarked user data; refusing to overwrite it.`, snapshot.index, snapshot.index, snapshot.index);
  }
  const frontmatter = parseFrontmatter(contents, snapshot.name, snapshot.index, action, snapshot.index, snapshot.index);
  if (frontmatter.name !== snapshot.displayName) {
    throw makeError(snapshot.name, action, `group index name must match directory name "${snapshot.displayName}".`, snapshot.index, snapshot.index, snapshot.index);
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
  const index = path.join(directory, SKILL_FILE_NAME);
  if (directoryStat === null) {
    if (!allowEmpty) return null;
    return {
      name: group,
      displayName: path.basename(group),
      directory,
      directoryStat: null,
      index,
      indexStat: null,
      indexContents: null,
      members: [],
      childGroups: [],
    };
  }
  if (directoryStat.isSymbolicLink()) {
    throw makeError(group, action, `group directory ${directory} is a symlink; refusing to follow it for writes.`, directory, directory, index);
  }
  if (!directoryStat.isDirectory()) {
    throw makeError(group, action, `group path ${directory} is not a directory.`, directory, directory, index);
  }
  assertCanonicalWithin(root, directory, group, action);

  const indexInfo = readIndexContents(index, group, action);
  if (indexInfo.stat?.isSymbolicLink()) {
    throw makeError(group, action, `group index ${index} is a symlink; refusing to replace its target.`, index, index, index);
  }
  if (indexInfo.stat && !indexInfo.stat.isFile()) {
    throw makeError(group, action, `group index ${index} is not a regular file.`, index, index, index);
  }
  if (indexInfo.stat && !hasGroupMarker(indexInfo.contents ?? "")) {
    throw makeError(group, action, `SKILL.md at ${index} is unmarked user data and conflicts with group "${group}".`, index, index, index);
  }

  const childTrees = discoverDirectChildGroups(root, group, action);
  const members = readGroupMembers(root, group, action, childTrees);
  const names = new Set(members.map(member => member.name));
  for (const child of childTrees) {
    const childName = path.basename(child.group);
    if (names.has(childName) || members.some(member => member.directory === childName)) {
      throw makeError(
        group,
        action,
        `child group "${childName}" conflicts with a direct skill name or directory.`,
        path.join(directory, childName),
        path.join(directory, childName, SKILL_FILE_NAME),
        index,
      );
    }
  }
  if (!indexInfo.stat && members.length === 0 && childTrees.length === 0 && !allowEmpty) return null;
  const snapshot: GroupSnapshot = {
    name: group,
    displayName: path.basename(group),
    directory,
    directoryStat,
    index,
    indexStat: indexInfo.stat,
    indexContents: indexInfo.contents,
    members,
    childGroups: childTrees.map(child => groupIndexEntry(root, child, action)),
  };
  validateGroupIndex(snapshot, action);
  return snapshot;
}

function encodeSkillUriSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildGroupIndex(snapshot: GroupSnapshot): string {
  const entries: GroupEntry[] = [
    ...snapshot.childGroups,
    ...snapshot.members.map(member => ({
      kind: "skill" as const,
      name: member.name,
      description: member.description,
      uri: `skill://${snapshot.name.split("/").map(encodeSkillUriSegment).join("/")}/${encodeSkillUriSegment(member.directory)}/SKILL.md`,
    })),
  ];
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
  const summarySource = entries.length === 0
    ? `${snapshot.displayName} managed skills.`
    : `${snapshot.displayName}: ${entries.map(entry => entry.description).join(" ")}`;
  const description = Array.from(sanitizeManagedDescription(summarySource)).slice(0, 200).join("");
  const sections = entries.length === 0
    ? "No direct groups or skills are currently in this group."
    : entries.map(entry => `- ${entry.kind === "group" ? "Group" : "Skill"}: ${entry.name} — ${entry.description}\n  Read: ${entry.uri}`).join("\n");
  return `${toSkillFrontmatter(snapshot.displayName, description)}\n${GROUP_MARKER}\n\n# ${snapshot.displayName}\n\n${sections}\n`;
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
  const content = buildGroupIndex(snapshot);
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

function collectPostOrder(tree: GroupTree, result: string[]): void {
  for (const child of tree.children) collectPostOrder(child, result);
  result.push(tree.group);
}

function collectRelatedGroupOrder(tree: GroupTree, target: string, result: string[]): boolean {
  if (tree.group === target) {
    collectPostOrder(tree, result);
    return true;
  }
  for (const child of tree.children) {
    if (target === child.group || target.startsWith(`${child.group}/`)) {
      if (collectRelatedGroupOrder(child, target, result)) {
        result.push(tree.group);
        return true;
      }
    }
  }
  return false;
}
function collectGroupPathOrder(tree: GroupTree, target: string, result: string[]): boolean {
  if (tree.group === target) {
    result.push(tree.group);
    return true;
  }
  for (const child of tree.children) {
    if (target === child.group || target.startsWith(`${child.group}/`)) {
      if (collectGroupPathOrder(child, target, result)) {
        result.push(tree.group);
        return true;
      }
    }
  }
  return false;
}

function indexResultsForFailure(
  root: string,
  groups: string[],
  completed: Set<string>,
  error: ManagedGroupError,
  failedGroup: string,
): ManagedGroupIndexResult[] {
  return groups.map(group => {
    const indexPath = path.join(root, group, SKILL_FILE_NAME);
    if (completed.has(group)) return { group, path: indexPath, status: "written", needsRebuild: false };
    if (group === failedGroup) {
      const result: ManagedGroupIndexResult = {
        group,
        path: indexPath,
        status: error.indexStatus,
        needsRebuild: error.indexStatus !== "written",
      };
      if (error.indexStatus === "not-written") result.reason = "failed";
      return result;
    }
    return { group, path: indexPath, status: "not-written", needsRebuild: true, reason: "not-attempted" };
  });
}

function refreshGroupsLocked(
  root: string,
  groups: string[],
  action: string,
  skillStatus: WriteStatus,
  skillPath: string,
): ManagedGroupIndexResult[] {
  const completed = new Set<string>();
  const results: ManagedGroupIndexResult[] = [];
  for (const group of groups) {
    try {
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) {
        throw makeError(group, action, `group "${group}" could not be scanned for index rebuilding.`, path.join(root, group, SKILL_FILE_NAME), skillPath, path.join(root, group, SKILL_FILE_NAME));
      }
      writeGroupIndex(root, snapshot, action, skillStatus, skillPath);
      completed.add(group);
      results.push({ group, path: snapshot.index, status: "written", needsRebuild: false });
    } catch (error) {
      const indexPath = path.join(root, group, SKILL_FILE_NAME);
      const managedError = ensureManagedError(error, group, action, indexPath, skillPath, indexPath, skillStatus);
      if (skillStatus === "written") managedError.skillPath = skillPath;
      managedError.indexes = indexResultsForFailure(root, groups, completed, managedError, group);
      throw managedError;
    }
  }
  return results;
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

function ensureMemberDirectory(root: string, snapshot: GroupSnapshot, name: string, action: string): { path: string; stat: Stats } {
  assertSameDirectory(snapshot, root, action);
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
  assertSameDirectory(snapshot, root, action);
  assertCanonicalWithin(root, directory, snapshot.name, action);
  return { path: directory, stat };
}
function createMemberFile(
  root: string,
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
    assertSameDirectory(snapshot, root, action);
    assertCanonicalWithin(root, directory.path, snapshot.name, action, file, snapshot.index);
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
    assertSameDirectory(snapshot, root, action);
    assertCanonicalWithin(root, directory.path, snapshot.name, action, file, snapshot.index);
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
    throw ensureManagedError(error, snapshot.name, action, file, file, snapshot.index, committed ? "unknown" : "not-written", "not-written");
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
    throw ensureManagedError(error, snapshot.name, action, member.file, member.file, snapshot.index, committed ? "unknown" : "not-written", "not-written");
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
  const root = resolveManagedRoot(rootPath);
  const knownGroups = new Set<string>();

  function groupIndex(group: string): string {
    return path.join(root, group, SKILL_FILE_NAME);
  }

  function recordTree(tree: GroupTree): void {
    knownGroups.add(tree.group);
    for (const child of tree.children) recordTree(child);
  }

  function collectTreeGroups(tree: GroupTree, result: Set<string>): void {
    result.add(tree.group);
    for (const child of tree.children) collectTreeGroups(child, result);
  }

  function checkKnownGroups(top: string, tree: GroupTree | null, action: string): void {
    const current = new Set<string>();
    if (tree) collectTreeGroups(tree, current);
    for (const group of knownGroups) {
      if (group.split("/")[0] !== top || current.has(group)) continue;
      if (!lstatOrNull(path.join(root, group))) {
        knownGroups.delete(group);
        continue;
      }
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) {
        const index = groupIndex(group);
        throw makeError(group, action, `previously managed group "${group}" is no longer identifiable.`, index, index, index);
      }
    }
  }

  function assertExplicitGroup(group: string, action: string): boolean {
    const directory = path.join(root, group);
    const directoryStat = lstatOrNull(directory);
    if (!directoryStat) return false;
    const index = groupIndex(group);
    if (directoryStat.isSymbolicLink()) {
      throw makeError(group, action, `group directory ${directory} is a symlink; refusing to follow it for writes.`, directory, directory, index);
    }
    if (!directoryStat.isDirectory()) {
      throw makeError(group, action, `group path ${directory} is not a directory.`, directory, directory, index);
    }
    assertCanonicalWithin(root, directory, group, action);
    const indexInfo = readIndexContents(index, group, action);
    if (indexInfo.stat?.isSymbolicLink()) {
      throw makeError(group, action, `group index ${index} is a symlink; refusing to replace its target.`, index, index, index);
    }
    if (indexInfo.stat && !indexInfo.stat.isFile()) {
      throw makeError(group, action, `group index ${index} is not a regular file.`, index, index, index);
    }
    if (indexInfo.stat) {
      if (!hasGroupMarker(indexInfo.contents ?? "")) {
        throw makeError(group, action, `SKILL.md at ${index} is unmarked user data and conflicts with group "${group}".`, index, index, index);
      }
      const frontmatter = parseFrontmatter(indexInfo.contents!, group, index, action, index, index);
      if (frontmatter.name !== path.basename(group) || typeof frontmatter.description !== "string") {
        throw makeError(group, action, `group index ${index} has invalid name or description metadata.`, index, index, index);
      }
    }
    return true;
  }

  function assertNoParentSkillCollision(parent: string, childName: string, action: string): void {
    const childGroups = discoverDirectChildGroups(root, parent, action);
    const members = readGroupMembers(root, parent, action, childGroups);
    for (const child of childGroups) {
      const groupName = path.basename(child.group);
      const conflict = members.find(member => member.name === groupName || member.directory === groupName);
      if (conflict) {
        throw makeError(
          parent,
          action,
          `child group "${groupName}" conflicts with direct skill "${conflict.name}" or its directory.`,
          conflict.file,
          conflict.file,
          groupIndex(parent),
        );
      }
    }
    const collision = members.find(member => member.name === childName || member.directory === childName);
    if (collision) {
      throw makeError(
        parent,
        action,
        `child group "${childName}" conflicts with direct skill "${collision.name}" or its directory.`,
        collision.file,
        collision.file,
        groupIndex(parent),
      );
    }
  }

  function prepareGroupPath(group: string, action: string, createMissing: boolean, createdDirectories: string[]): void {
    const segments = group.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join("/");
      if (index > 0) {
        const parent = segments.slice(0, index).join("/");
        if (!assertExplicitGroup(parent, action)) {
          throw makeError(parent, action, `parent group "${parent}" does not exist.`, groupIndex(parent), groupIndex(parent), groupIndex(parent));
        }
        assertNoParentSkillCollision(parent, segments[index], action);
      }
      const directory = path.join(root, prefix);
      if (!lstatOrNull(directory)) {
        if (!createMissing) {
          throw makeError(prefix, action, `group "${prefix}" does not exist.`, groupIndex(prefix), groupIndex(prefix), groupIndex(prefix));
        }
        if (ensureGroupDirectory(root, prefix, action)) createdDirectories.push(directory);
      }
      if (!assertExplicitGroup(prefix, action)) {
        throw makeError(prefix, action, `group directory ${directory} could not be prepared safely.`, directory, directory, groupIndex(prefix));
      }
    }
  }

  function isGroup(rawGroup: string): boolean {
    const group = sanitizeGroupName(rawGroup, root);
    if (!assertSafeRoot(root, group, "isGroup", true)) return false;
    const directory = path.join(root, group);
    const directoryStat = lstatOrNull(directory);
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    assertCanonicalWithin(root, directory, group, "isGroup");
    const index = groupIndex(group);
    const indexStat = lstatOrNull(index);
    if (!indexStat || !indexStat.isFile() || indexStat.isSymbolicLink()) return false;
    try {
      return hasGroupMarker(readFileSync(index, "utf8"));
    } catch {
      return false;
    }
  }

  function withGroupLock<T>(group: string, action: string, operation: () => T): T {
    const top = group.split("/")[0];
    try {
      const lockTarget = path.join(root, `.auto-learn-scope-managed-${top}`);
      return withFileLockSync(lockTarget, operation);
    } catch (error) {
      const index = groupIndex(group);
      throw ensureManagedError(error, group, action, index, index, index);
    }
  }

  function scan(): void {
    if (!assertSafeRoot(root, "<scan>", "scan", true)) return;
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError("<scan>", "scan", `the managed-skills root could not be scanned: ${reason}`, root, root, root);
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const entryPath = path.join(root, entry);
      const stat = lstatOrNull(entryPath);
      if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
      const knownTop = [...knownGroups].some(group => group.split("/")[0] === entry);
      let potential: GroupTree | null = null;
      let discoveryFailed = false;
      try {
        potential = discoverGroupTree(root, entry, "scan");
      } catch {
        discoveryFailed = true;
      }
      if (!potential && !knownTop && !discoveryFailed) continue;
      withGroupLock(entry, "scan", () => {
        const tree = discoverGroupTree(root, entry, "scan");
        if (!tree) {
          checkKnownGroups(entry, null, "scan");
          return;
        }
        validateDirectoryGroupName(entry, root);
        checkKnownGroups(entry, tree, "scan");
        recordTree(tree);
        const groups: string[] = [];
        collectPostOrder(tree, groups);
        refreshGroupsLocked(root, groups, "scan", "not-written", groupIndex(entry));
      });
    }
  }

  function refresh(rawGroup: string): void {
    const group = sanitizeGroupName(rawGroup, root);
    if (!assertSafeRoot(root, group, "refresh", true)) return;
    const top = group.split("/")[0];
    withGroupLock(top, "refresh", () => {
      const tree = discoverGroupTree(root, top, "refresh");
      checkKnownGroups(top, tree, "refresh");
      if (!tree) return;
      const groups: string[] = [];
      if (!collectRelatedGroupOrder(tree, group, groups)) return;
      recordTree(tree);
      refreshGroupsLocked(root, groups, "refresh", "not-written", groupIndex(group));
    });
  }

  function mutate(input: ManagedGroupInput): ManagedGroupMutation {
    const group = sanitizeGroupName(input?.group, root);
    const action = input?.action;
    const actionName = action === "create" || action === "update" || action === "delete" ? action : "mutate";
    let targetSkillPath = groupIndex(group);
    function unattemptedIndexes(error: ManagedGroupError): ManagedGroupIndexResult[] {
      const indexes: ManagedGroupIndexResult[] = [];
      const segments = group.split("/");
      for (let length = segments.length; length > 0; length -= 1) {
        const indexedGroup = segments.slice(0, length).join("/");
        const indexPath = groupIndex(indexedGroup);
        let hasValidIndex = false;
        try {
          const snapshot = inspectGroup(root, indexedGroup, actionName, false);
          hasValidIndex = snapshot !== null && snapshot.indexStat !== null;
        } catch {
          // An unreadable or invalid index cannot be treated as current.
        }
        indexes.push({
          group: indexedGroup,
          path: indexPath,
          status: "not-written",
          needsRebuild: error.skillStatus !== "not-written" || error.indexStatus === "unknown" || !hasValidIndex,
          reason: "not-attempted",
        });
      }
      return indexes;
    }
    function failedMutation(error: unknown): ManagedGroupError {
      const managedError = ensureManagedError(error, group, actionName, targetSkillPath, targetSkillPath, groupIndex(group));
      if (managedError.skillPath === managedError.indexPath) managedError.skillPath = targetSkillPath;
      if (managedError.indexes.length === 0) {
        managedError.indexes = unattemptedIndexes(managedError);
      }
      return managedError;
    }
    if (action !== "create" && action !== "update" && action !== "delete") {
      throw failedMutation(makeError(group, "mutate", "action must be create, update, or delete.", groupIndex(group), groupIndex(group), groupIndex(group)));
    }
    let name: string;
    try {
      name = sanitizeSkillName(input?.name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw failedMutation(makeError(group, action, reason, groupIndex(group), groupIndex(group), groupIndex(group)));
    }

    targetSkillPath = path.join(root, group, name, SKILL_FILE_NAME);
    let prepared: string | null;
    try {
      prepared = action === "delete"
        ? null
        : makeGroupMemberContent(group, name, input?.description, input?.body, action, root);
    } catch (error) {
      throw failedMutation(error);
    }
    try {
      ensureRootDirectory(root, group, action);
    } catch (error) {
      throw failedMutation(error);
    }

    try {
      return withGroupLock(group, action, () => {
      const createdDirectories: string[] = [];
      let createdMemberDirectory: string | undefined;
      let skillStatus: WriteStatus = "not-written";
      try {
        prepareGroupPath(group, action, action === "create", createdDirectories);
        const before = inspectGroup(root, group, action, action === "create");
        if (!before && action !== "create") {
          throw makeError(group, action, `group "${group}" does not exist or has no managed members.`, groupIndex(group), targetSkillPath, groupIndex(group));
        }

        let file: string;
        if (action === "create") {
          if (!before) {
            throw makeError(group, action, "the group could not be prepared safely.", groupIndex(group), targetSkillPath, groupIndex(group));
          }
          if (
            before.members.some(member => member.name === name || member.directory === name) ||
            before.childGroups.some(child => child.name === name)
          ) {
            throw makeError(group, action, `skill or child group "${name}" already exists.`, targetSkillPath, targetSkillPath, groupIndex(group));
          }
          const memberDirectoryPath = path.join(before.directory, name);
          if (lstatOrNull(memberDirectoryPath)) {
            throw makeError(group, action, `member directory ${memberDirectoryPath} already exists; refusing to overwrite it.`, targetSkillPath, targetSkillPath, groupIndex(group));
          }
          const memberDirectory = ensureMemberDirectory(root, before, name, action);
          createdMemberDirectory = memberDirectory.path;
          file = createMemberFile(root, before, memberDirectory, prepared!, action);
          skillStatus = "written";
        } else {
          if (!before) {
            throw makeError(group, action, `group "${group}" does not exist or has no managed members.`, groupIndex(group), targetSkillPath, groupIndex(group));
          }
          const member = findMember(before, name, action);
          if (action === "update") {
            updateMemberFile(root, before, member, prepared!, action);
          } else {
            deleteMemberDirectory(root, before, member, action);
          }
          file = member.file;
          skillStatus = "written";
        }

        const top = group.split("/")[0];
        const tree = discoverGroupTree(root, top, action);
        if (!tree) {
          throw makeError(group, action, `group "${group}" disappeared after the skill was written.`, groupIndex(group), file, groupIndex(group), "written", "not-written");
        }
        const groups: string[] = [];
        if (!collectGroupPathOrder(tree, group, groups)) {
          throw makeError(group, action, `group "${group}" disappeared after the skill was written.`, groupIndex(group), file, groupIndex(group), "written", "not-written");
        }
        const indexes = refreshGroupsLocked(root, groups, action, "written", file);
        recordTree(tree);
        createdMemberDirectory = undefined;
        return { path: file, indexes };
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
              rmdirSync(createdMemberDirectory);
            }
          } catch {
            // A failed cleanup must not hide the original operation error.
          }
        }
        if (errorSkillStatus === "not-written") {
          for (const directory of createdDirectories.reverse()) {
            try {
              if (readdirSync(directory).length === 0) rmdirSync(directory);
            } catch {
              // A failed cleanup must not hide the original operation error.
            }
          }
        }
        const managedError = ensureManagedError(
          error,
          group,
          action,
          targetSkillPath,
          targetSkillPath,
          groupIndex(group),
          errorSkillStatus,
          errorIndexStatus,
        );
        if (managedError.indexes.length === 0) {
          managedError.indexes = unattemptedIndexes(managedError);
        }
        throw managedError;
      }
      });
    } catch (error) {
      throw failedMutation(error);
    }
  }

  const store = { scan, refresh, mutate, isGroup };
  scan();
  return store;
}
