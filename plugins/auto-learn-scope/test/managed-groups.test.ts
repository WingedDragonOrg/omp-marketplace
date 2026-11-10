import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ManagedGroupInput = {
  group: string;
  action: "create" | "update" | "delete";
  name: string;
  description?: string;
  body?: string;
};
type ManagedGroupStore = {
  scan(): void;
  refresh(group: string): void;
  mutate(input: ManagedGroupInput): { path: string };
  isGroup(group: string): boolean;
};
type ManagedGroupsModule = {
  createManagedGroupStore?: (root: string) => ManagedGroupStore;
};

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
  return root;
}

async function makeOutsideDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-managed-groups-outside-"));
  temporaryRoots.push(root);
  return root;
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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("managed skill group storage", () => {
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

  test("a symlinked group index is reported without replacing its target", async () => {
    const root = await makeManagedRoot();
    const outside = await makeOutsideDirectory();
    const target = join(outside, "keep.md");
    const linkedIndex = groupSkillFile(root, "linked-index");
    await writeMember(root, "linked-index", "child", "child-skill", "Child member.");
    await writeFile(target, "externally managed index", "utf8");
    await symlink(target, linkedIndex, "file");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/symlink|link|conflict/i);
    expect(await readlink(linkedIndex)).toBe(target);
    expect(await readFile(target, "utf8")).toBe("externally managed index");
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
    expect(store.isGroup("marked-group")).toBe(true);
    expect(() => store.refresh("marked-group")).toThrow(/frontmatter|YAML/i);
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

  test("scan reports a group index whose name does not match its directory", async () => {
    const root = await makeManagedRoot();
    const groupIndex = groupSkillFile(root, "wrong-name");
    await writeMember(root, "wrong-name", "child", "child-skill", "Child description.");
    await writeFile(groupIndex, `${skillText("different-name", "Manual.", "User data.")}\n<!-- auto-learn-scope managed skill group index -->\n`, "utf8");
    const createStore = await createStoreFactory();

    expect(() => createStore(root)).toThrow(/name|match|conflict|group/i);
    expect(await readFile(groupIndex, "utf8")).toContain("different-name");
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
});
