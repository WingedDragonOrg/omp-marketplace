import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("real octo-cli reads and applies a version-guarded document edit", async () => {
  let document = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }],
  };
  let version = "v1";
  let conflictRejected = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/bot/docs/d_integration") {
        return Response.json({ docId: "d_integration", docType: "doc", title: "Fixture", role: "writer" });
      }
      if (request.method === "GET" && url.pathname === "/v1/bot/docs/d_integration/content") {
        return Response.json({ docId: "d_integration", doc: document, schemaVersion: 1, baseVersion: version });
      }
      if (request.method === "PATCH" && url.pathname === "/v1/bot/docs/d_integration/content") {
        if (request.headers.get("if-match") !== version) {
          conflictRejected = true;
          return Response.json({ error: { code: "base_version_stale", message: "stale" } }, { status: 412 });
        }
        const body = await request.json() as { ops: Array<{ type: string; range: { from: { path: number[] }; to: { path: number[] } }; content: typeof document.content }> };
        for (const op of body.ops) {
          if (op.type !== "replace" || op.range.from.path.length !== 1 || op.range.to.path.length !== 1) {
            return Response.json({ error: "unexpected fixture operation" }, { status: 400 });
          }
          document.content.splice(op.range.from.path[0], op.range.to.path[0] - op.range.from.path[0] + 1, ...op.content);
        }
        version = "v2";
        return Response.json({ docId: "d_integration", baseVersion: version });
      }
      return new Response("unexpected request", { status: 404 });
    },
  });
  try {
    const backend = resolve(import.meta.dir, "../src/backend.ts");
    const program = `import { readDocument, writeDocument } from ${JSON.stringify(backend)};
const snapshot = await readDocument("d_integration");
await writeDocument(snapshot, "After");
let stale = false;
try { await writeDocument(snapshot, "Stale"); } catch { stale = true; }
console.log(JSON.stringify({ before: snapshot.text, stale }));`;
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: { ...process.env, OCTO_TOKEN: "bf_local_test", OCTO_CREDENTIAL_MODE: "", OCTO_API_BASE_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ before: "Before", stale: true });
    expect(document.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "After" }] }]);
    expect(conflictRejected).toBe(true);
  } finally {
    server.stop();
  }
});

test("real octo-cli publishes the HTML source against its version and rejects stale updates", async () => {
  let html = "<h1>Before</h1>";
  let version = 7;
  let conflictRejected = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/bot/docs/d_html") {
        return Response.json({ docId: "d_html", docType: "html", octoDocSlug: "legacy-ref", role: "writer" });
      }
      if (request.method === "GET" && url.pathname === "/docs-html/v1/docs/legacy-ref/source") {
        return Response.json({ data: { slug: "legacy-ref", version, html } });
      }
      if (request.method === "POST" && url.pathname === "/docs-html/v1/docs") {
        const body = await request.json() as { slug: string; html: string; version: number };
        if (body.slug !== "legacy-ref" || body.version !== version + 1) {
          conflictRejected = true;
          return Response.json({ error: { code: "version_conflict", message: "stale" } }, { status: 409 });
        }
        html = body.html;
        version = body.version;
        return Response.json({ data: { doc_id: "d_html", slug: "legacy-ref", version } });
      }
      return new Response("unexpected request", { status: 404 });
    },
  });
  try {
    const backend = resolve(import.meta.dir, "../src/backend.ts");
    const program = `import { readDocument, writeDocument } from ${JSON.stringify(backend)};
const snapshot = await readDocument("d_html");
await writeDocument(snapshot, "<h1>After</h1>");
let stale = false;
try { await writeDocument(snapshot, "<h1>Stale</h1>"); } catch { stale = true; }
console.log(JSON.stringify({ before: snapshot.text, stale }));`;
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: { ...process.env, OCTO_TOKEN: "bf_local_test", OCTO_CREDENTIAL_MODE: "", OCTO_API_BASE_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ before: "<h1>Before</h1>", stale: true });
    expect(html).toBe("<h1>After</h1>");
    expect(version).toBe(8);
    expect(conflictRejected).toBe(true);
  } finally {
    server.stop();
  }
});
