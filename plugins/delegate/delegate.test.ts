import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  createCleanSessionManager,
  createTanSessionManagerFacade,
  dispatchDelegate,
  parseDelegateWork,
} from "./delegate";

describe("parseDelegateWork", () => {
  test("trims the delegated work and rejects an empty request", () => {
    expect(parseDelegateWork("  inspect the repository  ")).toBe("inspect the repository");
    expect(parseDelegateWork("  ")).toBeUndefined();
  });
});

describe("clean delegate session", () => {
  test("starts with an empty transcript instead of copying the parent session", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "omp-delegate-"));
    const sessionDir = join(root, "sessions");
    const parent = SessionManager.create(root, sessionDir);
    const parentFile = parent.getSessionFile();
    if (!parentFile) throw new Error("parent session was not persisted");
    parent.appendMessage({ role: "user", content: "parent-only context", timestamp: Date.now() });
    await parent.flush();

    const clean = createCleanSessionManager(root, sessionDir);
    const cleanFile = clean.getSessionFile();
    await clean.ensureOnDisk();
    try {
      expect(cleanFile).toBeDefined();
      expect(cleanFile).not.toBe(parentFile);
      expect(clean.getEntries()).toHaveLength(0);
      expect(await readFile(cleanFile!, "utf8")).not.toContain("parent-only context");
    } finally {
      if (cleanFile) await clean.dropSession(cleanFile);
      await parent.dropSession(parentFile);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the native tan runtime identity while replacing only its session source", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "omp-delegate-"));
    const sessionDir = join(root, "sessions");
    const parent = SessionManager.create(root, sessionDir);
    const parentFile = parent.getSessionFile();
    if (!parentFile) throw new Error("parent session was not persisted");
    const clean = createCleanSessionManager(root, sessionDir);
    const cleanFile = clean.getSessionFile();
    try {
      const facade = createTanSessionManagerFacade(parent, clean);
      expect(facade.getSessionFile()).toBe(cleanFile);
      expect(facade.getSessionId()).toBe(parent.getSessionId());
      expect(facade.getCwd()).toBe(parent.getCwd());
      expect(facade.getArtifactsDir()).toBe(parent.getArtifactsDir());
      expect(clean.getEntries()).toHaveLength(0);
    } finally {
      if (cleanFile) await clean.dropSession(cleanFile);
      await parent.dropSession(parentFile);
      await rm(root, { recursive: true, force: true });
    }
  });
});
 
describe("delegate dispatch", () => {
  test("hands the native controller an empty source while preserving the parent agent", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "omp-delegate-"));
    const sessionDir = join(root, "sessions");
    const parent = SessionManager.create(root, sessionDir);
    const parentFile = parent.getSessionFile();
    if (!parentFile) throw new Error("parent session was not persisted");
    parent.appendMessage({ role: "user", content: "parent-only context", timestamp: Date.now() });
    await parent.flush();
    const clean = createCleanSessionManager(root, sessionDir);
    const cleanFile = clean.getSessionFile();
    if (!cleanFile) throw new Error("clean session was not persisted");
    await clean.ensureOnDisk();

    const parentSession = {
      sessionManager: parent,
      model: { provider: "mock", id: "mock" },
      asyncJobManager: {},
      settings: {},
    } as unknown as AgentSession;
    const notices: string[] = [];
    const commandContext = {
      hasUI: true,
      mode: "tui",
      cwd: root,
      sessionManager: parent,
      ui: { notify: (message: string) => notices.push(message) },
    } as unknown as ExtensionCommandContext;
    let observed:
      | {
          parent: AgentSession;
          sourceFile: string | undefined;
          cleanEntries: number;
          work?: string;
        }
      | undefined;

    try {
      await dispatchDelegate("  inspect independently  ", commandContext, {
        resolveParentSession: () => parentSession,
        createCleanSessionManager: () => clean,
        createTanController: tanContext => {
          observed = {
            parent: tanContext.session,
            sourceFile: tanContext.sessionManager.getSessionFile(),
            cleanEntries: clean.getEntries().length,
          };
          return {
            start: async work => {
              if (!observed) throw new Error("controller was not initialized");
              observed.work = work;
            },
          };
        },
      });

      expect(observed).toEqual({
        parent: parentSession,
        sourceFile: cleanFile,
        cleanEntries: 0,
        work: "inspect independently",
      });
      expect(parent.getEntries()).toHaveLength(1);
      expect(notices).toEqual([]);
    } finally {
      await parent.dropSession(parentFile);
      await rm(root, { recursive: true, force: true });
    }
  });
});
