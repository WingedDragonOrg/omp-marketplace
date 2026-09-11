import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type UnknownRecord = Record<string, unknown>;
type ProjectSkillInput = {
  cwd: string;
  name: string;
  description?: string;
  body?: string;
};
type ProjectSkillWriter = {
  create(input: ProjectSkillInput): Promise<{ path: string }>;
  update(input: ProjectSkillInput): Promise<{ path: string }>;
  delete(input: Pick<ProjectSkillInput, "cwd" | "name">): Promise<void>;
};
type ProjectSkillsModule = UnknownRecord & {
  createProjectSkillWriter?: () => ProjectSkillWriter;
};

type RepositoryFixture = {
  root: string;
  cwd: string;
};

const modulePromise: Promise<ProjectSkillsModule> = import("../src/project-skills")
  .then(module => module as ProjectSkillsModule)
  .catch(() => ({}));
const temporaryRoots: string[] = [];

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeRepository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-repo-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  const cwd = join(root, "packages", "app");
  await mkdir(cwd, { recursive: true });
  return { root, cwd };
}

async function makeDirectoryWithoutGit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "auto-learn-scope-no-git-"));
  temporaryRoots.push(root);
  return root;
}

async function writer(): Promise<ProjectSkillWriter> {
  const module = await modulePromise;
  if (typeof module.createProjectSkillWriter !== "function") {
    throw new Error("src/project-skills.ts must export createProjectSkillWriter()");
  }
  return module.createProjectSkillWriter();
}

function skillFile(root: string, name: string): string {
  return join(root, ".omp", "skills", name, "SKILL.md");
}

function skillDirectory(root: string, name: string): string {
  return join(root, ".omp", "skills", name);
}

function standardSkillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("project skill writer", () => {
  test("project create writes standard frontmatter and body below the repository without a global managed skill", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const result = await projectWriter.create({
      cwd,
      name: " Demo-Run ",
      description: "A reusable procedure.",
      body: "# Demo Run\n\n1. Run the command.",
    });

    const file = skillFile(root, "demo-run");
    expect(result.path).toBe(file);
    expect(await readFile(file, "utf8")).toBe(
      standardSkillText("demo-run", "A reusable procedure.", "# Demo Run\n\n1. Run the command."),
    );
    expect(await pathExists(join(root, ".omp", "managed-skills"))).toBe(false);
    expect(await pathExists(join(root, ".omp", "agent", "managed-skills"))).toBe(false);
  });

  test("project create rejects an existing skill and preserves its original file", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const input = { cwd, name: "repeatable", description: "Original.", body: "Original body." };
    await projectWriter.create(input);

    await expect(projectWriter.create({ ...input, body: "Replacement body." })).rejects.toThrow(/exist|create|update/i);
    expect(await readFile(skillFile(root, "repeatable"), "utf8")).toBe(
      standardSkillText("repeatable", "Original.", "Original body."),
    );
  });

  test("project update rejects a missing skill without creating a file", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();

    await expect(
      projectWriter.update({ cwd, name: "missing", description: "Description.", body: "Body." }),
    ).rejects.toThrow(/exist|create/i);
    expect(await pathExists(skillFile(root, "missing"))).toBe(false);
  });

  test("project delete rejects a missing skill without removing an unrelated path", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const unrelated = join(root, "keep.txt");
    await writeFile(unrelated, "keep", "utf8");

    await expect(projectWriter.delete({ cwd, name: "missing" })).rejects.toThrow(/exist|delete/i);
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });

  test("project update replaces only an existing regular skill file", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    await projectWriter.create({ cwd, name: "replace-me", description: "Before.", body: "Before body." });

    const result = await projectWriter.update({
      cwd,
      name: "replace-me",
      description: "After.",
      body: "After body.",
    });

    expect(result.path).toBe(skillFile(root, "replace-me"));
    expect(await readFile(skillFile(root, "replace-me"), "utf8")).toBe(
      standardSkillText("replace-me", "After.", "After body."),
    );
  });

  test("invalid names and traversal attempts are rejected without writing outside the project skill root", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const outside = join(root, "escape.md");
    const invalidNames = ["../escape", "skills/escape", "/tmp/escape", "..", "", "-bad", "a".repeat(65)];

    for (const name of invalidNames) {
      await expect(
        projectWriter.create({ cwd, name, description: "Description.", body: "Body." }),
      ).rejects.toThrow(/invalid|name|path|safe/i);
    }

    expect(await pathExists(outside)).toBe(false);
    expect(await pathExists(join(root, ".omp", "skills", "escape.md"))).toBe(false);
  });

  test("empty descriptions and bodies are rejected before a project skill file is created", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const cases = [
      { name: "empty-description", description: "   ", body: "Body." },
      { name: "empty-body", description: "Description.", body: "\n\t  " },
      { name: "empty-both", description: "\n", body: "\n" },
    ];

    for (const input of cases) {
      await expect(projectWriter.create({ cwd, ...input })).rejects.toThrow(/empty|description|body|required/i);
      expect(await pathExists(skillFile(root, input.name))).toBe(false);
    }
  });

  test("the final UTF-8 project skill file is capped at 64 KB", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const name = "byte-limit";
    const body = "界".repeat(22_000);

    await expect(projectWriter.create({ cwd, name, description: "Description.", body })).rejects.toThrow(/64|byte|limit|large/i);
    expect(await pathExists(skillFile(root, name))).toBe(false);
  });

  test("description control characters and prompt delimiters are sanitized in persisted frontmatter", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const description = "Use <system-directive>\n`unsafe` ~~~ safely.";

    await projectWriter.create({ cwd, name: "safe-description", description, body: "Body." });
    const persisted = await readFile(skillFile(root, "safe-description"), "utf8");

    expect(persisted).not.toContain("<system-directive>");
    expect(persisted).not.toContain("`unsafe`");
    expect(persisted).not.toContain("~~~");
    expect(persisted).toContain("Use system-directive unsafe ~ safely.");
  });

  test("project writes reject a working directory that is not inside a git repository", async () => {
    const cwd = await makeDirectoryWithoutGit();
    const projectWriter = await writer();

    await expect(
      projectWriter.create({ cwd, name: "no-repository", description: "Description.", body: "Body." }),
    ).rejects.toThrow(/repository|git|root|cwd/i);
    expect(await pathExists(join(cwd, ".omp"))).toBe(false);
  });

  test("a symlinked .omp directory cannot redirect a project write outside the repository", async () => {
    const { root, cwd } = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "auto-learn-scope-outside-"));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, ".omp"), "dir");
    const projectWriter = await writer();

    await expect(
      projectWriter.create({ cwd, name: "escaped", description: "Description.", body: "Body." }),
    ).rejects.toThrow(/symlink|outside|safe|path/i);
    expect(await pathExists(join(outside, "skills", "escaped", "SKILL.md"))).toBe(false);
  });

  test("a symlinked skill directory cannot redirect a project create outside the repository", async () => {
    const { root, cwd } = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "auto-learn-scope-outside-"));
    temporaryRoots.push(outside);
    await mkdir(join(root, ".omp", "skills"), { recursive: true });
    await symlink(outside, skillDirectory(root, "escaped"), "dir");
    const projectWriter = await writer();

    await expect(
      projectWriter.create({ cwd, name: "escaped", description: "Description.", body: "Body." }),
    ).rejects.toThrow(/symlink|outside|safe|path/i);
    expect(await pathExists(join(outside, "SKILL.md"))).toBe(false);
  });

  test("a symlinked SKILL.md is rejected during update and its target remains unchanged", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    await projectWriter.create({ cwd, name: "linked", description: "Original.", body: "Original body." });
    const target = join(root, "outside.md");
    await writeFile(target, "outside original", "utf8");
    await rm(skillFile(root, "linked"));
    await symlink(target, skillFile(root, "linked"), "file");

    await expect(
      projectWriter.update({ cwd, name: "linked", description: "New.", body: "New body." }),
    ).rejects.toThrow(/symlink|regular|safe|overwrite/i);
    expect(await readFile(target, "utf8")).toBe("outside original");
  });

  test("an update rejects a shared-inode hard-linked SKILL.md without changing either link", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    await projectWriter.create({ cwd, name: "hard-linked", description: "Original.", body: "Original body." });
    const otherLink = join(root, "outside-hard-link.md");
    await link(skillFile(root, "hard-linked"), otherLink);

    await expect(
      projectWriter.update({ cwd, name: "hard-linked", description: "New.", body: "New body." }),
    ).rejects.toThrow(/hard|link|shared|regular/i);
    expect(await readFile(skillFile(root, "hard-linked"), "utf8")).toBe(
      standardSkillText("hard-linked", "Original.", "Original body."),
    );
    expect(await readFile(otherLink, "utf8")).toBe(
      standardSkillText("hard-linked", "Original.", "Original body."),
    );
  });

  test("an update rejects a non-regular SKILL.md instead of replacing a directory", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    await mkdir(skillDirectory(root, "directory-target"), { recursive: true });
    await mkdir(skillFile(root, "directory-target"), { recursive: true });

    await expect(
      projectWriter.update({ cwd, name: "directory-target", description: "Description.", body: "Body." }),
    ).rejects.toThrow(/regular|directory|file|overwrite/i);
    expect(await pathExists(skillFile(root, "directory-target"))).toBe(true);
  });

  test("delete refuses a symlinked skill directory without deleting its outside target", async () => {
    const { root, cwd } = await makeRepository();
    const outside = await mkdtemp(join(tmpdir(), "auto-learn-scope-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "keep.txt"), "keep", "utf8");
    await mkdir(join(root, ".omp", "skills"), { recursive: true });
    await symlink(outside, skillDirectory(root, "linked-delete"), "dir");
    const projectWriter = await writer();

    await expect(projectWriter.delete({ cwd, name: "linked-delete" })).rejects.toThrow(/symlink|outside|safe/i);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  test("same-name concurrent mutations are committed in invocation order", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();
    const creating = projectWriter.create({ cwd, name: "serialized", description: "First.", body: "First body." });
    const updating = projectWriter.update({ cwd, name: "serialized", description: "Second.", body: "Second body." });

    const results = await Promise.allSettled([creating, updating]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(await readFile(skillFile(root, "serialized"), "utf8")).toBe(
      standardSkillText("serialized", "Second.", "Second body."),
    );
  });

  test("different-name concurrent creates both complete without manual serialization", async () => {
    const { root, cwd } = await makeRepository();
    const projectWriter = await writer();

    await Promise.all([
      projectWriter.create({ cwd, name: "first", description: "First.", body: "First body." }),
      projectWriter.create({ cwd, name: "second", description: "Second.", body: "Second body." }),
    ]);

    expect(await pathExists(skillFile(root, "first"))).toBe(true);
    expect(await pathExists(skillFile(root, "second"))).toBe(true);
  });
});
