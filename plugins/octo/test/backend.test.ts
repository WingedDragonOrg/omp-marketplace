import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { readDocument, writeDocument } from "../src/backend.ts";

const fixtureEnv = [
  "OMP_OCTO_BACKEND_FIXTURE_STATE",
  "OMP_OCTO_BACKEND_FIXTURE_CALLS",
  "OMP_OCTO_BACKEND_FIXTURE_REQUEST",
] as const;
const savedEnv = new Map<string, string | undefined>([
  ["PATH", process.env.PATH],
  ...fixtureEnv.map((name) => [name, process.env[name]] as const),
]);
const temporaryRoots: string[] = [];

const fakeCli = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.OMP_OCTO_BACKEND_FIXTURE_STATE, "utf8"));
appendFileSync(process.env.OMP_OCTO_BACKEND_FIXTURE_CALLS, JSON.stringify(args) + "\\n");

function hasSequence(...parts) {
  return args.some((arg, index) => parts.every((part, offset) => args[index + offset] === part));
}
function respond(data) {
  process.stdout.write(JSON.stringify({ ok: true, identity: { type: "bot" }, data }) + "\\n");
}
async function requestBody() {
  const index = args.findIndex((arg) => arg === "--data" || arg.startsWith("--data="));
  if (index < 0) return null;
  let value = args[index].startsWith("--data=") ? args[index].slice("--data=".length) : args[index + 1];
  if (value === "@-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    value = Buffer.concat(chunks).toString("utf8");
  } else if (value.startsWith("@")) {
    value = readFileSync(value.slice(1), "utf8");
  }
  return JSON.parse(value);
}

if (hasSequence("docs", "get")) {
  respond(state.metadata);
} else if (hasSequence("docs", "content", "get")) {
  respond(state.content);
} else if (hasSequence("html", "source")) {
  respond(state.htmlSource);
} else if (hasSequence("docs", "content", "edit")) {
  if (state.editError) {
    process.stderr.write(JSON.stringify(state.editError) + "\\n");
    process.exitCode = 2;
  } else {
    writeFileSync(process.env.OMP_OCTO_BACKEND_FIXTURE_REQUEST, JSON.stringify(await requestBody()));
    respond(state.editResult);
  }
} else if (hasSequence("html", "publish")) {
  if (state.publishError) {
    process.stderr.write(JSON.stringify(state.publishError) + "\\n");
    process.exitCode = 2;
  } else {
    writeFileSync(process.env.OMP_OCTO_BACKEND_FIXTURE_REQUEST, JSON.stringify(await requestBody()));
    respond(state.publishResult);
  }
} else {
  process.stderr.write("unexpected octo-cli invocation: " + JSON.stringify(args));
  process.exitCode = 90;
}
`;

function installFixture(state: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "omp-octo-backend-test-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const cliPath = path.join(bin, "octo-cli");
  const statePath = path.join(root, "state.json");
  const callsPath = path.join(root, "calls.jsonl");
  const requestPath = path.join(root, "request.json");
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${fakeCli}`);
  chmodSync(cliPath, 0o755);
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(callsPath, "");
  process.env.PATH = [bin, savedEnv.get("PATH")].filter(Boolean).join(path.delimiter);
  process.env.OMP_OCTO_BACKEND_FIXTURE_STATE = statePath;
  process.env.OMP_OCTO_BACKEND_FIXTURE_CALLS = callsPath;
  process.env.OMP_OCTO_BACKEND_FIXTURE_REQUEST = requestPath;

  return {
    calls(): string[][] {
      const contents = readFileSync(callsPath, "utf8").trim();
      return contents ? contents.split("\n").map((line) => JSON.parse(line) as string[]) : [];
    },
    request(): Record<string, unknown> {
      return JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    },
  };
}

function hasSequence(args: string[], ...parts: string[]): boolean {
  return args.some((arg, index) => parts.every((part, offset) => args[index + offset] === part));
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Octo document backend", () => {
  test("reads ordinary documents as Markdown with their base-version snapshot", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_guide", docType: "doc", title: "Guide" },
      content: {
        docId: "d_guide",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Guide" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Keep " },
                { type: "text", text: "bold", marks: [{ type: "strong" }] },
              ],
            },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }],
            },
          ],
        },
      },
    });

    const document = await readDocument("d_guide");

    expect(document).toMatchObject({
      id: "d_guide",
      type: "doc",
      text: "## Guide\n\nKeep **bold**\n\n- item",
      version: "opaque-base-v1",
    });
    expect(fixture.calls().some((args) => hasSequence(args, "docs", "get", "d_guide"))).toBe(true);
    expect(fixture.calls().some((args) => hasSequence(args, "docs", "content", "get", "d_guide"))).toBe(true);
  });

  test("reads rich-text blocks and empty paragraphs while preserving them in unrelated edits", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_rich", docType: "doc", title: "Rich content" },
      content: {
        docId: "d_rich",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Before" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Diagram: " },
                { type: "image", attrs: { attachId: "att_map", alt: "map" } },
              ],
            },
            { type: "paragraph", content: [] },
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] },
                    { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Value" }] }] },
                  ],
                },
                {
                  type: "tableRow",
                  content: [
                    { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Count" }] }] },
                    { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "3" }] }] },
                  ],
                },
              ],
            },
          ],
        },
      },
      editResult: { docId: "d_rich", baseVersion: "opaque-base-v2" },
    });

    const document = await readDocument("d_rich");
    const expectedText = [
      "Before",
      "Diagram: ![map](octo-attachment:att_map)",
      "[[octo:empty-paragraph]]",
      "| Name | Value |\n| --- | --- |\n| Count | 3 |",
    ].join("\n\n");
    expect(document.text).toBe(expectedText);

    const updated = await writeDocument(document, expectedText.replace("Before", "After"));

    expect(updated.text).toBe(expectedText.replace("Before", "After"));
    expect(fixture.request()).toMatchObject({
      ops: [
        {
          type: "replace",
          range: { from: { path: [0] }, to: { path: [0] } },
          content: [{ type: "paragraph", content: [{ type: "text", text: "After" }] }],
        },
      ],
    });

    await expect(writeDocument(document, "Before")).rejects.toThrow(/unsupported|lossless|cannot represent/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(1);
  });

  test("renders unfamiliar rich-text blocks and preserves them as read-only snapshots", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_custom", docType: "doc", title: "Custom block" },
      content: {
        docId: "d_custom",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Before" }] },
            { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "Important" }] }] },
          ],
        },
      },
      editResult: { docId: "d_custom", baseVersion: "opaque-base-v2" },
    });
    const document = await readDocument("d_custom");
    const rendered = "Before\n\n\\[Unsupported Octo block callout: Important\\]";

    expect(document.text).toBe(rendered);
    const updated = await writeDocument(document, rendered.replace("Before", "After"));
    expect(updated.text).toBe(rendered.replace("Before", "After"));
    expect(fixture.request()).toMatchObject({
      ops: [{ type: "replace", range: { from: { path: [0] }, to: { path: [0] } } }],
    });

    await expect(writeDocument(document, "Before")).rejects.toThrow(/Unsupported ProseMirror node "callout"/);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(1);
  });

  test("reads HTML through the metadata's canonical slug and retains source version", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_html", docType: "html", octoDocSlug: "legacy-html-ref", title: "Interactive" },
      htmlSource: { slug: "legacy-html-ref", version: 7, html: "<!doctype html><h1>Interactive</h1>" },
    });

    const document = await readDocument("d_html");

    expect(document).toMatchObject({
      id: "d_html",
      type: "html",
      text: "<!doctype html><h1>Interactive</h1>",
      version: 7,
    });
    expect(fixture.calls().some((args) => hasSequence(args, "html", "source", "legacy-html-ref"))).toBe(true);
  });
  test("publishes HTML to the metadata slug using the next source version", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_html", docType: "html", octoDocSlug: "legacy-html-ref", title: "Interactive" },
      htmlSource: { slug: "legacy-html-ref", version: 7, html: "<!doctype html><h1>Interactive</h1>" },
      publishResult: { doc_id: "d_html", slug: "legacy-html-ref", version: 8 },
    });
    const snapshot = await readDocument("d_html");
    const html = "<!doctype html><h1>Updated</h1>";

    const updated = await writeDocument(snapshot, html);

    const publishCall = fixture.calls().find((args) => hasSequence(args, "html", "publish"));
    expect(publishCall).toBeDefined();
    expect(fixture.request()).toEqual({ html, slug: "legacy-html-ref", version: 8 });
    expect(fixture.request()).not.toHaveProperty("idempotency_key");
    expect(updated).toMatchObject({ id: "d_html", type: "html", text: html, version: 8 });
  });

  test("applies a safe rich-text edit with the read version and preserves Markdown formatting", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_edit", docType: "doc", title: "Guide" },
      content: {
        docId: "d_edit",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Guide" }] },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Keep " },
                { type: "text", text: "bold", marks: [{ type: "strong" }] },
              ],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Change " },
                { type: "text", text: "old", marks: [{ type: "strong" }] },
              ],
            },
          ],
        },
      },
      editResult: { docId: "d_edit", baseVersion: "opaque-base-v2" },
    });
    const snapshot = await readDocument("d_edit");

    const updated = await writeDocument(snapshot, "## Guide\n\nKeep **bold**\n\nChange **new**");

    const editCall = fixture.calls().find((args) => hasSequence(args, "docs", "content", "edit"));
    expect(editCall).toBeDefined();
    expect(flagValue(editCall!, "--base-version")).toBe("opaque-base-v1");
    expect(fixture.request()).toMatchObject({
      ops: [
        {
          type: "replace",
          range: { from: { path: [2] }, to: { path: [2] } },
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Change " },
                { type: "text", text: "new", marks: [{ type: "strong" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(updated).toMatchObject({
      id: "d_edit",
      type: "doc",
      text: "## Guide\n\nKeep **bold**\n\nChange **new**",
      version: "opaque-base-v2",
    });
  });

  test("surfaces the CLI's stale-version diagnostic without retrying stale content", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_conflict", docType: "doc", title: "Conflict" },
      content: {
        docId: "d_conflict",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }] },
      },
      editError: {
        ok: false,
        error: { type: "validation", code: "base_version_stale", message: "remote body changed after this snapshot" },
      },
    });
    const snapshot = await readDocument("d_conflict");

    let error = "";
    try {
      await writeDocument(snapshot, "After");
    } catch (caught) {
      error = String(caught);
    }
    expect(error).toContain("base_version_stale");
    expect(error).toContain("remote body changed after this snapshot");
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(1);
  });

  test("rejects unsupported document types instead of treating them as Markdown", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_sheet", docType: "sheet", title: "Numbers" },
    });

    await expect(readDocument("d_sheet")).rejects.toThrow(/unsupported.*(sheet|document type)/i);

    expect(fixture.calls().some((args) => hasSequence(args, "docs", "content", "get"))).toBe(false);
  });

  test("rejects Markdown that cannot be represented losslessly before sending a block edit", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_raw_html", docType: "doc", title: "Markup" },
      content: {
        docId: "d_raw_html",
        baseVersion: "opaque-base-v1",
        schemaVersion: 1,
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }] },
      },
    });
    const snapshot = await readDocument("d_raw_html");

    await expect(writeDocument(snapshot, "<section><em>unsupported raw HTML</em></section>")).rejects.toThrow(/lossless|unsupported|cannot represent/i);
    await expect(writeDocument(snapshot, "Before\n\n![map](octo-attachment:)")).rejects.toThrow(/attachment identifier/i);

    expect(fixture.calls().some((args) => hasSequence(args, "docs", "content", "edit"))).toBe(false);
  });
});
