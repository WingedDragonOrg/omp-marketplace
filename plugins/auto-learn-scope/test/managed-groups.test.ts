import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

type ManagedGroupInput = {
  group: string;
  action: "create" | "update" | "delete";
  name: string;
  description?: string;
  body?: string;
};
type IndexWriteResult = {
  group: string;
  path: string;
  status: "written" | "not-written" | "unknown";
  needsRebuild: boolean;
  reason?: "failed" | "not-attempted";
};
type ManagedGroupMutation = { path: string; indexes: IndexWriteResult[] };
type ManagedGroupFailure = Error & {
  skillStatus?: string;
  skillPath?: string;
  indexes?: IndexWriteResult[];
};
type ManagedGroupSummaryWork = {
  group: string;
  operationId: string;
  generation: number;
  trigger: "automatic" | "manual";
};
type ManagedGroupSummarySnapshot = {
  group: string;
  revision: string;
  generation: number;
  summary: string;
  hasGeneratedSummary: boolean;
  status: "uninitialized" | "pending" | "current" | "stale" | "failed" | "skipped";
  entries: Array<{ kind: "skill" | "group"; name: string; description: string }>;
  dependencies: Array<{
    group: string;
    revision: string;
    generation: number;
    status: "uninitialized" | "pending" | "current" | "stale" | "failed" | "skipped";
  }>;
  contentFingerprint: string;
};
type ManagedGroupStore = {
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
};
type ManagedGroupsModule = {
  createManagedGroupStore?: (root: string) => ManagedGroupStore;
};
const GROUP_INDEX_MARKER = "<!-- auto-learn-scope managed skill group index -->";

const modulePromise: Promise<ManagedGroupsModule> = import("../src/managed-groups")
  .then(module => module as ManagedGroupsModule);

const temporaryRoots: string[] = [];

async function createStoreFactory(): Promise<NonNullable<ManagedGroupsModule["createManagedGroupStore"]>> {
  const module = await modulePromise;
  if (typeof module.createManagedGroupStore !== "function") {
    throw new Error("src/managed-groups.ts must export createManagedGroupStore()");
  }
  return module.createManagedGroupStore;
}

async function makeManagedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-managed-groups-"));
  temporaryRoots.push(root);
  return realpath(root);
}

async function makeOutsideDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-managed-groups-outside-"));
  temporaryRoots.push(root);
  return realpath(root);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function groupSkillFile(root: string, group: string): string {
  return join(root, group, "SKILL.md");
}

function memberSkillFile(root: string, group: string, directory: string): string {
  return join(root, group, directory, "SKILL.md");
}

function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

function groupIndexMetadata(index: string): {
  description: string;
  revision?: string;
  summaryState?: { status: string };
} {
  const frontmatter = index.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) throw new Error("group index is missing frontmatter");
  return Bun.YAML.parse(frontmatter[1]) as {
    description: string;
    revision?: string;
    summaryState?: { status: string };
  };
}

async function writeMember(
  root: string,
  group: string,
  directory: string,
  name: string,
  description: string,
  body = `Body for ${name}.`,
): Promise<string> {
  const file = memberSkillFile(root, group, directory);
  await mkdir(join(root, group, directory), { recursive: true });
  await writeFile(file, skillText(name, description, body), "utf8");
  return file;
}

function expectIndexEntry(
  index: string,
  name: string,
  uri: string,
  kind: "group" | "skill",
): void {
  const lines = index.split(/\r?\n/);
  const uriLine = lines.findIndex(line => line.includes(uri));
  expect(uriLine).toBeGreaterThanOrEqual(0);
  expect(index).toContain(name);
  const label = lines.slice(Math.max(0, uriLine - 3), uriLine).join("\n");
  expect(label).toMatch(kind === "group" ? /\bgroup\b|\bsubgroup\b/i : /\bskill\b/i);
}

function runChildMutation(root: string, group: string, name: string): Promise<void> {
  const moduleUrl = new URL("../src/managed-groups.ts", import.meta.url).href;
  const source = `
    (async () => {
      const { createManagedGroupStore } = await import(${JSON.stringify(moduleUrl)});
      createManagedGroupStore(${JSON.stringify(root)}).mutate({
        group: ${JSON.stringify(group)},
        action: "create",
        name: ${JSON.stringify(name)},
        description: ${JSON.stringify(`Description for ${name}.`)},
        body: ${JSON.stringify(`Body for ${name}.`)},
      });
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`managed group child failed (${signal ?? code}): ${stderr}`));
    }
  });
  return promise;
}

function runInterruptedChildCreate(root: string, group: string, name: string): Promise<{ code: number | null; stderr: string }> {
  // Register the filesystem interruption before importing the storage module in the child.
  const moduleUrl = new URL("../src/managed-groups.ts", import.meta.url).href;
  const memberPath = memberSkillFile(root, group, name);
  const source = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const originalLinkSync = fs.linkSync;
    mock.module("node:fs", () => ({
      ...fs,
      linkSync(source, destination) {
        originalLinkSync(source, destination);
        if (String(destination) === ${JSON.stringify(memberPath)}) process.exit(86);
      },
    }));
    const { createManagedGroupStore } = await import(${JSON.stringify(moduleUrl)});
    createManagedGroupStore(${JSON.stringify(root)}).mutate({
      group: ${JSON.stringify(group)},
      action: "create",
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(`Description for ${name}.`)},
      body: ${JSON.stringify(`Body for ${name}.`)},
    });
  `;
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stderr: string }>();
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });
  child.once("error", reject);
  child.once("close", code => resolve({ code, stderr }));
  return promise;
}

function runInterruptedDescriptionUpdate(root: string, group: string, directory: string, before: boolean): Promise<number | null> {
  const moduleUrl = new URL("../src/managed-groups.ts", import.meta.url).href;
  const memberPath = memberSkillFile(root, group, directory);
  const source = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const rename = fs.renameSync;
    mock.module("node:fs", () => ({
      ...fs,
      renameSync(from, to) {
        if (String(to) === ${JSON.stringify(memberPath)} && ${JSON.stringify(before)}) process.exit(86);
        rename(from, to);
        if (String(to) === ${JSON.stringify(memberPath)}) process.exit(87);
      },
    }));
    const { createManagedGroupStore } = await import(${JSON.stringify(moduleUrl)});
    createManagedGroupStore(${JSON.stringify(root)}).mutate({
      group: ${JSON.stringify(group)}, action: "update", name: "member",
      description: "Updated description.", body: "Updated body.",
    });
  `;
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  child.once("error", reject);
  child.once("close", resolve);
  return promise;
}

function runInterruptedChildCreateAfterIndex(
  root: string,
  group: string,
  name: string,
): Promise<{ code: number | null; stderr: string }> {
  const moduleUrl = new URL("../src/managed-groups.ts", import.meta.url).href;
  const indexPath = groupSkillFile(root, group);
  const source = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const originalRenameSync = fs.renameSync;
    mock.module("node:fs", () => ({
      ...fs,
      renameSync(from, to) {
        originalRenameSync(from, to);
        if (String(to) === ${JSON.stringify(indexPath)}) process.exit(87);
      },
    }));
    const { createManagedGroupStore } = await import(${JSON.stringify(moduleUrl)});
    createManagedGroupStore(${JSON.stringify(root)}).mutate({
      group: ${JSON.stringify(group)},
      action: "create",
      name: ${JSON.stringify(name)},
      description: ${JSON.stringify(`Description for ${name}.`)},
      body: ${JSON.stringify(`Body for ${name}.`)},
    });
  `;
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stderr: string }>();
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });
  child.once("error", reject);
  child.once("close", code => resolve({ code, stderr }));
  return promise;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("managed skill group storage", () => {
  test("indexes a member description containing an unquoted colon accepted by OMP", async () => {
    const root = await makeManagedRoot();
    const file = join(root, "quality", "diagnosis", "SKILL.md");
    const contents = "---\nname: diagnosis\ndescription: Diagnose a child hang: inspect stdout and process cleanup.\n---\n\nOriginal body.\n";
    await mkdir(join(root, "quality", "diagnosis"), { recursive: true });
    await writeFile(file, contents, "utf8");

    const createStore = await createStoreFactory();
    createStore(root);

    const index = await readFile(groupSkillFile(root, "quality"), "utf8");
    expect(index).toContain("diagnosis");
    expect(index).toContain("Diagnose a child hang: inspect stdout and process cleanup.");
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  test("a symlinked managed root supports discovery and grouped writes", async () => {
    const parent = await makeManagedRoot();
    const target = await makeOutsideDirectory();
    const root = join(parent, "managed-skills");
    await symlink(target, root, "dir");
    await writeMember(target, "database", "existing", "existing", "Existing database skill.");

    const createStore = await createStoreFactory();
    const store = createStore(root);
    expect(await readFile(groupSkillFile(target, "database"), "utf8")).toContain("Existing database skill.");

    store.mutate({
      group: "database",
      action: "create",
      name: "new-skill",
      description: "New database skill.",
      body: "New skill body.",
    });
    expect(await readFile(memberSkillFile(target, "database", "new-skill"), "utf8")).toContain("New skill body.");
    expect(await readFile(groupSkillFile(target, "database"), "utf8")).toContain("New database skill.");
    expect(await readlink(root)).toBe(target);
  });

  test("a retargeted parent symlink cannot redirect writes from the original managed root", async () => {
    const parent = await makeManagedRoot();
    const original = await makeOutsideDirectory();
    const replacement = await makeOutsideDirectory();
    const alias = join(parent, "alias");
    await mkdir(join(original, "managed"));
    await mkdir(join(replacement, "managed"));
    await symlink(original, alias, "dir");
    const createStore = await createStoreFactory();
    const store = createStore(join(alias, "managed"));
    await rm(alias);
    await symlink(replacement, alias, "dir");

    store.mutate({ group: "safe", action: "create", name: "member", description: "Safe.", body: "Body." });
    expect(await pathExists(memberSkillFile(join(original, "managed"), "safe", "member"))).toBe(true);
    expect(await pathExists(memberSkillFile(join(replacement, "managed"), "safe", "member"))).toBe(false);
  });

  test("an initially missing root stays pinned to the resolved startup ancestor", async () => {
    const parent = await makeManagedRoot();
    const original = await makeOutsideDirectory();
    const replacement = await makeOutsideDirectory();
    const alias = join(parent, "alias");
    await symlink(original, alias, "dir");
    const root = join(alias, "managed");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    expect(await pathExists(join(original, "managed"))).toBe(false);
    await rm(alias);
    await symlink(replacement, alias, "dir");

    store.mutate({ group: "safe", action: "create", name: "member", description: "Safe.", body: "Body." });
    expect(await pathExists(memberSkillFile(join(original, "managed"), "safe", "member"))).toBe(true);
    expect(await pathExists(memberSkillFile(join(replacement, "managed"), "safe", "member"))).toBe(false);
  });

  test("startup scan creates an index for a hand-built group without changing a flat skill", async () => {
    const root = await makeManagedRoot();
    const longDescription = `Finds read-only database diagnostics. ${"Use this when reviewing database capacity. ".repeat(8)}`;
    const member = await writeMember(
      root,
      "database",
      "capacity-audit",
      "database-capacity-audit",
      longDescription,
      "Read-only capacity procedure.",
    );
    const flatFile = join(root, "standalone", "SKILL.md");
    const flatContents = skillText("standalone", "A flat managed skill.", "Keep this file unchanged.");
    await mkdir(join(root, "standalone"), { recursive: true });
    await writeFile(flatFile, flatContents, "utf8");

    const createStore = await createStoreFactory();
    createStore(root);

    const index = await readFile(groupSkillFile(root, "database"), "utf8");
    expect(index).toContain(longDescription.trimEnd());
    expect(index).toContain("database-capacity-audit");
    expect(index).toContain("skill://database/capacity-audit/SKILL.md");
    expect(index).not.toContain("standalone");
    expect(await readFile(member, "utf8")).toBe(
      skillText("database-capacity-audit", longDescription, "Read-only capacity procedure."),
    );
    expect(await readFile(flatFile, "utf8")).toBe(flatContents);
  });

  test("scan builds three nested indexes with only direct skills and child groups", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "engineering", "root-folder", "architecture-runbook", "Root direct member.");
    await writeMember(root, "engineering/database", "database-folder", "database-guide", "Middle direct member.");
    await writeMember(
      root,
      "engineering/database/postgresql",
      "postgres-folder",
      "postgres-guide",
      "Leaf direct member.",
    );
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.scan();

    const rootIndex = await readFile(groupSkillFile(root, "engineering"), "utf8");
    const databaseIndex = await readFile(groupSkillFile(root, "engineering/database"), "utf8");
    const postgresIndex = await readFile(groupSkillFile(root, "engineering/database/postgresql"), "utf8");

    expectIndexEntry(
      rootIndex,
      "architecture-runbook",
      "skill://engineering/root-folder/SKILL.md",
      "skill",
    );
    expectIndexEntry(rootIndex, "database", "skill://engineering/database/SKILL.md", "group");
    expect(rootIndex).toContain("Root direct member.");
    expect(rootIndex).toContain("Middle direct member.");
    expect(rootIndex).not.toContain("database-guide");
    expect(rootIndex).not.toContain("postgres-guide");

    expectIndexEntry(
      databaseIndex,
      "database-guide",
      "skill://engineering/database/database-folder/SKILL.md",
      "skill",
    );
    expect(databaseIndex).toContain("Middle direct member.");
    expect(databaseIndex).toContain("Leaf direct member.");
    expectIndexEntry(
      databaseIndex,
      "postgresql",
      "skill://engineering/database/postgresql/SKILL.md",
      "group",
    );
    expect(databaseIndex).not.toContain("architecture-runbook");
    expect(databaseIndex).not.toContain("postgres-guide");

    expect(postgresIndex).toContain("Leaf direct member.");
    expectIndexEntry(
      postgresIndex,
      "postgres-guide",
      "skill://engineering/database/postgresql/postgres-folder/SKILL.md",
      "skill",
    );
    expect(postgresIndex).not.toContain("architecture-runbook");
    expect(postgresIndex).not.toContain("database-guide");
  });
  test("a member with a whitespace-only parsed description is rejected without rewriting it", async () => {
    const root = await makeManagedRoot();
    const group = join(root, "empty-description");
    const member = join(group, "manual-folder", "SKILL.md");
    const contents = '---\nname: empty-description-skill\ndescription: "   "\n---\n\nMember body.\n';
    await mkdir(join(group, "manual-folder"), { recursive: true });
    await writeFile(member, contents, "utf8");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/empty description/i);
    expect(await readFile(member, "utf8")).toBe(contents);
  });

  test("group indexes preserve the complete parsed member description", async () => {
    const root = await makeManagedRoot();
    const group = join(root, "raw-description");
    const member = join(group, "manual-folder", "SKILL.md");
    const description = "Keep `--literal` <tag> exactly.\nSecond  line stays on its own.";
    await mkdir(join(group, "manual-folder"), { recursive: true });
    await writeFile(
      member,
      "---\nname: raw-description-skill\ndescription: |-\n  Keep `--literal` <tag> exactly.\n  Second  line stays on its own.\n---\n\nMember body.\n",
      "utf8",
    );
    const createStore = await createStoreFactory();

    createStore(root);

    const index = await readFile(groupSkillFile(root, "raw-description"), "utf8");
    const frontmatter = index.match(/^---\n([\s\S]*?)\n---/);
    expect(index).toContain(description);
    expect(frontmatter).not.toBeNull();
    const parsed = Bun.YAML.parse(frontmatter![1]) as { description: string };
    expect(parsed.description).not.toContain("`");
    expect(parsed.description).not.toContain("<");
    expect(parsed.description).not.toContain("\n");
  });

  test("group index skill URIs encode manual path segments and preserve ordinary URIs", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "encoded-paths", "folder #?", "special-skill", "Special directory.");
    await writeMember(root, "encoded-paths", "ordinary-folder", "ordinary-skill", "Ordinary directory.");
    const createStore = await createStoreFactory();

    createStore(root);

    const index = await readFile(groupSkillFile(root, "encoded-paths"), "utf8");
    expect(index).toContain("skill://encoded-paths/folder%20%23%3F/SKILL.md");
    expect(index).toContain("skill://encoded-paths/ordinary-folder/SKILL.md");
    expect(index).not.toContain("skill://encoded-paths/folder #?/SKILL.md");
  });


  test("scan discovers a group added after store creation", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    await writeMember(root, "observability", "log-review", "log-review", "Review service logs.");

    store.scan();

    const index = await readFile(groupSkillFile(root, "observability"), "utf8");
    expect(index).toContain("log-review");
    expect(index).toContain("skill://observability/log-review/SKILL.md");
  });

  test("refresh rebuilds the index from manual member edits, additions, and removals", async () => {
    const root = await makeManagedRoot();
    const removedMember = await writeMember(root, "operations", "old-folder", "old-runbook", "Old description.");
    const editedMember = await writeMember(root, "operations", "manual-folder", "manual-runbook", "Before manual edit.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    await writeFile(
      editedMember,
      skillText("manual-runbook", "Updated manual description.", "Manually revised body."),
      "utf8",
    );
    await writeMember(root, "operations", "new-folder", "new-runbook", "Newly added description.");
    await rm(removedMember);

    store.refresh("operations");

    const index = await readFile(groupSkillFile(root, "operations"), "utf8");
    expect(index).toContain("manual-runbook");
    expect(index).toContain("Updated manual description.");
    expect(index).toContain("skill://operations/manual-folder/SKILL.md");
    expect(index).toContain("new-runbook");
    expect(index).toContain("Newly added description.");
    expect(index).toContain("skill://operations/new-folder/SKILL.md");
    expect(index).not.toContain("old-runbook");
    expect(index).not.toContain("skill://operations/old-folder/SKILL.md");
    expect(await readFile(editedMember, "utf8")).toBe(
      skillText("manual-runbook", "Updated manual description.", "Manually revised body."),
    );
  });

  test("mutations create, update by frontmatter name, and delete the mapped directory", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "workflows", "legacy-read-folder", "read-the-runbook", "Before update.", "Old body.");
    await writeMember(root, "workflows", "retired-folder", "retired-process", "To remove.");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    const created = store.mutate({
      group: "workflows",
      action: "create",
      name: "new-process",
      description: "A new process.",
      body: "New process body.",
    });
    const updated = store.mutate({
      group: "workflows",
      action: "update",
      name: "read-the-runbook",
      description: "After update.",
      body: "Updated body.",
    });
    const deleted = store.mutate({ group: "workflows", action: "delete", name: "retired-process" });

    expect(created.path).toBe(memberSkillFile(root, "workflows", "new-process"));
    expect(updated.path).toBe(memberSkillFile(root, "workflows", "legacy-read-folder"));
    expect(deleted.path).toBe(memberSkillFile(root, "workflows", "retired-folder"));
    expect(await readFile(created.path, "utf8")).toBe(skillText("new-process", "A new process.", "New process body."));
    expect(await readFile(updated.path, "utf8")).toBe(skillText("read-the-runbook", "After update.", "Updated body."));
    expect(await pathExists(deleted.path)).toBe(false);
    expect(await pathExists(memberSkillFile(root, "workflows", "read-the-runbook"))).toBe(false);

    const index = await readFile(groupSkillFile(root, "workflows"), "utf8");
    expect(index).toContain("new-process");
    expect(index).toContain("After update.");
    expect(index).not.toContain("retired-process");
  });

  test("a recursive delete failure reports unknown after partially removing a member", async () => {
    const root = await makeManagedRoot();
    const memberDirectory = join(root, "partial-delete", "member-folder");
    const removable = join(memberDirectory, "0-removable.txt");
    const blockedDirectory = join(memberDirectory, "1-blocked");
    const blockedFile = join(blockedDirectory, "child.txt");
    const member = memberSkillFile(root, "partial-delete", "member-folder");
    await mkdir(memberDirectory, { recursive: true });
    await writeFile(removable, "This entry is removed before the blocked directory.", "utf8");
    await mkdir(blockedDirectory);
    await writeFile(blockedFile, "The non-writable directory prevents completion.", "utf8");
    await writeFile(member, skillText("partial-delete-member", "A member used to test partial deletion.", "Body."), "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    await chmod(blockedDirectory, 0o500);

    let failure: unknown;
    try {
      store.mutate({ group: "partial-delete", action: "delete", name: "partial-delete-member" });
    } catch (error) {
      failure = error;
    } finally {
      if (await pathExists(blockedDirectory)) await chmod(blockedDirectory, 0o700);
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as ManagedGroupFailure).skillStatus).toBe("unknown");
    expect((await pathExists(member)) && (await pathExists(removable))).toBe(false);
    expect(await pathExists(blockedFile)).toBe(true);
  });

  test("nested create, update, and delete report every index from target group to top level", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const group = "platform/data/postgresql";
    const indexGroups = ["platform/data/postgresql", "platform/data", "platform"];
    const expectSuccessfulIndexes = (result: ManagedGroupMutation) => {
      expect(result.indexes.map(({ group: indexedGroup, path, status, needsRebuild }) => ({
        group: indexedGroup,
        path,
        status,
        needsRebuild,
      }))).toEqual(indexGroups.map(indexedGroup => ({
        group: indexedGroup,
        path: groupSkillFile(root, indexedGroup),
        status: "written",
        needsRebuild: false,
      })));
    };

    const created = store.mutate({
      group,
      action: "create",
      name: "query-plan-review",
      description: "Review PostgreSQL query plans.",
      body: "Check the plan.",
    });
    expect(created.path).toBe(memberSkillFile(root, group, "query-plan-review"));
    expectSuccessfulIndexes(created);
    for (const indexedGroup of indexGroups) {
      expect(await pathExists(groupSkillFile(root, indexedGroup))).toBe(true);
    }
    expect(await readFile(groupSkillFile(root, "platform"), "utf8")).toContain("skill://platform/data/SKILL.md");
    expect(await readFile(groupSkillFile(root, "platform/data"), "utf8")).toContain(
      "skill://platform/data/postgresql/SKILL.md",
    );
    expect(await readFile(groupSkillFile(root, group), "utf8")).toContain("query-plan-review");

    const updated = store.mutate({
      group,
      action: "update",
      name: "query-plan-review",
      description: "Explain PostgreSQL query plans.",
      body: "Compare estimated and actual rows.",
    });
    expect(updated.path).toBe(created.path);
    expectSuccessfulIndexes(updated);
    expect(await readFile(created.path, "utf8")).toBe(
      skillText("query-plan-review", "Explain PostgreSQL query plans.", "Compare estimated and actual rows."),
    );
    expect(await readFile(groupSkillFile(root, group), "utf8")).toContain("Explain PostgreSQL query plans.");

    const deleted = store.mutate({ group, action: "delete", name: "query-plan-review" });
    expect(deleted.path).toBe(created.path);
    expectSuccessfulIndexes(deleted);
    expect(await pathExists(created.path)).toBe(false);
    expect(await readFile(groupSkillFile(root, group), "utf8")).not.toContain("query-plan-review");
    expect(await readFile(groupSkillFile(root, "platform"), "utf8")).not.toContain("query-plan-review");
  });

  test("create makes a missing group and its index", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);

    const result = store.mutate({
      group: "new-group",
      action: "create",
      name: "first-skill",
      description: "A first member.",
      body: "First member body.",
    });

    expect(result.path).toBe(memberSkillFile(root, "new-group", "first-skill"));
    expect(await readFile(result.path, "utf8")).toBe(
      skillText("first-skill", "A first member.", "First member body."),
    );
    const index = await readFile(groupSkillFile(root, "new-group"), "utf8");
    expect(index).toContain("first-skill");
    expect(index).toContain("skill://new-group/first-skill/SKILL.md");
  });

  test("deleting the last member preserves a reusable empty group index", async () => {
    const root = await makeManagedRoot();
    const member = await writeMember(root, "reusable", "first-skill", "first-skill", "First member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    store.mutate({ group: "reusable", action: "delete", name: "first-skill" });

    expect(await pathExists(member)).toBe(false);
    expect(await pathExists(groupSkillFile(root, "reusable"))).toBe(true);
    const created = store.mutate({
      group: "reusable",
      action: "create",
      name: "second-skill",
      description: "Second member.",
      body: "Second body.",
    });
    expect(created.path).toBe(memberSkillFile(root, "reusable", "second-skill"));
    expect(await readFile(groupSkillFile(root, "reusable"), "utf8")).toContain("second-skill");
  });

  test("a failed create removes its empty member directory so a retry can proceed", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "retryable", "existing", "existing-skill", "Existing member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const newMemberDirectory = join(root, "retryable", "retry-skill");
    const originalUmask = process.umask(0o222);
    let failure: unknown;
    try {
      store.mutate({
        group: "retryable",
        action: "create",
        name: "retry-skill",
        description: "Retry member.",
        body: "Retry after cleanup.",
      });
    } catch (error) {
      failure = error;
    } finally {
      process.umask(originalUmask);
    }

    expect(failure).toBeInstanceOf(Error);
    expect(await pathExists(newMemberDirectory)).toBe(false);
    const retry = store.mutate({
      group: "retryable",
      action: "create",
      name: "retry-skill",
      description: "Retry member.",
      body: "Retry after cleanup.",
    });
    expect(await readFile(retry.path, "utf8")).toBe(
      skillText("retry-skill", "Retry member.", "Retry after cleanup."),
    );
  });

  test("an empty skill name is rejected without creating or changing user files", async () => {
    const root = await makeManagedRoot();
    const keep = join(root, "keep.txt");
    await writeFile(keep, "user data", "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    expect(() => store.mutate({
      group: "safe-group",
      action: "create",
      name: "",
      description: "Invalid target.",
      body: "Must not be written.",
    })).toThrow(/name|invalid|skill/i);

    expect(await pathExists(join(root, "safe-group"))).toBe(false);
    expect(await readFile(keep, "utf8")).toBe("user data");
  });

  test("group paths reject empty segments and traversal without touching outside files", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const keep = join(outside, "keep.txt");
    await writeFile(keep, "outside user data", "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const invalidGroups = ["safe//child", relative(root, outside)];

    for (const group of invalidGroups) {
      expect(() => store.mutate({
        group,
        action: "create",
        name: "escaped-skill",
        description: "Must not be written outside the root.",
        body: "Must not be written.",
      })).toThrow();
    }

    expect(await pathExists(join(root, "safe"))).toBe(false);
    expect(await pathExists(join(outside, "escaped-skill"))).toBe(false);
    expect(await readFile(keep, "utf8")).toBe("outside user data");
  });

  test("a nested group cannot be created beneath an ordinary skill", async () => {
    const root = await makeManagedRoot();
    const ordinaryIndex = groupSkillFile(root, "engineering");
    const contents = skillText("engineering", "An ordinary managed skill.", "Keep this file unchanged.");
    await mkdir(join(root, "engineering"), { recursive: true });
    await writeFile(ordinaryIndex, contents, "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    expect(() => store.mutate({
      group: "engineering/database",
      action: "create",
      name: "query-guide",
      description: "Must not replace the ordinary skill.",
      body: "Must not be written.",
    })).toThrow();

    expect(await readFile(ordinaryIndex, "utf8")).toBe(contents);
    expect(await pathExists(join(root, "engineering/database"))).toBe(false);
  });

  test("a member without a frontmatter name is reported without rewriting it", async () => {
    const root = await makeManagedRoot();
    const group = join(root, "incomplete");
    const member = join(group, "unnamed", "SKILL.md");
    const contents = "---\ndescription: Missing required name.\n---\n\nUser-owned content.\n";
    await mkdir(join(group, "unnamed"), { recursive: true });
    await writeFile(member, contents, "utf8");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/name|frontmatter|skill/i);
    expect(await readFile(member, "utf8")).toBe(contents);
  });

  test("duplicate frontmatter names stop indexing without changing either member", async () => {
    const root = await makeManagedRoot();
    const first = await writeMember(root, "collision", "first-folder", "same-name", "First description.");
    const second = await writeMember(root, "collision", "second-folder", "same-name", "Second description.");
    const firstContents = await readFile(first, "utf8");
    const secondContents = await readFile(second, "utf8");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/duplicate|conflict|name/i);
    expect(await readFile(first, "utf8")).toBe(firstContents);
    expect(await readFile(second, "utf8")).toBe(secondContents);
  });

  test("a symlinked group directory is reported and its target remains untouched", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const outsideMember = await writeMember(outside, "", "child", "external-skill", "External member.");
    const linkedGroup = join(root, "linked-group");
    await symlink(outside, linkedGroup, "dir");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/symlink|link|conflict/i);
    expect(await readlink(linkedGroup)).toBe(outside);
    expect(await readFile(outsideMember, "utf8")).toBe(skillText("external-skill", "External member.", "Body for external-skill."));
    expect(await pathExists(join(outside, "SKILL.md"))).toBe(false);
  });

  test("a nested group symlink blocks creation without touching its target", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const keep = join(outside, "keep.txt");
    const linkedGroup = join(root, "engineering", "linked");
    await writeMember(root, "engineering", "runbook", "engineering-runbook", "Parent member.");
    await writeFile(keep, "outside user data", "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    await symlink(outside, linkedGroup, "dir");

    expect(() => store.mutate({
      group: "engineering/linked",
      action: "create",
      name: "must-not-escape",
      description: "Must not be written outside the managed root.",
      body: "Must not be written.",
    })).toThrow();

    expect(await readlink(linkedGroup)).toBe(outside);
    expect(await readFile(keep, "utf8")).toBe("outside user data");
    expect(await pathExists(join(outside, "must-not-escape"))).toBe(false);
  });

  test("a symlinked group index is reported without replacing its target", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const target = join(outside, "keep.md");
    const linkedIndex = groupSkillFile(root, "linked-index");
    await writeMember(root, "linked-index", "child", "child-skill", "Child member.");
    const targetContents = "---\nname: linked-index\ndescription: Existing group.\n---\n\n<!-- auto-learn-scope managed skill group index -->\n";
    await writeFile(target, targetContents, "utf8");
    await symlink(target, linkedIndex, "file");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/symlink|link|conflict/i);
    expect(await readlink(linkedIndex)).toBe(target);
    expect(await readFile(target, "utf8")).toBe(targetContents);
  });

  test("a symlinked ordinary skill with nested files is not converted into a group", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const target = join(outside, "ordinary.md");
    const contents = skillText("ordinary", "An ordinary skill.", "Preserve this content.");
    await writeMember(root, "ordinary", "child", "child-skill", "Nested file.");
    await writeFile(target, contents);
    await symlink(target, groupSkillFile(root, "ordinary"), "file");

    const createStore = await createStoreFactory();
    const store = createStore(root);
    expect(() => store.mutate({ group: "ordinary", action: "create", name: "new-skill", description: "New.", body: "Body." })).toThrow();
    expect(await readFile(target, "utf8")).toBe(contents);
    expect(await readlink(groupSkillFile(root, "ordinary"))).toBe(target);
  });

  test("a symlinked member can be indexed but cannot be overwritten through its target", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const externalDirectory = join(outside, "externally-managed");
    const externalSkill = join(externalDirectory, "SKILL.md");
    const memberLink = join(root, "linked-member", "external-folder");
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(externalSkill, skillText("external-skill", "External member description.", "Managed elsewhere."), "utf8");
    await mkdir(join(root, "linked-member"), { recursive: true });
    await symlink(externalDirectory, memberLink, "dir");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const original = await readFile(externalSkill, "utf8");

    const index = await readFile(groupSkillFile(root, "linked-member"), "utf8");
    expect(index).toContain("External member description.");
    expect(index).toContain("skill://linked-member/external-folder/SKILL.md");
    expect(() => store.mutate({
      group: "linked-member",
      action: "update",
      name: "external-skill",
      description: "Must not replace link target.",
      body: "Must not replace link target.",
    })).toThrow(/symlink|link|conflict|safe|overwrite/i);
    expect(await readlink(memberLink)).toBe(externalDirectory);
    expect(await readFile(externalSkill, "utf8")).toBe(original);
  });

  test("an unmarked top-level skill is skipped by scans and conflicts on group mutation", async () => {
    const root = await makeManagedRoot();
    const userIndex = groupSkillFile(root, "user-owned");
    const contents = skillText("user-owned", "A manually maintained top-level skill.", "Do not replace this.");
    const child = await writeMember(root, "user-owned", "child", "child-skill", "Child description.");
    const childContents = await readFile(child, "utf8");
    await writeFile(userIndex, contents, "utf8");
    const createStore = await createStoreFactory();
    const store = createStore(root);

    expect(() => store.scan()).not.toThrow();
    expect(() => store.mutate({
      group: "user-owned",
      action: "create",
      name: "new-skill",
      description: "Must not be written.",
      body: "Must not be written.",
    })).toThrow(/marked|index|conflict|overwrite|user|SKILL|exists/i);
    expect(await readFile(userIndex, "utf8")).toBe(contents);
    expect(await readFile(child, "utf8")).toBe(childContents);
    expect(await pathExists(memberSkillFile(root, "user-owned", "new-skill"))).toBe(false);
  });

  test("only a marker in its reserved position identifies a group index", async () => {
    const cases = [
      {
        group: "marker-in-body",
        contents: skillText(
          "marker-in-body",
          "A user-authored skill.",
          `Keep this prose.\n\n${GROUP_INDEX_MARKER}`,
        ),
      },
      {
        group: "marker-without-blank",
        contents: `---\nname: marker-without-blank\ndescription: A user-authored skill.\n---\n${GROUP_INDEX_MARKER}\n\nKeep this file.\n`,
      },
    ];
    const createStore = await createStoreFactory();

    for (const { group, contents } of cases) {
      const root = await makeManagedRoot();
      const child = await writeMember(root, group, "child-folder", `${group}-child`, "Child member.");
      const childContents = await readFile(child, "utf8");
      const index = groupSkillFile(root, group);
      await writeFile(index, contents, "utf8");
      const store = createStore(root);

      expect(store.isGroup(group)).toBe(false);
      expect(() => store.scan()).not.toThrow();
      expect(await readFile(index, "utf8")).toBe(contents);
      expect(() => store.mutate({
        group,
        action: "create",
        name: "blocked-skill",
        description: "Must not overwrite the user-owned index.",
        body: "Must not be written.",
      })).toThrow();
      expect(await readFile(index, "utf8")).toBe(contents);
      expect(await readFile(child, "utf8")).toBe(childContents);
      expect(await pathExists(memberSkillFile(root, group, "blocked-skill"))).toBe(false);
    }
  });

  test("concurrent child processes leave every successful member in the group index", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "parallel", "seed", "seed-skill", "Seed member.");
    const createStore = await createStoreFactory();
    createStore(root);
    const names = ["first-worker", "second-worker", "third-worker", "fourth-worker"];

    await Promise.all(names.map(name => runChildMutation(root, "parallel", name)));

    const index = await readFile(groupSkillFile(root, "parallel"), "utf8");
    for (const name of names) {
      expect(await pathExists(memberSkillFile(root, "parallel", name))).toBe(true);
      expect(index).toContain(name);
      expect(index).toContain(`skill://parallel/${name}/SKILL.md`);
    }
  });

  test("concurrent processes updating different branches preserve every nested index", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "parallel/alpha", "seed", "alpha-seed", "Alpha seed member.");
    await writeMember(root, "parallel/beta", "seed", "beta-seed", "Beta seed member.");
    const createStore = await createStoreFactory();
    createStore(root);

    await Promise.all([
      runChildMutation(root, "parallel/alpha", "alpha-worker"),
      runChildMutation(root, "parallel/beta", "beta-worker"),
    ]);

    const rootIndex = await readFile(groupSkillFile(root, "parallel"), "utf8");
    const alphaIndex = await readFile(groupSkillFile(root, "parallel/alpha"), "utf8");
    const betaIndex = await readFile(groupSkillFile(root, "parallel/beta"), "utf8");
    expect(rootIndex).toContain("skill://parallel/alpha/SKILL.md");
    expect(rootIndex).toContain("skill://parallel/beta/SKILL.md");
    expect(alphaIndex).toContain("alpha-seed");
    expect(alphaIndex).toContain("alpha-worker");
    expect(betaIndex).toContain("beta-seed");
    expect(betaIndex).toContain("beta-worker");
    expect(await pathExists(memberSkillFile(root, "parallel/alpha", "alpha-worker"))).toBe(true);
    expect(await pathExists(memberSkillFile(root, "parallel/beta", "beta-worker"))).toBe(true);
  });
  test("group descriptions are capped at 200 Unicode characters and index ordering is stable", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "summaries", "z-folder", "z-skill", "Z description.");
    await writeMember(root, "summaries", "a-folder", "a-skill", "A description.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const file = groupSkillFile(root, "summaries");
    const index = await readFile(file, "utf8");
    const frontmatter = index.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    const parsed = Bun.YAML.parse(frontmatter![1]) as { description: string };
    expect([...parsed.description].length).toBeLessThanOrEqual(200);
    expect(index.indexOf("a-skill")).toBeLessThan(index.indexOf("z-skill"));

    const before = await stat(file);
    store.refresh("summaries");
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
  test("long group descriptions truncate on a Unicode character boundary", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "unicode-summary", "member-folder", "member-skill", "🙂".repeat(250));
    const createStore = await createStoreFactory();
    createStore(root);
    const index = await readFile(groupSkillFile(root, "unicode-summary"), "utf8");
    const frontmatter = index.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter).not.toBeNull();
    const parsed = Bun.YAML.parse(frontmatter![1]) as { description: string };
    expect([...parsed.description]).toHaveLength(200);
    expect(parsed.description).not.toContain("\uFFFD");
  });
  test("isGroup only reads marked indexes and refresh reports corrupted indexes", async () => {
    const root = await makeManagedRoot();
    const flatFile = join(root, "plain-skill", "SKILL.md");
    const flatContents = skillText("plain-skill", "Ordinary flat skill.", "Keep it unchanged.");
    await mkdir(join(root, "plain-skill"), { recursive: true });
    await writeFile(flatFile, flatContents, "utf8");
    await writeMember(root, "marked-group", "member-folder", "member-skill", "Member description.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    await writeMember(root, "plain-skill", "nested", "nested-skill", "Nested child.");
    const index = groupSkillFile(root, "marked-group");
    const originalIndex = await readFile(index, "utf8");
    const originalStat = await stat(index);

    expect(store.isGroup("marked-group")).toBe(true);
    expect(store.isGroup("plain-skill")).toBe(false);
    expect(await readFile(index, "utf8")).toBe(originalIndex);
    expect((await stat(index)).mtimeMs).toBe(originalStat.mtimeMs);
    expect(await readFile(flatFile, "utf8")).toBe(flatContents);

    const damagedIndex = "not valid frontmatter\\n<!-- auto-learn-scope managed skill group index -->\\n";
    await writeFile(index, damagedIndex, "utf8");
    expect(() => store.refresh("marked-group")).toThrow();
    expect(await readFile(index, "utf8")).toBe(damagedIndex);
  });

  test("scan skips an external symlink to an ordinary flat skill", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const outsideFile = join(outside, "SKILL.md");
    const contents = skillText("external-flat", "External flat skill.", "Leave this alone.");
    await writeFile(outsideFile, contents, "utf8");
    const linkedDirectory = join(root, "external-flat");
    await symlink(outside, linkedDirectory, "dir");
    const createStore = await createStoreFactory();
    expect(() => createStore(root)).not.toThrow();

    expect(await readFile(outsideFile, "utf8")).toBe(contents);
    expect(await readFile(groupSkillFile(root, "external-flat"), "utf8")).toBe(contents);
    expect(await readlink(linkedDirectory)).toBe(outside);
  });

  test("hard-linked members and group indexes cannot be replaced", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const member = await writeMember(root, "linked-files", "member", "member-skill", "Original description.");
    const linkedMember = join(outside, "shared-member.md");
    await link(member, linkedMember);
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const originalMember = await readFile(member, "utf8");

    expect(() => store.mutate({
      group: "linked-files",
      action: "update",
      name: "member-skill",
      description: "Replacement description.",
      body: "Replacement body.",
    })).toThrow(/hard link|shared inode|safe|conflict/i);
    expect(await readFile(member, "utf8")).toBe(originalMember);
    expect(await readFile(linkedMember, "utf8")).toBe(originalMember);

    const index = groupSkillFile(root, "linked-files");
    const linkedIndex = join(outside, "shared-index.md");
    await link(index, linkedIndex);
    await writeMember(root, "linked-files", "second-folder", "second-skill", "Changed description.");
    const originalIndex = await readFile(index, "utf8");
    expect(() => store.refresh("linked-files")).toThrow(/hard link|shared inode|safe|conflict/i);
    expect(await readFile(index, "utf8")).toBe(originalIndex);
    expect(await readFile(linkedIndex, "utf8")).toBe(originalIndex);
  });

  test("an index hard-link failure reports a written skill and unchanged index", async () => {
    const root = await makeManagedRoot();
    const member = await writeMember(root, "partial-write", "old-folder", "read-runbook", "Before update.", "Old body.");
    const outside = await makeOutsideDirectory();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const index = groupSkillFile(root, "partial-write");
    const linkedIndex = join(outside, "shared-index.md");
    await link(index, linkedIndex);
    const originalIndex = await readFile(index, "utf8");
    let failure: unknown;
    try {
      store.mutate({
        group: "partial-write",
        action: "update",
        name: "read-runbook",
        description: "After update.",
        body: "New body.",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const details = failure as Error & {
      skillStatus?: string;
      indexStatus?: string;
      path?: string;
      skillPath?: string;
      indexPath?: string;
    };
    expect(details.skillStatus).toBe("written");
    expect(details.indexStatus).toBe("not-written");
    expect(details.path).toBe(index);
    expect(details.skillPath).toBe(member);
    expect(details.indexPath).toBe(index);
    expect(await readFile(member, "utf8")).toBe(skillText("read-runbook", "After update.", "New body."));
    expect(await readFile(index, "utf8")).toBe(originalIndex);
    expect(await readFile(linkedIndex, "utf8")).toBe(originalIndex);
  });
  test("create and delete index failures report the actual member path", async () => {
    for (const action of ["create", "delete"] as const) {
      const root = await makeManagedRoot();
      const group = `partial-${action}`;
      const originalMember = await writeMember(root, group, "legacy-folder", "existing-skill", "Existing description.");
      const outside = await makeOutsideDirectory();
      const createStore = await createStoreFactory();
      const store = createStore(root);
      const index = groupSkillFile(root, group);
      const linkedIndex = join(outside, "shared-index.md");
      await link(index, linkedIndex);
      const originalIndex = await readFile(index, "utf8");
      const skillPath = action === "create"
        ? memberSkillFile(root, group, "new-skill")
        : originalMember;
      let failure: unknown;
      try {
        store.mutate(action === "create"
          ? {
              group,
              action,
              name: "new-skill",
              description: "New description.",
              body: "New body.",
            }
          : { group, action, name: "existing-skill" });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const details = failure as Error & {
        skillStatus?: string;
        indexStatus?: string;
        skillPath?: string;
        indexPath?: string;
      };
      expect(details.skillStatus).toBe("written");
      expect(details.indexStatus).toBe("not-written");
      expect(details.skillPath).toBe(skillPath);
      expect(details.indexPath).toBe(index);
      expect(await pathExists(skillPath)).toBe(action === "create");
      expect(await readFile(index, "utf8")).toBe(originalIndex);
      expect(await readFile(linkedIndex, "utf8")).toBe(originalIndex);
    }
  });

  test("a hard-link failure reports status for each affected index from target to top level", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const top = "engineering";
    const middle = "engineering/database";
    const leaf = "engineering/database/postgresql";
    const member = await writeMember(root, leaf, "reader-folder", "read-runbook", "Before update.", "Old body.");
    await writeMember(root, middle, "database-folder", "database-guide", "Database member.");
    await writeMember(root, top, "root-folder", "engineering-guide", "Engineering member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const topIndex = groupSkillFile(root, top);
    const middleIndex = groupSkillFile(root, middle);
    const leafIndex = groupSkillFile(root, leaf);
    const linkedIndex = join(outside, "shared-middle-index.md");
    await link(middleIndex, linkedIndex);
    const originalMiddle = await readFile(middleIndex, "utf8");
    const originalTop = await readFile(topIndex, "utf8");
    let failure: unknown;
    try {
      store.mutate({
        group: leaf,
        action: "update",
        name: "read-runbook",
        description: "After update.",
        body: "New body.",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const details = failure as ManagedGroupFailure;
    expect(details.skillStatus).toBe("written");
    expect(details.skillPath).toBe(member);
    expect(details.indexes).toEqual([
      { group: leaf, path: leafIndex, status: "written", needsRebuild: false },
      { group: middle, path: middleIndex, status: "not-written", needsRebuild: true, reason: "failed" },
      { group: top, path: topIndex, status: "not-written", needsRebuild: true, reason: "not-attempted" },
    ]);
    expect(await readFile(member, "utf8")).toBe(skillText("read-runbook", "After update.", "New body."));
    expect(await readFile(leafIndex, "utf8")).toContain("After update.");
    expect(await readFile(middleIndex, "utf8")).toBe(originalMiddle);
    expect(await readFile(linkedIndex, "utf8")).toBe(originalMiddle);
    expect(await readFile(topIndex, "utf8")).toBe(originalTop);

    await rm(linkedIndex);
    store.refresh(leaf);
    expect(await readFile(middleIndex, "utf8")).toContain("After update.");
    expect(await readFile(topIndex, "utf8")).toContain("After update.");
  });


  test("an oversized member is rejected before any member or group is created", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);

    expect(() => store.mutate({
      group: "oversized",
      action: "create",
      name: "too-large",
      description: "Short description.",
      body: "x".repeat(64_000),
    })).toThrow(/64.?000|limit|bytes/i);

    expect(await pathExists(join(root, "oversized"))).toBe(false);
  });

  test("scan rejects a correctly marked group index whose name does not match its directory", async () => {
    const root = await makeManagedRoot();
    const groupIndex = groupSkillFile(root, "wrong-name");
    const child = await writeMember(root, "wrong-name", "child", "child-skill", "Child description.");
    const contents = `---\nname: different-name\ndescription: Manual.\n---\n\n${GROUP_INDEX_MARKER}\n\nUser data.\n`;
    await writeFile(groupIndex, contents, "utf8");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/name|match|conflict|group/i);
    expect(await readFile(groupIndex, "utf8")).toBe(contents);
    expect(await readFile(child, "utf8")).toContain("Child description.");
  });
  test("update and delete of missing groups preserve native existence semantics", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);

    for (const action of ["update", "delete"] as const) {
      expect(() => store.mutate({
        group: "missing-group",
        action,
        name: "missing-skill",
        ...(action === "update" ? { description: "Updated description.", body: "Updated body." } : {}),
      })).toThrow(/group|does not exist|member/i);
    }

    expect(await pathExists(join(root, "missing-group"))).toBe(false);
  });
  test("a missing update group reports the intended member path separately from the index path", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    let failure: unknown;
    try {
      store.mutate({ group: "engineering/database", action: "update", name: "space-audit", description: "Audit.", body: "Body." });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as ManagedGroupFailure).skillPath).toBe(memberSkillFile(root, "engineering/database", "space-audit"));
  });
  test("updating a member keeps the existing group description", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "kept-group", "reader", "reader", "Original description.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const index = groupSkillFile(root, "kept-group");
    await writeFile(index, `---\nname: kept-group\ndescription: "Previously generated summary."\n---\n\n${GROUP_INDEX_MARKER}\n\n# kept-group\n`);
    store.mutate({ group: "kept-group", action: "update", name: "reader", description: "New description.", body: "Updated body." });
    expect(groupIndexMetadata(await readFile(index, "utf8")).description).toBe("Previously generated summary.");
  });

  test("scanning a historical marked group without a revision preserves its summary", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "legacy-summary", "reader", "reader", "Member description.");
    const indexPath = groupSkillFile(root, "legacy-summary");
    await writeFile(
      indexPath,
      `---\nname: legacy-summary\ndescription: "Historical summary."\n---\n\n${GROUP_INDEX_MARKER}\n\n# legacy-summary\n`,
    );
    const createStore = await createStoreFactory();
    const store = createStore(root);

    const index = await readFile(indexPath, "utf8");
    expect(groupIndexMetadata(index).description).toBe("Historical summary.");
    expect(groupIndexMetadata(index).revision).toBeDefined();
    expect(store.pendingSummaryWork()).toEqual([]);
    const [work] = store.queueManualSummaryWork();
    const snapshot = store.summarySnapshot(work!)!;
    expect(snapshot.summary).toBe("Historical summary.");
    expect(snapshot.hasGeneratedSummary).toBe(false);
  });
  test("a member update preserves the generated summary and advances the index revision", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "summary-preserved", "reader-folder", "read-runbook", "Before update.", "Old body.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const [work] = store.queueManualSummaryWork();
    expect(work?.group).toBe("summary-preserved");
    expect(work?.trigger).toBe("manual");
    const snapshot = store.summarySnapshot(work!);
    expect(snapshot).not.toBeNull();
    expect(store.commitSummary(snapshot!, "Guides safe incident recovery.").status).toBe("committed");

    const indexPath = groupSkillFile(root, "summary-preserved");
    const before = groupIndexMetadata(await readFile(indexPath, "utf8"));
    expect(before.description).toBe("Guides safe incident recovery.");
    expect(before.revision).toBeDefined();

    store.mutate({
      group: "summary-preserved",
      action: "update",
      name: "read-runbook",
      description: "Updated runbook description.",
      body: "Updated body.",
    });

    const index = await readFile(indexPath, "utf8");
    const after = groupIndexMetadata(index);
    expect(after.description).toBe("Guides safe incident recovery.");
    expect(after.revision).toBeDefined();
    expect(after.revision).not.toBe(before.revision);
    expect(index).toContain("Updated runbook description.");
    expect(await readFile(memberSkillFile(root, "summary-preserved", "reader-folder"), "utf8"))
      .toBe(skillText("read-runbook", "Updated runbook description.", "Updated body."));
  });

  test("new members and description changes queue durable automatic summary work", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "automatic-work",
      action: "create",
      name: "first-skill",
      description: "First member.",
      body: "First body.",
    });
    const [firstWork] = store.pendingSummaryWork();
    expect(firstWork?.group).toBe("automatic-work");
    expect(firstWork?.trigger).toBe("automatic");
    expect(firstWork?.generation).toBeGreaterThan(0);

    const restarted = createStore(root);
    expect(restarted.pendingSummaryWork()).toEqual([firstWork]);
    const firstSnapshot = restarted.summarySnapshot(firstWork!);
    expect(firstSnapshot).not.toBeNull();
    restarted.mutate({
      group: "automatic-work",
      action: "update",
      name: "first-skill",
      description: "Updated member.",
      body: "Updated body.",
    });
    const [updatedWork] = restarted.pendingSummaryWork();
    expect(updatedWork?.generation).toBeGreaterThan(firstWork!.generation);
    expect(createStore(root).pendingSummaryWork()).toContainEqual(updatedWork!);
    expect(restarted.commitSummary(firstSnapshot!, "Obsolete first summary.").status).toBe("stale");

    restarted.mutate({ group: "automatic-work", action: "delete", name: "first-skill" });
    expect(restarted.pendingSummaryWork()).toEqual([]);

    restarted.mutate({
      group: "automatic-work",
      action: "create",
      name: "second-skill",
      description: "Second member.",
      body: "Second body.",
    });
    const secondWork = restarted.pendingSummaryWork().find(work => work.generation > firstWork!.generation);
    expect(secondWork?.group).toBe("automatic-work");
    expect(secondWork?.trigger).toBe("automatic");
    expect(secondWork?.operationId).not.toBe(firstWork?.operationId);
    expect(secondWork?.generation).toBeGreaterThan(firstWork!.generation);
  });

  test("a snapshot cannot overwrite a member update made while summary generation is running", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "stale-after-update",
      action: "create",
      name: "member",
      description: "Original description.",
      body: "Original body.",
    });
    const [work] = store.pendingSummaryWork();
    const snapshot = store.summarySnapshot(work!)!;

    const indexPath = groupSkillFile(root, "stale-after-update");
    const previousDescription = groupIndexMetadata(await readFile(indexPath, "utf8")).description;
    store.mutate({
      group: "stale-after-update",
      action: "update",
      name: "member",
      description: "Original description.",
      body: "Current body.",
    });

    expect(store.commitSummary(snapshot, "Obsolete summary.").status).toBe("stale");
    expect(store.skipSummary(snapshot).status).toBe("stale");
    const index = await readFile(indexPath, "utf8");
    const member = await readFile(memberSkillFile(root, "stale-after-update", "member"), "utf8");
    expect(groupIndexMetadata(index).description).toBe(previousDescription);
    expect(member).toContain("Current body.");
    expect(index).not.toContain("Obsolete summary.");
    expect(store.pendingSummaryWork()).toEqual([]);

  });

  test("a second addition leaves its newer generation pending after an old snapshot is submitted", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "stale-after-add",
      action: "create",
      name: "first",
      description: "First member.",
      body: "First body.",
    });
    const [firstWork] = store.pendingSummaryWork();
    const oldSnapshot = store.summarySnapshot(firstWork!)!;

    store.mutate({
      group: "stale-after-add",
      action: "create",
      name: "second",
      description: "Second member.",
      body: "Second body.",
    });

    expect(store.commitSummary(oldSnapshot, "Obsolete first-generation summary.").status).toBe("stale");
    expect(store.skipSummary(oldSnapshot).status).toBe("stale");
    const currentWork = store.pendingSummaryWork().find(work => work.generation > firstWork!.generation);
    expect(currentWork?.group).toBe("stale-after-add");
    expect(currentWork?.trigger).toBe("automatic");
    const currentSnapshot = store.summarySnapshot(currentWork!)!;
    expect(currentSnapshot.entries).toContainEqual({
      kind: "skill",
      name: "first",
      description: "First member.",
    });
    expect(currentSnapshot.entries).toContainEqual({
      kind: "skill",
      name: "second",
      description: "Second member.",
    });
    expect(await readFile(groupSkillFile(root, "stale-after-add"), "utf8"))
      .not.toContain("Obsolete first-generation summary.");
  });

  test("only the first summary snapshot based on the same revision can commit", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "cas",
      action: "create",
      name: "member",
      description: "Member description.",
      body: "Member body.",
    });
    const [work] = store.pendingSummaryWork();
    const firstSnapshot = store.summarySnapshot(work!)!;
    const secondSnapshot = store.summarySnapshot(work!)!;

    expect(store.commitSummary(firstSnapshot, "First committed summary.").status).toBe("committed");
    const committedIndex = await readFile(groupSkillFile(root, "cas"), "utf8");
    const committedRevision = groupIndexMetadata(committedIndex).revision;
    expect(store.commitSummary(secondSnapshot, "Late competing summary.").status).toBe("stale");

    const finalIndex = await readFile(groupSkillFile(root, "cas"), "utf8");
    expect(groupIndexMetadata(finalIndex).description).toBe("First committed summary.");
    expect(groupIndexMetadata(finalIndex).revision).toBe(committedRevision);
    expect(finalIndex).not.toContain("Late competing summary.");
  });

  test("a body-only external edit invalidates a snapshot during CAS validation", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "fingerprint",
      action: "create",
      name: "member",
      description: "Unchanged metadata.",
      body: "Original body marker.",
    });
    const [work] = store.pendingSummaryWork();
    const snapshot = store.summarySnapshot(work!)!;
    const indexPath = groupSkillFile(root, "fingerprint");
    const revisionBefore = groupIndexMetadata(await readFile(indexPath, "utf8")).revision;
    const memberPath = memberSkillFile(root, "fingerprint", "member");
    const member = await readFile(memberPath, "utf8");
    await writeFile(memberPath, member.replace("Original body marker.", "External body edit."));
    expect(store.commitSummary(snapshot, "Summary based on the old body.").status).toBe("stale");
    expect(store.skipSummary(snapshot).status).toBe("stale");
    const revisionAfter = groupIndexMetadata(await readFile(indexPath, "utf8")).revision;
    expect(revisionAfter).not.toBe(revisionBefore);
    expect(await readFile(indexPath, "utf8")).not.toContain("Summary based on the old body.");
  });

  test("a completed summary becomes stale when a member body changes outside the store", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "fingerprint-current", "member-folder", "member", "Member description.", "Before.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const [work] = store.queueManualSummaryWork();
    const snapshot = store.summarySnapshot(work!)!;
    expect(store.commitSummary(snapshot, "Previously generated summary.").status).toBe("committed");

    const indexPath = groupSkillFile(root, "fingerprint-current");
    const revisionBefore = groupIndexMetadata(await readFile(indexPath, "utf8")).revision;
    const memberPath = memberSkillFile(root, "fingerprint-current", "member-folder");
    const member = await readFile(memberPath, "utf8");
    await writeFile(memberPath, member.replace("Before.", "After."));
    expect(store.pendingSummaryWork()).toEqual([]);

    const metadata = groupIndexMetadata(await readFile(indexPath, "utf8"));
    expect(metadata.summaryState?.status).toBe("stale");
    expect(metadata.revision).not.toBe(revisionBefore);
    expect(metadata.description).toBe("Previously generated summary.");
  });

  test("manual refresh schedules every group bottom-up and does not resume as automatic work", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "refresh/alpha", "alpha-folder", "alpha-skill", "Alpha member.");
    await writeMember(root, "refresh/beta", "beta-folder", "beta-skill", "Temporary beta member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({ group: "refresh/beta", action: "delete", name: "beta-skill" });
    expect(store.pendingSummaryWork()).toEqual([]);

    const firstManualWork = store.queueManualSummaryWork();
    expect(firstManualWork.slice(0, -1).map(work => work.group).sort()).toEqual(["refresh/alpha", "refresh/beta"]);
    expect(firstManualWork.at(-1)?.group).toBe("refresh");
    expect(firstManualWork.every(work => work.trigger === "manual")).toBe(true);
    store.beginSession();
    expect(store.pendingSummaryWork()).toEqual([]);
    const manualWork = store.queueManualSummaryWork();
    expect(manualWork.slice(0, -1).map(work => work.group).sort()).toEqual(["refresh/alpha", "refresh/beta"]);
    expect(manualWork.at(-1)?.group).toBe("refresh");

    let betaBaseline: ManagedGroupSummarySnapshot["dependencies"][number] | undefined;
    for (const work of manualWork) {
      const snapshot = store.summarySnapshot(work);
      expect(snapshot).not.toBeNull();
      if (work.group === "refresh") {
        betaBaseline = snapshot!.dependencies.find(dependency => dependency.group === "refresh/beta");
      }
      expect(store.commitSummary(snapshot!, `Summary for ${work.group}.`).status).toBe("committed");
    }
    expect(store.pendingSummaryWork()).toEqual([]);
    expect(await readFile(groupSkillFile(root, "refresh/beta"), "utf8")).toContain("Summary for refresh/beta.");
    expect(betaBaseline?.status).toBe("current");
    const unaffectedBeta = betaBaseline!;

    store.mutate({
      group: "refresh/alpha",
      action: "create",
      name: "new-alpha-skill",
      description: "New alpha member.",
      body: "New alpha body.",
    });
    const automaticWork = store.pendingSummaryWork();
    expect(automaticWork.map(work => work.group)).toContain("refresh/alpha");
    expect(automaticWork.map(work => work.group)).toContain("refresh");
    expect(automaticWork.map(work => work.group)).not.toContain("refresh/beta");
    const automaticParentWork = automaticWork.find(work => work.group === "refresh")!;
    const blockedParentSnapshot = store.summarySnapshot(automaticParentWork)!;
    const alphaPending = blockedParentSnapshot.dependencies.find(dependency => dependency.group === "refresh/alpha")!;
    const betaUnchanged = blockedParentSnapshot.dependencies.find(dependency => dependency.group === "refresh/beta")!;
    expect(alphaPending.status).toBe("pending");
    expect(betaUnchanged).toMatchObject({
      revision: unaffectedBeta.revision,
      generation: unaffectedBeta.generation,
      status: "current",
    });

    const automaticAlphaWork = automaticWork.find(work => work.group === "refresh/alpha")!;
    const alphaSnapshot = store.summarySnapshot(automaticAlphaWork)!;
    expect(store.skipSummary(alphaSnapshot).status).toBe("skipped");
    expect(await readFile(groupSkillFile(root, "refresh/alpha"), "utf8"))
      .toContain("Summary for refresh/alpha.");
    expect(store.commitSummary(blockedParentSnapshot, "Stale parent summary.").status).toBe("stale");

    const currentParentSnapshot = store.summarySnapshot(automaticParentWork)!;
    expect(currentParentSnapshot.dependencies.find(dependency => dependency.group === "refresh/alpha")?.status)
      .toBe("skipped");
    expect(currentParentSnapshot.dependencies.find(dependency => dependency.group === "refresh/beta"))
      .toMatchObject({
        revision: unaffectedBeta.revision,
        generation: unaffectedBeta.generation,
        status: "current",
      });
    expect(store.commitSummary(currentParentSnapshot, "Combined updated summary.").status).toBe("committed");
    expect(await readFile(groupSkillFile(root, "refresh"), "utf8")).toContain("Combined updated summary.");
  });

  test("an uninitialized unaffected child keeps its description in an automatic parent snapshot", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "summary/changed", "first-folder", "first-skill", "Changed member.");
    await writeMember(root, "summary/untouched", "first-folder", "untouched-skill", "Untouched member.");
    await writeFile(
      groupSkillFile(root, "summary/untouched"),
      `---\nname: untouched\ndescription: Existing untouched description.\n---\n\n${GROUP_INDEX_MARKER}\n`,
      "utf8",
    );
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "summary/changed",
      action: "create",
      name: "second-skill",
      description: "New changed member.",
      body: "New body.",
    });

    const changedWork = store.pendingSummaryWork().find(work => work.group === "summary/changed")!;
    const changedSnapshot = store.summarySnapshot(changedWork)!;
    expect(store.commitSummary(changedSnapshot, "Updated changed child summary.").status).toBe("committed");
    const parentWork = store.pendingSummaryWork().find(work => work.group === "summary")!;
    const snapshot = store.summarySnapshot(parentWork);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.dependencies.find(dependency => dependency.group === "summary/untouched")?.status)
      .toBe("uninitialized");
    expect(snapshot!.entries.find(entry => entry.kind === "group" && entry.name === "untouched")?.description)
      .toBe("Existing untouched description.");
    expect(store.commitSummary(snapshot!, "Parent summary using existing child metadata.").status).toBe("committed");
  });

  test("a new process recovers a committed member before completing the next addition", async () => {
    const root = await makeManagedRoot();
    const interrupted = await runInterruptedChildCreate(root, "ordered-recovery", "first");
    expect(interrupted.code).toBe(86);
    expect(interrupted.stderr).toBe("");
    expect(await readFile(memberSkillFile(root, "ordered-recovery", "first"), "utf8"))
      .toBe(skillText("first", "Description for first.", "Body for first."));

    const createStore = await createStoreFactory();
    const recoveredStore = createStore(root);
    const firstWork = recoveredStore.pendingSummaryWork().find(work => work.group === "ordered-recovery")!;
    expect(firstWork.trigger).toBe("automatic");
    expect(firstWork.generation).toBeGreaterThan(0);

    await runChildMutation(root, "ordered-recovery", "second");
    const afterSecondAdd = createStore(root);
    const secondWork = afterSecondAdd.pendingSummaryWork()
      .find(work => work.group === "ordered-recovery" && work.generation > firstWork.generation)!;
    expect(secondWork.trigger).toBe("automatic");
    expect(secondWork.generation).toBe(firstWork.generation + 1);
    expect(secondWork.operationId).not.toBe(firstWork.operationId);

    const index = await readFile(groupSkillFile(root, "ordered-recovery"), "utf8");
    expect(index).toContain("skill://ordered-recovery/first/SKILL.md");
    expect(index).toContain("skill://ordered-recovery/second/SKILL.md");
    const thirdStore = createStore(root);
    expect(thirdStore.pendingSummaryWork()).toContainEqual(secondWork);
  });

  test("description update recovery distinguishes commits before and after atomic replacement", async () => {
    const createStore = await createStoreFactory();
    for (const before of [true, false]) {
      const root = await makeManagedRoot();
      await writeMember(root, "recovery", "member-folder", "member", "Original description.");
      const store = createStore(root);
      store.scan();
      expect(await runInterruptedDescriptionUpdate(root, "recovery", "member-folder", before)).toBe(before ? 86 : 87);
      const restarted = createStore(root);
      const pending = restarted.pendingSummaryWork();
      const index = await readFile(groupSkillFile(root, "recovery"), "utf8");
      if (before) {
        expect(pending).toEqual([]);
        expect(index).toContain("Original description.");
      } else {
        expect(pending.map(work => work.group)).toEqual(["recovery"]);
        expect(index).toContain("Updated description.");
      }
    }
  });

  test("recovery rejects a symlinked intermediate group without cleaning other files", async () => {
    const root = await makeManagedRoot();
    const interrupted = await runInterruptedChildCreate(root, "nested/a/b", "first");
    expect(interrupted.code).toBe(86);

    const outside = await makeOutsideDirectory();
    const outsideMemberDirectory = join(outside, "b", "first");
    await mkdir(outsideMemberDirectory, { recursive: true });
    const unrelatedTemporary = join(outsideMemberDirectory, ".managed-skill.tmp-unrelated");
    await writeFile(unrelatedTemporary, "leave this file untouched.", "utf8");
    await rm(join(root, "nested", "a"), { recursive: true, force: true });
    await symlink(outside, join(root, "nested", "a"), "dir");

    const store = (await createStoreFactory())(root);
    expect(() => store.pendingSummaryWork()).toThrow();
    expect(await readFile(unrelatedTemporary, "utf8")).toBe("leave this file untouched.");
  });

  test("recovering an interrupted add does not refresh an obsolete work fingerprint", async () => {
    const root = await makeManagedRoot();
    const group = "fingerprint-recovery";
    await writeMember(root, group, "first-folder", "first-skill", "First member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const [initialWork] = store.queueManualSummaryWork();
    expect(store.commitSummary(store.summarySnapshot(initialWork!)!, "Previous summary.").status).toBe("committed");

    const interrupted = await runInterruptedChildCreateAfterIndex(root, group, "second-skill");
    expect(interrupted.code).toBe(87);
    expect(interrupted.stderr).toBe("");
    const existingMember = memberSkillFile(root, group, "first-folder");
    const content = await readFile(existingMember, "utf8");
    await writeFile(existingMember, content.replace("Body for first-skill.", "Externally changed after the crash."), "utf8");

    const restarted = createStore(root);
    expect(restarted.pendingSummaryWork().some(work => work.group === group)).toBe(false);
    const index = await readFile(groupSkillFile(root, group), "utf8");
    expect(groupIndexMetadata(index).description).toBe("Previous summary.");
    expect(index).toContain(`skill://${group}/second-skill/SKILL.md`);
  });
  test("a judge skip keeps the prior summary while CAS-advancing its revision", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "skip-summary", "first-folder", "first-skill", "First member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const [manualWork] = store.queueManualSummaryWork();
    const initialSnapshot = store.summarySnapshot(manualWork!)!;
    expect(store.commitSummary(initialSnapshot, "A useful existing summary.").status).toBe("committed");
    const indexPath = groupSkillFile(root, "skip-summary");
    const before = groupIndexMetadata(await readFile(indexPath, "utf8"));

    store.mutate({
      group: "skip-summary",
      action: "create",
      name: "second-skill",
      description: "Second member.",
      body: "Second body.",
    });
    const automaticWork = store.pendingSummaryWork().find(work => work.group === "skip-summary")!;
    const skipSnapshot = store.summarySnapshot(automaticWork)!;
    const concurrentGeneration = store.summarySnapshot(automaticWork)!;

    expect(store.skipSummary(skipSnapshot).status).toBe("skipped");
    const skippedIndex = await readFile(indexPath, "utf8");
    const after = groupIndexMetadata(skippedIndex);
    expect(after.description).toBe("A useful existing summary.");
    expect(after.revision).not.toBe(before.revision);
    expect(skippedIndex).toContain("skill://skip-summary/second-skill/SKILL.md");
    expect(store.pendingSummaryWork()).toEqual([]);
    expect(store.commitSummary(concurrentGeneration, "Late generated result.").status).toBe("stale");
    const finalIndex = await readFile(indexPath, "utf8");
    expect(groupIndexMetadata(finalIndex).description).toBe("A useful existing summary.");
    expect(groupIndexMetadata(finalIndex).revision).toBe(after.revision);
    expect(finalIndex).not.toContain("Late generated result.");
  });

  test("summary generation failure preserves the previous summary and remains resumable", async () => {
    const root = await makeManagedRoot();
    await writeMember(root, "failed-summary", "first-folder", "first-skill", "First member.");
    const createStore = await createStoreFactory();
    const store = createStore(root);
    const [manualWork] = store.queueManualSummaryWork();
    const initialSnapshot = store.summarySnapshot(manualWork!)!;
    expect(store.commitSummary(initialSnapshot, "Previously generated summary.").status).toBe("committed");
    const indexPath = groupSkillFile(root, "failed-summary");
    const before = groupIndexMetadata(await readFile(indexPath, "utf8"));

    store.mutate({
      group: "failed-summary",
      action: "create",
      name: "second-skill",
      description: "New member.",
      body: "New body.",
    });
    const automaticWork = store.pendingSummaryWork().find(work => work.group === "failed-summary")!;
    const snapshot = store.summarySnapshot(automaticWork)!;

    expect(store.failSummary(snapshot, "provider unavailable").status).toBe("failed");
    const failedIndex = await readFile(indexPath, "utf8");
    const after = groupIndexMetadata(failedIndex);
    expect(after.description).toBe("Previously generated summary.");
    expect(after.revision).not.toBe(before.revision);
    expect(store.commitSummary(snapshot, "Late result after failure.").status).toBe("stale");
    expect(await readFile(indexPath, "utf8")).not.toContain("Late result after failure.");

    const restarted = createStore(root);
    expect(restarted.pendingSummaryWork()).toContainEqual(automaticWork);
  });
  test("a failed manual refresh immediately restores prior automatic work", async () => {
    const root = await makeManagedRoot();
    const createStore = await createStoreFactory();
    const store = createStore(root);
    store.mutate({
      group: "manual-fallback",
      action: "create",
      name: "member",
      description: "Member description.",
      body: "Member body.",
    });
    const automaticWork = store.pendingSummaryWork().find(work => work.group === "manual-fallback")!;

    const manualWork = store.queueManualSummaryWork().find(work => work.group === "manual-fallback")!;
    const manualSnapshot = store.summarySnapshot(manualWork)!;
    expect(manualWork.trigger).toBe("manual");
    expect(store.failSummary(manualSnapshot, "manual generation failed").status).toBe("failed");

    const resumedAutomaticWork = store.pendingSummaryWork().find(work => work.group === "manual-fallback");
    expect(resumedAutomaticWork?.trigger).toBe("automatic");
    expect(resumedAutomaticWork?.generation).toBeGreaterThan(manualWork.generation);
    expect(resumedAutomaticWork?.operationId).not.toBe(manualWork.operationId);
    const resumedSnapshot = store.summarySnapshot(resumedAutomaticWork!);
    expect(resumedSnapshot?.status).toBe("failed");
    expect(resumedAutomaticWork?.operationId).not.toBe(automaticWork.operationId);

    const restarted = createStore(root);
    expect(restarted.pendingSummaryWork()).toContainEqual(resumedAutomaticWork!);
  });
});
