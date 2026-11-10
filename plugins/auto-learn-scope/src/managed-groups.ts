import { createHash, randomBytes } from "node:crypto";
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
import { YAML } from "bun";
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
  summaryQueued: boolean;
}

export type ManagedGroupSummaryStatus =
  | "uninitialized"
  | "pending"
  | "current"
  | "stale"
  | "failed"
  | "skipped";

export type ManagedGroupSummaryWork = {
  group: string;
  operationId: string;
  generation: number;
  trigger: "automatic" | "manual";
};

export interface ManagedGroupSummaryEntry {
  kind: "skill" | "group";
  name: string;
  description: string;
}

export interface ManagedGroupSummaryDependency {
  group: string;
  revision: string;
  generation: number;
  status: ManagedGroupSummaryStatus;
}

export interface ManagedGroupSummarySnapshot {
  group: string;
  revision: string;
  generation: number;
  summary: string;
  hasGeneratedSummary: boolean;
  status: ManagedGroupSummaryStatus;
  entries: ManagedGroupSummaryEntry[];
  dependencies: ManagedGroupSummaryDependency[];
  contentFingerprint: string;
}

export interface ManagedGroupStore {
  beginSession(): void;
  scan(): void;
  refresh(group: string): void;
  mutate(input: ManagedGroupInput): ManagedGroupMutation;
  isGroup(group: string): boolean;
  pendingSummaryWork(): ManagedGroupSummaryWork[];
  summarySnapshot(work: ManagedGroupSummaryWork): ManagedGroupSummarySnapshot | null;
  commitSummary(
    snapshot: ManagedGroupSummarySnapshot,
    description: string,
  ): { status: "committed" | "stale" };
  skipSummary(snapshot: ManagedGroupSummarySnapshot): { status: "skipped" | "stale" };
  failSummary(
    snapshot: ManagedGroupSummarySnapshot,
    reason: string,
  ): { status: "failed" | "stale" };
  queueManualSummaryWork(): ManagedGroupSummaryWork[];
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
type GroupSummaryState = {
  status: ManagedGroupSummaryStatus;
  hasGenerated: boolean;
  generation: number;
  trigger?: "automatic" | "manual";
  operationId?: string;
  summaryFingerprint?: string;
  workFingerprint?: string;
  dependencyFingerprint?: string;
  affectedChildren: string[];
  resumable: boolean;
  preserveExistingDescription?: boolean;
  resumeAutomatic?: { affectedChildren: string[] };
  failureReason?: string;
  sessionId?: string;
};

type ManagedGroupIntent = {
  operationId: string;
  sequence: number;
  group: string;
  name: string;
  temporaryName: string;
  contentHash: string;
  directory?: string;
  previousHash?: string;
  status: "pending" | "completed" | "cancelled" | "unknown";
};

type ManagedGroupJournal = {
  version: 1;
  nextSequence: number;
  intents: ManagedGroupIntent[];
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
    source = buildGroupIndex(snapshot, action);
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
  if (frontmatter.revision !== undefined && (typeof frontmatter.revision !== "string" || !frontmatter.revision)) {
    throw makeError(snapshot.name, action, `group index ${snapshot.index} has an invalid revision.`, snapshot.index, snapshot.index, snapshot.index);
  }
  parseGroupSummaryState(frontmatter.summaryState, snapshot.name, snapshot.index, action);
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

function initialGroupSummaryState(): GroupSummaryState {
  return {
    status: "uninitialized",
    hasGenerated: false,
    generation: 0,
    affectedChildren: [],
    resumable: false,
  };
}

function parseGroupSummaryState(
  value: unknown,
  group: string,
  index: string,
  action: string,
): GroupSummaryState {
  if (value === undefined) return initialGroupSummaryState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw makeError(group, action, `group index ${index} has invalid summary state.`, index, index, index);
  }
  const raw = value as Record<string, unknown>;
  const statuses: ManagedGroupSummaryStatus[] = ["uninitialized", "pending", "current", "stale", "failed", "skipped"];
  if (!statuses.includes(raw.status as ManagedGroupSummaryStatus)) {
    throw makeError(group, action, `group index ${index} has an unsupported summary state.`, index, index, index);
  }
  if (typeof raw.hasGenerated !== "boolean" || !Number.isSafeInteger(raw.generation) || (raw.generation as number) < 0) {
    throw makeError(group, action, `group index ${index} has invalid summary generation metadata.`, index, index, index);
  }
  if (
    raw.trigger !== undefined &&
    raw.trigger !== "automatic" &&
    raw.trigger !== "manual"
  ) {
    throw makeError(group, action, `group index ${index} has an invalid summary trigger.`, index, index, index);
  }
  if (raw.operationId !== undefined && typeof raw.operationId !== "string") {
    throw makeError(group, action, `group index ${index} has an invalid summary operation id.`, index, index, index);
  }
  if (raw.workFingerprint !== undefined && typeof raw.workFingerprint !== "string") {
    throw makeError(group, action, `group index ${index} has an invalid summary fingerprint.`, index, index, index);
  }
  if (raw.summaryFingerprint !== undefined && (
    typeof raw.summaryFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.summaryFingerprint)
  )) {
    throw makeError(group, action, `group index ${index} has an invalid completed-summary fingerprint.`, index, index, index);
  }
  if (raw.dependencyFingerprint !== undefined && (
    typeof raw.dependencyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.dependencyFingerprint)
  )) {
    throw makeError(group, action, `group index ${index} has an invalid dependency fingerprint.`, index, index, index);
  }
  if (!Array.isArray(raw.affectedChildren) || raw.affectedChildren.some(child => typeof child !== "string")) {
    throw makeError(group, action, `group index ${index} has invalid summary dependencies.`, index, index, index);
  }
  if (typeof raw.resumable !== "boolean") {
    throw makeError(group, action, `group index ${index} has invalid summary recovery metadata.`, index, index, index);
  }
  if (raw.preserveExistingDescription !== undefined && typeof raw.preserveExistingDescription !== "boolean") {
    throw makeError(group, action, `group index ${index} has invalid legacy-summary metadata.`, index, index, index);
  }
  let resumeAutomatic: { affectedChildren: string[] } | undefined;
  if (raw.resumeAutomatic !== undefined) {
    if (
      !raw.resumeAutomatic ||
      typeof raw.resumeAutomatic !== "object" ||
      Array.isArray(raw.resumeAutomatic) ||
      !("affectedChildren" in raw.resumeAutomatic) ||
      !Array.isArray(raw.resumeAutomatic.affectedChildren)
    ) {
      throw makeError(group, action, `group index ${index} has invalid automatic recovery metadata.`, index, index, index);
    }
    const affectedChildren: string[] = [];
    for (const child of raw.resumeAutomatic.affectedChildren) {
      if (typeof child !== "string") {
        throw makeError(group, action, `group index ${index} has invalid automatic recovery metadata.`, index, index, index);
      }
      affectedChildren.push(child);
    }
    resumeAutomatic = { affectedChildren };
  }
  if (raw.failureReason !== undefined && typeof raw.failureReason !== "string") {
    throw makeError(group, action, `group index ${index} has an invalid summary failure reason.`, index, index, index);
  }
  if (raw.sessionId !== undefined && typeof raw.sessionId !== "string") {
    throw makeError(group, action, `group index ${index} has an invalid summary session id.`, index, index, index);
  }
  return {
    status: raw.status as ManagedGroupSummaryStatus,
    hasGenerated: raw.hasGenerated,
    generation: raw.generation as number,
    affectedChildren: raw.affectedChildren as string[],
    resumable: raw.resumable,
    ...(raw.trigger === undefined ? {} : { trigger: raw.trigger as "automatic" | "manual" }),
    ...(raw.operationId === undefined ? {} : { operationId: raw.operationId }),
    ...(raw.summaryFingerprint === undefined ? {} : { summaryFingerprint: raw.summaryFingerprint }),
    ...(raw.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: raw.dependencyFingerprint }),
    ...(raw.workFingerprint === undefined ? {} : { workFingerprint: raw.workFingerprint }),
    ...(raw.preserveExistingDescription === undefined ? {} : { preserveExistingDescription: raw.preserveExistingDescription }),
    ...(resumeAutomatic === undefined ? {} : { resumeAutomatic }),
    ...(raw.failureReason === undefined ? {} : { failureReason: raw.failureReason }),
    ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId }),
  };
}

function groupIndexFrontmatter(snapshot: GroupSnapshot, action: string): Record<string, unknown> {
  if (!snapshot.indexContents) return { name: snapshot.displayName, description: "" };
  return parseFrontmatter(snapshot.indexContents, snapshot.name, snapshot.index, action, snapshot.index, snapshot.index);
}

function groupSummaryState(snapshot: GroupSnapshot, action: string): GroupSummaryState {
  const frontmatter = groupIndexFrontmatter(snapshot, action);
  const state = parseGroupSummaryState(frontmatter.summaryState, snapshot.name, snapshot.index, action);
  if (
    frontmatter.revision === undefined &&
    !state.hasGenerated &&
    typeof frontmatter.description === "string" &&
    frontmatter.description.length > 0
  ) {
    return { ...state, preserveExistingDescription: true };
  }
  return state;
}

function groupContentFingerprint(snapshot: GroupSnapshot, action: string): string {
  const hash = createHash("sha256");
  const members = [...snapshot.members].sort((left, right) => left.directory.localeCompare(right.directory));
  for (const member of members) {
    const current = lstatOrNull(member.file);
    if (!current || !sameFileIdentity(member.fileStat, current)) {
      throw makeError(snapshot.name, action, `member SKILL.md ${member.file} changed while its summary snapshot was being read.`, member.file, member.file, snapshot.index);
    }
    try {
      hash.update(member.directory).update("\0").update(readFileSync(member.file)).update("\0");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError(snapshot.name, action, `member SKILL.md ${member.file} could not be fingerprinted: ${reason}`, member.file, member.file, snapshot.index);
    }
  }
  return hash.digest("hex");
}

function managedGroupDependencyFingerprint(dependencies: ManagedGroupSummaryDependency[]): string {
  const sorted = [...dependencies].sort((left, right) =>
    left.group < right.group ? -1 : left.group > right.group ? 1 : 0,
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function groupDependencyFingerprint(root: string, snapshot: GroupSnapshot, action: string): string {
  const dependencies = snapshot.childGroups.map(child => {
    const group = path.join(snapshot.name, child.name);
    const childSnapshot = inspectGroup(root, group, action, false);
    if (!childSnapshot) {
      throw makeError(snapshot.name, action, `child group "${group}" disappeared while dependencies were fingerprinted.`, snapshot.index, snapshot.index, snapshot.index);
    }
    const frontmatter = groupIndexFrontmatter(childSnapshot, action);
    if (typeof frontmatter.revision !== "string" || !frontmatter.revision) {
      throw makeError(group, action, `group index ${childSnapshot.index} has no CAS revision.`, childSnapshot.index, childSnapshot.index, childSnapshot.index);
    }
    const state = groupSummaryState(childSnapshot, action);
    return {
      group,
      revision: frontmatter.revision,
      generation: state.generation,
      status: state.status,
    };
  });
  return managedGroupDependencyFingerprint(dependencies);
}

function groupIndexFallbackDescription(snapshot: GroupSnapshot, entries: GroupEntry[]): string {
  const source = entries.length === 0
    ? `${snapshot.displayName} managed skills.`
    : `${snapshot.displayName}: ${entries.map(entry => entry.description).join(" ")}`;
  return Array.from(sanitizeManagedDescription(source)).slice(0, 200).join("");
}

function newGroupRevision(): string {
  return randomBytes(16).toString("hex");
}

function buildGroupIndex(
  snapshot: GroupSnapshot,
  action: string,
  summaryStateOverride?: GroupSummaryState,
  summaryDescriptionOverride?: string,
  revisionOverride?: string,
): string {
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
  const previousFrontmatter = groupIndexFrontmatter(snapshot, action);
  const previousState = groupSummaryState(snapshot, action);
  const summaryState = summaryStateOverride ?? previousState;
  const previousDescription = typeof previousFrontmatter.description === "string"
    ? previousFrontmatter.description
    : "";
  const description = sanitizeManagedDescription(
    summaryDescriptionOverride ??
    (summaryState.hasGenerated || summaryState.preserveExistingDescription
      ? previousDescription
      : groupIndexFallbackDescription(snapshot, entries)),
  );
  const persistedSummaryState = Object.fromEntries(
    Object.entries(summaryState).filter(([, value]) => value !== undefined),
  ) as unknown as GroupSummaryState;
  const revision = revisionOverride ??
    (typeof previousFrontmatter.revision === "string" && previousFrontmatter.revision
      ? previousFrontmatter.revision
      : newGroupRevision());
  const frontmatter = {
    ...previousFrontmatter,
    name: snapshot.displayName,
    description,
    revision,
    summaryState: persistedSummaryState,
  };
  const yaml = YAML.stringify(frontmatter, null, 2).trimEnd();
  const sections = entries.length === 0
    ? "No direct groups or skills are currently in this group."
    : entries.map(entry => `- ${entry.kind === "group" ? "Group" : "Skill"}: ${entry.name} — ${entry.description}\n  Read: ${entry.uri}`).join("\n");
  return `---\n${yaml}\n---\n\n${GROUP_MARKER}\n\n# ${snapshot.displayName}\n\n${sections}\n`;
}

function openTemporaryFile(
  directory: string,
  mode = 0o666,
  name?: string,
): { file: string; descriptor: number } {
  if (name !== undefined) {
    if (path.basename(name) !== name || !name.startsWith(TEMP_FILE_PREFIX)) {
      throw new Error("unsafe temporary managed-skill filename");
    }
    const file = path.join(directory, name);
    return { file, descriptor: openSync(file, "wx", mode) };
  }
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

function managedGroupJournalPath(root: string, top: string): string {
  const key = createHash("sha256").update(top).digest("hex").slice(0, 24);
  return path.join(root, `.auto-learn-scope-managed-state-${key}.json`);
}

function emptyManagedGroupJournal(): ManagedGroupJournal {
  return { version: 1, nextSequence: 1, intents: [] };
}

function readManagedGroupJournal(root: string, top: string, action: string): ManagedGroupJournal {
  const file = managedGroupJournalPath(root, top);
  const stat = lstatOrNull(file);
  if (!stat) return emptyManagedGroupJournal();
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw makeError(top, action, `managed group journal ${file} is not a private regular file.`, file, file, file);
  }
  assertCanonicalWithin(root, file, top, action, file, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw makeError(top, action, `managed group journal ${file} is unreadable: ${reason}`, file, file, file);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw makeError(top, action, `managed group journal ${file} has invalid data.`, file, file, file);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.nextSequence) || (raw.nextSequence as number) < 1 || !Array.isArray(raw.intents)) {
    throw makeError(top, action, `managed group journal ${file} has an unsupported format.`, file, file, file);
  }
  const intents: ManagedGroupIntent[] = [];
  for (const item of raw.intents) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw makeError(top, action, `managed group journal ${file} contains an invalid intent.`, file, file, file);
    }
    const intent = item as Record<string, unknown>;
    let group: string;
    let name: string;
    try {
      group = sanitizeGroupName(intent.group, root);
      name = sanitizeSkillName(intent.name);
    } catch {
      throw makeError(top, action, `managed group journal ${file} contains an unsafe intent path.`, file, file, file);
    }
    if (
      group.split("/")[0] !== top ||
      typeof intent.operationId !== "string" ||
      !/^[0-9a-f]{32}$/.test(intent.operationId) ||
      typeof intent.temporaryName !== "string" ||
      intent.temporaryName !== `${TEMP_FILE_PREFIX}${intent.operationId}` ||
      !Number.isSafeInteger(intent.sequence) ||
      (intent.sequence as number) < 1 ||
      typeof intent.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(intent.contentHash) ||
      (intent.directory !== undefined && (typeof intent.directory !== "string" || intent.directory === "." || intent.directory === ".." || intent.directory.includes("/") || intent.directory.includes("\\"))) ||
      (intent.previousHash !== undefined && (typeof intent.previousHash !== "string" || !/^[0-9a-f]{64}$/.test(intent.previousHash))) ||
      !["pending", "completed", "cancelled", "unknown"].includes(String(intent.status))
    ) {
      throw makeError(top, action, `managed group journal ${file} contains an invalid intent record.`, file, file, file);
    }
    intents.push({
      operationId: intent.operationId,
      sequence: intent.sequence as number,
      group,
      name,
      temporaryName: intent.temporaryName,
      contentHash: intent.contentHash,
      ...(typeof intent.directory === "string" ? { directory: intent.directory } : {}),
      ...(typeof intent.previousHash === "string" ? { previousHash: intent.previousHash } : {}),
      status: intent.status as ManagedGroupIntent["status"],
    });
  }
  intents.sort((left, right) => left.sequence - right.sequence);
  return { version: 1, nextSequence: raw.nextSequence as number, intents };
}

function writeManagedGroupJournal(
  root: string,
  top: string,
  action: string,
  journal: ManagedGroupJournal,
): void {
  const file = managedGroupJournalPath(root, top);
  assertCanonicalWithin(root, root, top, action, file, file);
  const current = lstatOrNull(file);
  if (current && (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1)) {
    throw makeError(top, action, `managed group journal ${file} is not a private regular file.`, file, file, file);
  }
  const opened = openTemporaryFile(root, 0o600);
  let temporaryFile: string | undefined = opened.file;
  let descriptor: number | undefined = opened.descriptor;
  let committed = false;
  let expectedStat: Stats | null = null;
  try {
    writeTemporaryFile(temporaryFile, descriptor, JSON.stringify(journal), 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    expectedStat = lstatSync(temporaryFile);
    if (!expectedStat.isFile() || expectedStat.nlink !== 1) {
      throw makeError(top, action, "the temporary managed group journal is not a private regular file.", temporaryFile, file, file);
    }
    const beforeCommit = lstatOrNull(file);
    if (current) {
      if (
        !beforeCommit ||
        beforeCommit.isSymbolicLink() ||
        !beforeCommit.isFile() ||
        beforeCommit.nlink !== 1 ||
        !sameFileIdentity(current, beforeCommit)
      ) {
        throw makeError(top, action, `managed group journal ${file} changed before atomic replacement.`, file, file, file);
      }
      renameSync(temporaryFile, file);
      temporaryFile = undefined;
      committed = true;
    } else {
      if (beforeCommit) {
        throw makeError(top, action, `managed group journal ${file} appeared before creation.`, file, file, file);
      }
      linkSync(temporaryFile, file);
      committed = true;
      unlinkSync(temporaryFile);
      temporaryFile = undefined;
    }
    const written = lstatOrNull(file);
    if (!written || written.isSymbolicLink() || !written.isFile() || written.nlink !== 1 || !sameFileIdentity(expectedStat, written)) {
      throw makeError(top, action, `managed group journal ${file} could not be verified after writing.`, file, file, file);
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the originating journal write failure.
      }
    }
    removeTemporaryFile(temporaryFile);
    if (!committed && !temporaryFile) {
      const after = lstatOrNull(file);
      if (after && after.isFile() && expectedStat && sameFileIdentity(after, expectedStat)) {
        // The atomic replacement landed even though its verification failed.
      }
    }
  }
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
  summaryStateOverride?: GroupSummaryState,
  summaryDescriptionOverride?: string,
): void {
  const previousFrontmatter = groupIndexFrontmatter(snapshot, action);
  const previousRevision = typeof previousFrontmatter.revision === "string" ? previousFrontmatter.revision : undefined;
  let content = buildGroupIndex(
    snapshot,
    action,
    summaryStateOverride,
    summaryDescriptionOverride,
    previousRevision,
  );
  if (snapshot.indexContents === content) return;
  if (previousRevision) {
    content = buildGroupIndex(snapshot, action, summaryStateOverride, summaryDescriptionOverride, newGroupRevision());
  }

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
  summaryStates: Map<string, GroupSummaryState> = new Map(),
  summaryDescriptions: Map<string, string> = new Map(),
): ManagedGroupIndexResult[] {
  const completed = new Set<string>();
  const results: ManagedGroupIndexResult[] = [];
  for (const group of groups) {
    try {
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) {
        throw makeError(group, action, `group "${group}" could not be scanned for index rebuilding.`, path.join(root, group, SKILL_FILE_NAME), skillPath, path.join(root, group, SKILL_FILE_NAME));
      }
      writeGroupIndex(root, snapshot, action, skillStatus, skillPath, summaryStates.get(group), summaryDescriptions.get(group));
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
  temporaryName: string,
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
    const opened = openTemporaryFile(directory.path, 0o666, temporaryName);
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
  temporaryName?: string,
): void {
  const original = assertWritableMember(snapshot, member, root, action);
  let temporaryFile: string | undefined;
  let descriptor: number | undefined;
  let committed = false;
  let expectedStat: Stats | null = null;
  try {
    const opened = openTemporaryFile(member.directoryPath, 0o666, temporaryName);
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
  let sessionId = randomBytes(16).toString("hex");

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

  function groupNamesInTree(tree: GroupTree): string[] {
    const groups: string[] = [];
    collectPostOrder(tree, groups);
    return groups;
  }

  function stateForWork(
    group: string,
    operationId: string,
    trigger: "automatic" | "manual",
    affectedChildren: string[],
    action: string,
  ): GroupSummaryState {
    const snapshot = inspectGroup(root, group, action, true);
    if (!snapshot) {
      throw makeError(group, action, `group "${group}" disappeared before summary work was queued.`, groupIndex(group), groupIndex(group), groupIndex(group));
    }
    const previous = groupSummaryState(snapshot, action);
    const resumeAutomatic = trigger === "manual"
      ? previous.resumeAutomatic ??
        (previous.trigger === "automatic" &&
          (previous.status === "pending" || (previous.status === "failed" && previous.resumable))
          ? { affectedChildren: [...previous.affectedChildren] }
          : undefined)
      : undefined;
    return {
      ...previous,
      status: "pending",
      generation: previous.generation + 1,
      trigger,
      operationId,
      workFingerprint: groupContentFingerprint(snapshot, action),
      affectedChildren,
      resumable: trigger === "automatic",
      resumeAutomatic,
      failureReason: undefined,
      sessionId: trigger === "manual" ? sessionId : undefined,
    };
  }

  function workStatesForPath(
    groups: string[],
    operationId: string,
    trigger: "automatic" | "manual",
    action: string,
  ): Map<string, GroupSummaryState> {
    const states = new Map<string, GroupSummaryState>();
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const snapshot = inspectGroup(root, group, action, true);
      if (!snapshot) {
        throw makeError(group, action, `group "${group}" disappeared before summary work was queued.`, groupIndex(group), groupIndex(group), groupIndex(group));
      }
      const affectedChildren = trigger === "manual" || index === 0
        ? snapshot.childGroups.map(child => path.join(group, child.name))
        : [groups[index - 1]];
      states.set(group, stateForWork(group, operationId, trigger, affectedChildren, action));
    }
    return states;
  }

  function staleStatesForPath(groups: string[], action: string): Map<string, GroupSummaryState> {
    const states = new Map<string, GroupSummaryState>();
    for (const group of groups) {
      const snapshot = inspectGroup(root, group, action, true);
      if (!snapshot) continue;
      const state = groupSummaryState(snapshot, action);
      states.set(group, {
        ...state,
        status: state.hasGenerated ? "stale" : "uninitialized",
        trigger: undefined,
        operationId: undefined,
        workFingerprint: undefined,
        affectedChildren: [],
        resumable: false,
        resumeAutomatic: undefined,
        failureReason: undefined,
        sessionId: undefined,
      });
    }
    return states;
  }

  function workFromState(group: string, state: GroupSummaryState): ManagedGroupSummaryWork | null {
    if (!state.operationId || !state.trigger) return null;
    if (state.status !== "pending" && !(state.status === "failed" && state.resumable)) return null;
    return {
      group,
      operationId: state.operationId,
      generation: state.generation,
      trigger: state.trigger,
    };
  }

  function summarySnapshotForWork(
    work: ManagedGroupSummaryWork,
    action: string,
  ): ManagedGroupSummarySnapshot | null {
    const group = sanitizeGroupName(work.group, root);
    const snapshot = inspectGroup(root, group, action, false);
    if (!snapshot) return null;
    const state = groupSummaryState(snapshot, action);
    if (
      state.operationId !== work.operationId ||
      state.generation !== work.generation ||
      state.trigger !== work.trigger ||
      (state.status !== "pending" && state.status !== "failed") ||
      (state.trigger === "manual" && state.sessionId !== sessionId)
    ) {
      return null;
    }
    const fingerprint = groupContentFingerprint(snapshot, action);
    if (state.workFingerprint !== fingerprint) {
      invalidateOperationLocked(group.split("/")[0], work.operationId, action);
      return null;
    }
    const frontmatter = groupIndexFrontmatter(snapshot, action);
    if (typeof frontmatter.revision !== "string" || !frontmatter.revision) {
      throw makeError(group, action, `group index ${snapshot.index} has no CAS revision.`, snapshot.index, snapshot.index, snapshot.index);
    }
    const entries: ManagedGroupSummaryEntry[] = [
      ...snapshot.childGroups.map(child => ({
        kind: "group" as const,
        name: child.name,
        description: child.description,
      })),
      ...snapshot.members.map(member => ({
        kind: "skill" as const,
        name: member.name,
        description: member.description,
      })),
    ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
    const dependencies: ManagedGroupSummaryDependency[] = snapshot.childGroups.map(child => {
      const childGroup = path.join(group, child.name);
      const childSnapshot = inspectGroup(root, childGroup, action, false);
      if (!childSnapshot) {
        throw makeError(group, action, `child group "${childGroup}" disappeared while reading summary dependencies.`, groupIndex(group), groupIndex(group), groupIndex(group));
      }
      const childFrontmatter = groupIndexFrontmatter(childSnapshot, action);
      if (typeof childFrontmatter.revision !== "string" || !childFrontmatter.revision) {
        throw makeError(childGroup, action, `group index ${childSnapshot.index} has no CAS revision.`, childSnapshot.index, childSnapshot.index, childSnapshot.index);
      }
      return {
        group: childGroup,
        revision: childFrontmatter.revision,
        generation: groupSummaryState(childSnapshot, action).generation,
        status: groupSummaryState(childSnapshot, action).status,
      };
    });
    return {
      group,
      revision: frontmatter.revision,
      generation: state.generation,
      summary: typeof frontmatter.description === "string" ? frontmatter.description : "",
      hasGeneratedSummary: state.hasGenerated,
      status: state.status,
      entries,
      dependencies,
      contentFingerprint: fingerprint,
    };
  }

  function updateIntentStatus(
    top: string,
    operationId: string,
    status: ManagedGroupIntent["status"],
    action: string,
  ): void {
    const journal = readManagedGroupJournal(root, top, action);
    const intent = journal.intents.find(candidate => candidate.operationId === operationId);
    if (!intent) {
      throw makeError(top, action, `managed group intent "${operationId}" disappeared from its journal.`, managedGroupJournalPath(root, top), groupIndex(top), groupIndex(top));
    }
    if (status === "completed" || status === "cancelled") {
      journal.intents = journal.intents.filter(candidate => candidate.operationId !== operationId);
    } else {
      intent.status = status;
    }
    writeManagedGroupJournal(root, top, action, journal);
  }

  function appendIntent(group: string, name: string, content: string, action: string, member?: GroupMember): ManagedGroupIntent {
    const top = group.split("/")[0];
    const journal = readManagedGroupJournal(root, top, action);
    const operationId = randomBytes(16).toString("hex");
    const intent: ManagedGroupIntent = {
      operationId,
      sequence: journal.nextSequence,
      group,
      name,
      temporaryName: `${TEMP_FILE_PREFIX}${operationId}`,
      contentHash: createHash("sha256").update(content).digest("hex"),
      status: "pending",
      ...(member ? {
        directory: member.directory,
        previousHash: createHash("sha256").update(readFileSync(member.file)).digest("hex"),
      } : {}),
    };
    journal.nextSequence += 1;
    journal.intents.push(intent);
    writeManagedGroupJournal(root, top, action, journal);
    return intent;
  }

  function invalidateOperationLocked(top: string, operationId: string, action: string): void {
    const tree = discoverGroupTree(root, top, action);
    if (!tree) return;
    const groups = groupNamesInTree(tree);
    const states = new Map<string, GroupSummaryState>();
    for (const group of groups) {
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) continue;
      const state = groupSummaryState(snapshot, action);
      if (state.operationId !== operationId) continue;
      const fingerprint = groupContentFingerprint(snapshot, action);
      const restoreAutomatic =
        state.trigger === "manual" &&
        state.resumeAutomatic !== undefined &&
        state.workFingerprint === fingerprint;
      states.set(group, {
        ...state,
        status: restoreAutomatic ? "pending" : state.hasGenerated ? "stale" : "uninitialized",
        generation: state.generation,
        trigger: restoreAutomatic ? "automatic" : undefined,
        operationId: restoreAutomatic ? randomBytes(16).toString("hex") : undefined,
        workFingerprint: restoreAutomatic ? fingerprint : undefined,
        affectedChildren: restoreAutomatic ? state.resumeAutomatic!.affectedChildren : [],
        resumable: restoreAutomatic,
        resumeAutomatic: undefined,
        failureReason: state.failureReason,
        sessionId: undefined,
      });
    }
    if (states.size > 0) {
      refreshGroupsLocked(root, groups, action, "not-written", groupIndex(top), states);
    }
  }

  function cleanupInterruptedMemberLink(memberFile: string, committed: Stats, temporaryName: string): void {
    const temporary = path.join(path.dirname(memberFile), temporaryName);
    const stat = lstatOrNull(temporary);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || !sameFileIdentity(committed, stat)) return;
    try {
      unlinkSync(temporary);
    } catch {
      // Recovery can still report the committed member; the next pass retries cleanup.
    }
  }

  function cleanupInterruptedMemberDirectory(directory: string, temporaryName: string): void {
    const temporary = path.join(directory, temporaryName);
    const stat = lstatOrNull(temporary);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return;
    try {
      unlinkSync(temporary);
    } catch {
      // Cancellation remains safe; startup recovery retries before another write.
    }
  }

  function recoverPendingIntentsLocked(top: string, action: string): void {
    const journal = readManagedGroupJournal(root, top, action);
    for (const intent of journal.intents) {
      if (intent.status !== "pending" && intent.status !== "unknown") continue;
      let groupDirectory = root;
      let groupStat: Stats | null = null;
      const groupPathSegments = intent.group.split("/");
      const groupPathStats: Stats[] = [];
      for (const segment of groupPathSegments) {
        groupDirectory = path.join(groupDirectory, segment);
        groupStat = lstatOrNull(groupDirectory);
        if (!groupStat || groupStat.isSymbolicLink() || !groupStat.isDirectory()) {
          updateIntentStatus(top, intent.operationId, "unknown", action);
          throw makeError(intent.group, action, `interrupted group ${groupDirectory} is not a safe directory.`, groupDirectory, groupDirectory, groupIndex(intent.group));
        }
        assertCanonicalWithin(root, groupDirectory, intent.group, action);
        groupPathStats.push(groupStat);
      }
      if (!groupStat) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted group ${groupDirectory} is not a safe directory.`, groupDirectory, groupDirectory, groupIndex(intent.group));
      }
      assertCanonicalWithin(root, groupDirectory, intent.group, action);
      const verifiedGroupStat = groupStat;
      const memberDirectory = path.join(groupDirectory, intent.directory ?? intent.name);
      const memberDirectoryStat = lstatOrNull(memberDirectory);
      if (!memberDirectoryStat) {
        updateIntentStatus(top, intent.operationId, "cancelled", action);
        continue;
      }
      if (memberDirectoryStat.isSymbolicLink() || !memberDirectoryStat.isDirectory()) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member directory ${memberDirectory} is not safe.`, memberDirectory, memberDirectory, groupIndex(intent.group));
      }
      assertCanonicalWithin(root, memberDirectory, intent.group, action);
      const initialMemberDirectoryStat = memberDirectoryStat;
      function assertRecoveryDirectoriesUnchanged(): void {
        let directory = root;
        for (let index = 0; index < groupPathSegments.length; index += 1) {
          directory = path.join(directory, groupPathSegments[index]);
          const current = lstatOrNull(directory);
          if (
            !current ||
            current.isSymbolicLink() ||
            !current.isDirectory() ||
            !sameFileIdentity(groupPathStats[index], current)
          ) {
            updateIntentStatus(top, intent.operationId, "unknown", action);
            throw makeError(intent.group, action, `interrupted group ${directory} changed during recovery.`, directory, directory, groupIndex(intent.group));
          }
          assertCanonicalWithin(root, directory, intent.group, action);
        }
        const currentMemberDirectory = lstatOrNull(memberDirectory);
        if (
          !currentMemberDirectory ||
          currentMemberDirectory.isSymbolicLink() ||
          !currentMemberDirectory.isDirectory() ||
          !sameFileIdentity(initialMemberDirectoryStat, currentMemberDirectory)
        ) {
          updateIntentStatus(top, intent.operationId, "unknown", action);
          throw makeError(intent.group, action, `interrupted member directory ${memberDirectory} changed during recovery.`, memberDirectory, memberDirectory, groupIndex(intent.group));
        }
        assertCanonicalWithin(root, memberDirectory, intent.group, action);
      }
      const memberFile = path.join(memberDirectory, SKILL_FILE_NAME);
      const memberStat = lstatOrNull(memberFile);
      if (!memberStat) {
        assertRecoveryDirectoriesUnchanged();
        cleanupInterruptedMemberDirectory(memberDirectory, intent.temporaryName);
        assertRecoveryDirectoriesUnchanged();
        try {
          if (readdirSync(memberDirectory).length === 0) rmdirSync(memberDirectory);
        } catch {
          // An empty directory left by an interrupted create is harmless.
        }
        updateIntentStatus(top, intent.operationId, "cancelled", action);
        continue;
      }
      if (memberStat.isSymbolicLink() || !memberStat.isFile()) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} is not a regular file; its commit cannot be confirmed.`, memberFile, memberFile, groupIndex(intent.group));
      }
      let content: string;
      try {
        content = readFileSync(memberFile, "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} could not be verified: ${reason}`, memberFile, memberFile, groupIndex(intent.group));
      }
      if (intent.previousHash && createHash("sha256").update(content).digest("hex") === intent.previousHash) {
        assertRecoveryDirectoriesUnchanged();
        cleanupInterruptedMemberDirectory(memberDirectory, intent.temporaryName);
        updateIntentStatus(top, intent.operationId, "cancelled", action);
        continue;
      }
      if (createHash("sha256").update(content).digest("hex") !== intent.contentHash) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} differs from its recorded content; refusing to report it as a committed add.`, memberFile, memberFile, groupIndex(intent.group));
      }
      assertRecoveryDirectoriesUnchanged();
      cleanupInterruptedMemberLink(memberFile, memberStat, intent.temporaryName);
      assertRecoveryDirectoriesUnchanged();
      const verifiedGroup = lstatOrNull(groupDirectory);
      const verifiedDirectory = lstatOrNull(memberDirectory);
      const verifiedMember = lstatOrNull(memberFile);
      if (
        !verifiedGroup ||
        verifiedGroup.isSymbolicLink() ||
        !verifiedGroup.isDirectory() ||
        !sameFileIdentity(verifiedGroupStat, verifiedGroup) ||
        !verifiedDirectory ||
        verifiedDirectory.isSymbolicLink() ||
        !verifiedDirectory.isDirectory() ||
        !sameFileIdentity(initialMemberDirectoryStat, verifiedDirectory) ||
        !verifiedMember ||
        verifiedMember.isSymbolicLink() ||
        !verifiedMember.isFile() ||
        verifiedMember.nlink !== 1 ||
        !sameFileIdentity(memberStat, verifiedMember)
      ) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} could not be confirmed as a private file.`, memberFile, memberFile, groupIndex(intent.group));
      }
      let verifiedContent: string;
      try {
        verifiedContent = readFileSync(memberFile, "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} could not be reverified: ${reason}`, memberFile, memberFile, groupIndex(intent.group));
      }
      if (createHash("sha256").update(verifiedContent).digest("hex") !== intent.contentHash) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} changed during recovery; refusing to report it as a committed add.`, memberFile, memberFile, groupIndex(intent.group));
      }

      const tree = discoverGroupTree(root, top, action);
      const groups: string[] = [];
      if (!tree || !collectGroupPathOrder(tree, intent.group, groups)) {
        updateIntentStatus(top, intent.operationId, "unknown", action);
        throw makeError(intent.group, action, `interrupted member ${memberFile} is not part of a discoverable managed group.`, memberFile, memberFile, groupIndex(intent.group));
      }
      const staleRecoveredWork = groups.some(group => {
        const snapshot = inspectGroup(root, group, action, false);
        if (!snapshot) return false;
        const previous = groupSummaryState(snapshot, action);
        return previous.operationId === intent.operationId &&
          previous.trigger === "automatic" &&
          (!previous.workFingerprint || previous.workFingerprint !== groupContentFingerprint(snapshot, action));
      });
      if (staleRecoveredWork) {
        invalidateOperationLocked(top, intent.operationId, action);
        const staleStates = staleStatesForPath(groups, action);
        refreshGroupsLocked(root, groups, action, "written", memberFile, staleStates);
        updateIntentStatus(top, intent.operationId, "completed", action);
        continue;
      }
      const states = new Map<string, GroupSummaryState>();
      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const snapshot = inspectGroup(root, group, action, false);
        if (!snapshot) {
          throw makeError(group, action, `group "${group}" disappeared while recovering a committed add.`, memberFile, memberFile, groupIndex(group));
        }
        const previous = groupSummaryState(snapshot, action);
        const affectedChildren = index === 0
          ? snapshot.childGroups.map(child => path.join(group, child.name))
          : [groups[index - 1]];
        if (previous.operationId === intent.operationId && previous.trigger === "automatic") {
          states.set(group, {
            ...previous,
            status: "pending",
            affectedChildren,
            resumable: true,
            failureReason: undefined,
          });
        } else {
          states.set(group, stateForWork(group, intent.operationId, "automatic", affectedChildren, action));
        }
      }
      refreshGroupsLocked(root, groups, action, "written", memberFile, states);
      updateIntentStatus(top, intent.operationId, "completed", action);
    }
  }

  function reconcileSummaryWorkLocked(top: string, action: string): void {
    const tree = discoverGroupTree(root, top, action);
    if (!tree) return;
    const groups = groupNamesInTree(tree);
    refreshGroupsLocked(root, groups, action, "not-written", groupIndex(top));
    const invalidated = new Set<string>();
    for (const group of groups) {
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) continue;
      const state = groupSummaryState(snapshot, action);
      if (!state.operationId || !state.trigger) continue;
      if (
        (state.status === "pending" || state.status === "failed") &&
        state.workFingerprint &&
        state.workFingerprint !== groupContentFingerprint(snapshot, action)
      ) {
        invalidated.add(state.operationId);
      }
      if (
        (state.status === "pending" || state.status === "failed") &&
        state.trigger === "manual" &&
        state.sessionId !== sessionId
      ) {
        invalidated.add(state.operationId);
      }
    }
    for (const operationId of invalidated) invalidateOperationLocked(top, operationId, action);
    const currentTree = discoverGroupTree(root, top, action);
    if (!currentTree) return;
    const currentGroups = groupNamesInTree(currentTree);
    for (const group of currentGroups) {
      const snapshot = inspectGroup(root, group, action, false);
      if (!snapshot) continue;
      const state = groupSummaryState(snapshot, action);
      if (
        (state.status !== "current" && state.status !== "skipped") ||
        !state.hasGenerated
      ) {
        continue;
      }
      const summaryFingerprint = groupContentFingerprint(snapshot, action);
      const dependencyFingerprint = groupDependencyFingerprint(root, snapshot, action);
      const contentChanged =
        state.summaryFingerprint !== undefined &&
        state.summaryFingerprint !== summaryFingerprint;
      const dependenciesChanged =
        state.dependencyFingerprint !== undefined &&
        state.dependencyFingerprint !== dependencyFingerprint;
      const next = contentChanged || dependenciesChanged
        ? {
            ...state,
            status: "stale" as const,
            trigger: undefined,
            operationId: undefined,
            workFingerprint: undefined,
            affectedChildren: [],
            resumable: false,
            resumeAutomatic: undefined,
            sessionId: undefined,
          }
        : {
            ...state,
            summaryFingerprint: state.summaryFingerprint ?? summaryFingerprint,
            dependencyFingerprint: state.dependencyFingerprint ?? dependencyFingerprint,
          };
      if (next !== state) {
        refreshGroupsLocked(root, [group], action, "not-written", groupIndex(group), new Map([[group, next]]));
      }
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
        recoverPendingIntentsLocked(entry, "scan");
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
        reconcileSummaryWorkLocked(entry, "scan");
        refreshGroupsLocked(root, groups, "scan", "not-written", groupIndex(entry));
      });
    }
  }

  function refresh(rawGroup: string): void {
    const group = sanitizeGroupName(rawGroup, root);
    if (!assertSafeRoot(root, group, "refresh", true)) return;
    const top = group.split("/")[0];
    withGroupLock(top, "refresh", () => {
      recoverPendingIntentsLocked(top, "refresh");
      const tree = discoverGroupTree(root, top, "refresh");
      checkKnownGroups(top, tree, "refresh");
      if (!tree) return;
      const groups: string[] = [];
      if (!collectRelatedGroupOrder(tree, group, groups)) return;
      recordTree(tree);
      reconcileSummaryWorkLocked(top, "refresh");
      refreshGroupsLocked(root, groups, "refresh", "not-written", groupIndex(group));
    });
  }

  function sameSummarySnapshot(
    expected: ManagedGroupSummarySnapshot,
    actual: ManagedGroupSummarySnapshot,
  ): boolean {
    return expected.group === actual.group &&
      expected.revision === actual.revision &&
      expected.generation === actual.generation &&
      expected.summary === actual.summary &&
      expected.hasGeneratedSummary === actual.hasGeneratedSummary &&
      expected.status === actual.status &&
      expected.contentFingerprint === actual.contentFingerprint &&
      JSON.stringify(expected.entries) === JSON.stringify(actual.entries) &&
      JSON.stringify(expected.dependencies) === JSON.stringify(actual.dependencies);
  }

  function withSummaryCAS<T extends { status: "committed" | "skipped" | "failed" | "stale" }>(
    expected: ManagedGroupSummarySnapshot,
    action: string,
    operation: (
      current: ManagedGroupSummarySnapshot,
      state: GroupSummaryState,
      groups: string[],
    ) => T,
  ): T | { status: "stale" } {
    if (!expected || typeof expected.group !== "string") return { status: "stale" };
    const group = sanitizeGroupName(expected.group, root);
    if (!assertSafeRoot(root, group, action, true)) return { status: "stale" };
    const top = group.split("/")[0];
    return withGroupLock(top, action, () => {
      recoverPendingIntentsLocked(top, action);
      const tree = discoverGroupTree(root, top, action);
      checkKnownGroups(top, tree, action);
      if (!tree) return { status: "stale" };
      const groups: string[] = [];
      if (!collectRelatedGroupOrder(tree, group, groups)) return { status: "stale" };
      recordTree(tree);
      reconcileSummaryWorkLocked(top, action);
      refreshGroupsLocked(root, groups, action, "not-written", groupIndex(group));
      const target = inspectGroup(root, group, action, false);
      if (!target) return { status: "stale" };
      const state = groupSummaryState(target, action);
      if (!state.operationId || !state.trigger) return { status: "stale" };
      const work: ManagedGroupSummaryWork = {
        group,
        operationId: state.operationId,
        generation: state.generation,
        trigger: state.trigger,
      };
      const current = summarySnapshotForWork(work, action);
      if (!current || !sameSummarySnapshot(expected, current)) return { status: "stale" };
      for (const childGroup of state.affectedChildren) {
        const child = inspectGroup(root, childGroup, action, false);
        if (!child) return { status: "stale" };
        const childStatus = groupSummaryState(child, action).status;
        if (
          childStatus === "uninitialized" ||
          childStatus === "pending" ||
          childStatus === "stale" ||
          childStatus === "failed"
        ) {
          return { status: "stale" };
        }
      }
      return operation(current, state, groups);
    });
  }

  function pendingSummaryWork(): ManagedGroupSummaryWork[] {
    scan();
    const pending: ManagedGroupSummaryWork[] = [];
    let tops: string[];
    try {
      tops = readdirSync(root).filter(entry => !entry.startsWith(".")).sort();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError("<summary>", "summary", `the managed-skills root could not be scanned: ${reason}`, root, root, root);
    }
    for (const top of tops) {
      const stat = lstatOrNull(path.join(root, top));
      if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
      withGroupLock(top, "summary", () => {
        recoverPendingIntentsLocked(top, "summary");
        const tree = discoverGroupTree(root, top, "summary");
        checkKnownGroups(top, tree, "summary");
        if (!tree) return;
        recordTree(tree);
        reconcileSummaryWorkLocked(top, "summary");
        const groups = groupNamesInTree(tree);
        refreshGroupsLocked(root, groups, "summary", "not-written", groupIndex(top));
        for (const group of groups) {
          const snapshot = inspectGroup(root, group, "summary", false);
          if (!snapshot) continue;
          const work = workFromState(group, groupSummaryState(snapshot, "summary"));
          if (work?.trigger === "automatic") pending.push(work);
        }
      });
    }
    return pending;
  }

  function summarySnapshot(work: ManagedGroupSummaryWork): ManagedGroupSummarySnapshot | null {
    if (
      !work ||
      typeof work.group !== "string" ||
      typeof work.operationId !== "string" ||
      !Number.isSafeInteger(work.generation) ||
      (work.trigger !== "automatic" && work.trigger !== "manual")
    ) {
      return null;
    }
    const group = sanitizeGroupName(work.group, root);
    if (!assertSafeRoot(root, group, "summary snapshot", true)) return null;
    const top = group.split("/")[0];
    return withGroupLock(top, "summary snapshot", () => {
      recoverPendingIntentsLocked(top, "summary snapshot");
      const tree = discoverGroupTree(root, top, "summary snapshot");
      checkKnownGroups(top, tree, "summary snapshot");
      if (!tree) return null;
      const groups: string[] = [];
      if (!collectRelatedGroupOrder(tree, group, groups)) return null;
      recordTree(tree);
      reconcileSummaryWorkLocked(top, "summary snapshot");
      refreshGroupsLocked(root, groups, "summary snapshot", "not-written", groupIndex(group));
      return summarySnapshotForWork(work, "summary snapshot");
    });
  }

  function queueManualSummaryWork(): ManagedGroupSummaryWork[] {
    scan();
    const queued: ManagedGroupSummaryWork[] = [];
    let tops: string[];
    try {
      tops = readdirSync(root).filter(entry => !entry.startsWith(".")).sort();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw makeError("<summary>", "manual summary", `the managed-skills root could not be scanned: ${reason}`, root, root, root);
    }
    for (const top of tops) {
      const stat = lstatOrNull(path.join(root, top));
      if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
      withGroupLock(top, "manual summary", () => {
        recoverPendingIntentsLocked(top, "manual summary");
        const tree = discoverGroupTree(root, top, "manual summary");
        checkKnownGroups(top, tree, "manual summary");
        if (!tree) return;
        recordTree(tree);
        reconcileSummaryWorkLocked(top, "manual summary");
        const groups = groupNamesInTree(tree);
        refreshGroupsLocked(root, groups, "manual summary", "not-written", groupIndex(top));
        const operationId = randomBytes(16).toString("hex");
        const states = workStatesForPath(groups, operationId, "manual", "manual summary");
        refreshGroupsLocked(root, groups, "manual summary", "not-written", groupIndex(top), states);
        for (const group of groups) {
          const state = states.get(group)!;
          queued.push({ group, operationId, generation: state.generation, trigger: "manual" });
        }
      });
    }
    return queued;
  }

  function commitSummary(
    snapshot: ManagedGroupSummarySnapshot,
    description: string,
  ): { status: "committed" | "stale" } {
    const cleaned = sanitizeManagedDescription(description);
    if (!cleaned || Array.from(cleaned).length > 200) {
      throw makeError(snapshot?.group ?? "<summary>", "summary", "the generated group summary must be non-empty and at most 200 characters.", groupIndex(snapshot?.group ?? "<summary>"), groupIndex(snapshot?.group ?? "<summary>"), groupIndex(snapshot?.group ?? "<summary>"));
    }
    return withSummaryCAS(snapshot, "summary commit", (current, state, groups) => {
      const next: GroupSummaryState = {
        ...state,
        status: "current",
        summaryFingerprint: current.contentFingerprint,
        dependencyFingerprint: managedGroupDependencyFingerprint(current.dependencies),
        hasGenerated: true,
        preserveExistingDescription: false,
        trigger: undefined,
        operationId: undefined,
        workFingerprint: undefined,
        affectedChildren: [],
        resumable: false,
        resumeAutomatic: undefined,
        failureReason: undefined,
        sessionId: undefined,
      };
      refreshGroupsLocked(
        root,
        groups,
        "summary commit",
        "not-written",
        groupIndex(current.group),
        new Map([[current.group, next]]),
        new Map([[current.group, cleaned]]),
      );
      return { status: "committed" as const };
    });
  }

  function skipSummary(
    snapshot: ManagedGroupSummarySnapshot,
  ): { status: "skipped" | "stale" } {
    return withSummaryCAS(snapshot, "summary skip", (current, state, groups) => {
      if (!state.hasGenerated) return { status: "stale" as const };
      const next: GroupSummaryState = {
        ...state,
        status: "skipped",
        summaryFingerprint: current.contentFingerprint,
        dependencyFingerprint: managedGroupDependencyFingerprint(current.dependencies),
        trigger: undefined,
        operationId: undefined,
        workFingerprint: undefined,
        affectedChildren: [],
        resumable: false,
        resumeAutomatic: undefined,
        failureReason: undefined,
        sessionId: undefined,
      };
      refreshGroupsLocked(root, groups, "summary skip", "not-written", groupIndex(snapshot.group), new Map([[snapshot.group, next]]));
      return { status: "skipped" as const };
    });
  }

  function failSummary(
    snapshot: ManagedGroupSummarySnapshot,
    reason: string,
  ): { status: "failed" | "stale" } {
    return withSummaryCAS(snapshot, "summary failure", (current, state, groups) => {
      const restoreAutomatic =
        state.trigger === "manual" &&
        state.resumeAutomatic !== undefined &&
        state.workFingerprint === current.contentFingerprint;
      const next: GroupSummaryState = restoreAutomatic
        ? {
            ...state,
            status: "failed",
            generation: state.generation + 1,
            trigger: "automatic",
            operationId: randomBytes(16).toString("hex"),
            workFingerprint: current.contentFingerprint,
            affectedChildren: [...state.resumeAutomatic!.affectedChildren],
            resumable: true,
            resumeAutomatic: undefined,
            failureReason: String(reason).slice(0, 1000),
            sessionId: undefined,
          }
        : {
            ...state,
            status: "failed",
            failureReason: String(reason).slice(0, 1000),
            resumable: state.trigger === "automatic",
          };
      refreshGroupsLocked(root, groups, "summary failure", "not-written", groupIndex(snapshot.group), new Map([[snapshot.group, next]]));
      return { status: "failed" as const };
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
      recoverPendingIntentsLocked(group.split("/")[0], action);
      const createdDirectories: string[] = [];
      let createdMemberDirectory: string | undefined;
      let createIntent: ManagedGroupIntent | undefined;
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
          createIntent = appendIntent(group, name, prepared!, action);
          const memberDirectory = ensureMemberDirectory(root, before, name, action);
          createdMemberDirectory = memberDirectory.path;
          file = createMemberFile(root, before, memberDirectory, prepared!, action, createIntent!.temporaryName);
          skillStatus = "written";
        } else {
          if (!before) {
            throw makeError(group, action, `group "${group}" does not exist or has no managed members.`, groupIndex(group), targetSkillPath, groupIndex(group));
          }
          const member = findMember(before, name, action);
          if (action === "update") {
            if (member.description !== sanitizeManagedDescription(input.description!)) {
              assertWritableMember(before, member, root, action);
              createIntent = appendIntent(group, name, prepared!, action, member);
            }
            updateMemberFile(root, before, member, prepared!, action, createIntent?.temporaryName);
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
        const summaryStates = createIntent
          ? workStatesForPath(groups, createIntent.operationId, "automatic", action)
          : staleStatesForPath(groups, action);
        const indexes = refreshGroupsLocked(root, groups, action, "written", file, summaryStates);
        recordTree(tree);
        createdMemberDirectory = undefined;
        if (createIntent) {
          try {
            updateIntentStatus(top, createIntent.operationId, "completed", action);
          } catch (error) {
            const managedError = ensureManagedError(
              error,
              group,
              action,
              targetSkillPath,
              targetSkillPath,
              groupIndex(group),
              "written",
              "written",
            );
            managedError.indexes = indexes;
            throw managedError;
          }
        }
        return { path: file, indexes, summaryQueued: createIntent !== undefined };
      } catch (error) {
        const errorSkillStatus = mergeWriteStatus(
          error instanceof Error && "skillStatus" in error ? (error as ManagedGroupError).skillStatus : "not-written",
          skillStatus,
        );
        const errorIndexStatus = error instanceof Error && "indexStatus" in error
          ? (error as ManagedGroupError).indexStatus
          : "not-written";
        if (createIntent && errorSkillStatus === "not-written") {
          try {
            updateIntentStatus(group.split("/")[0], createIntent.operationId, "cancelled", action);
          } catch {
            // Startup recovery will cancel an intent whose target was never committed.
          }
        }
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

  function beginSession(): void {
    sessionId = randomBytes(16).toString("hex");
    scan();
  }

  const store = {
    beginSession,
    scan,
    refresh,
    mutate,
    isGroup,
    pendingSummaryWork,
    summarySnapshot,
    commitSummary,
    skipSummary,
    failSummary,
    queueManualSummaryWork,
  };
  scan();
  return store;
}
