import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Octo reads use default profile unless an environment identity is configured", async () => {
  const home = await mkdtemp(join(tmpdir(), "omp-octo-profile-"));
  const identities: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      identities.push(request.headers.get("authorization") ?? "");
      const url = new URL(request.url);
      if (url.pathname === "/v1/bot/docs/d_profile") {
        return Response.json({ docId: "d_profile", docType: "doc", title: "Fixture", role: "reader" });
      }
      if (url.pathname === "/v1/bot/docs/d_profile/content") {
        return Response.json({ docId: "d_profile", doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Fixture" }] }] }, schemaVersion: 1, baseVersion: "v1" });
      }
      return new Response("unexpected request", { status: 404 });
    },
  });
  const env = { ...process.env, HOME: home, OCTO_API_BASE_URL: `http://127.0.0.1:${server.port}` };
  delete env.OCTO_TOKEN;
  delete env.OCTO_BOT_TOKEN;
  delete env.OCTO_BOT_ID;
  delete env.OCTO_TASK_TOKEN;
  delete env.OCTO_CREDENTIAL_MODE;
  try {
    for (const [profile, bot, token] of [["default", "ob_default", "bf_default_fixture"], ["other", "ob_other", "bf_other_fixture"]]) {
      const login = Bun.spawn(["octo-cli", "auth", "login", "--profile", profile, "--bot-id", bot, "--with-token"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      login.stdin.write(`${token}\n`);
      login.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([new Response(login.stdout).text(), new Response(login.stderr).text(), login.exited]);
      expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
    }
    const backend = resolve(import.meta.dir, "../src/backend.ts");
    const program = `import { readDocument } from ${JSON.stringify(backend)}; const doc = await readDocument("d_profile"); console.log(doc.text);`;
    const cases = [
      { vars: {}, token: "bf_default_fixture" },
      { vars: { OCTO_BOT_ID: "ob_other" }, token: "bf_other_fixture" },
      { vars: { OCTO_TOKEN: "bf_env_fixture", OCTO_BOT_ID: "ob_other" }, token: "bf_env_fixture" },
      { vars: { OCTO_BOT_TOKEN: "bf_alias_fixture", OCTO_BOT_ID: "ob_other" }, token: "bf_alias_fixture" },
    ];
    for (const entry of cases) {
      identities.length = 0;
      const child = Bun.spawn([process.execPath, "-e", program], { env: { ...env, ...entry.vars }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "Fixture\n", stderr: "" });
      expect(identities).toEqual([`Bearer ${entry.token}`, `Bearer ${entry.token}`]);
    }
    identities.length = 0;
    const task = Bun.spawn([process.execPath, "-e", program], {
      env: { ...env, OCTO_CREDENTIAL_MODE: "task", OCTO_TASK_TOKEN: "bf_task_fixture" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [taskError, taskExit] = await Promise.all([new Response(task.stderr).text(), task.exited]);
    expect(taskExit).not.toBe(0);
    expect(taskError).toContain("OCTO_CREDENTIAL_MODE=task only allows Loop commands");
    expect(identities).toEqual([]);
  } finally {
    server.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
