import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { readDocument, writeDocument } from "../src/backend.ts";

const fixtureEnv = [
  "OMP_OCTO_BACKEND_SAFETY_STATE",
  "OMP_OCTO_BACKEND_SAFETY_CALLS",
  "OMP_OCTO_BACKEND_SAFETY_REQUEST",
  "OMP_OCTO_BACKEND_SAFETY_RELEASE",
] as const;
const savedEnv = new Map<string, string | undefined>([
  ["PATH", process.env.PATH],
  ...fixtureEnv.map((name) => [name, process.env[name]] as const),
]);
const temporaryRoots: string[] = [];

const fakeCli = `
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.OMP_OCTO_BACKEND_SAFETY_STATE, "utf8"));
const callsPath = process.env.OMP_OCTO_BACKEND_SAFETY_CALLS;
appendFileSync(callsPath, JSON.stringify(args) + "\\n");

function hasSequence(...parts) {
  return args.some((arg, index) => parts.every((part, offset) => args[index + offset] === part));
}
function flagValue(flag) {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(flag + "="))?.slice(flag.length + 1);
}
function respond(data) {
  process.stdout.write(JSON.stringify({ ok: true, identity: { type: "bot" }, data }) + "\\n");
}
function waitForRelease() {
  const releasePath = process.env.OMP_OCTO_BACKEND_SAFETY_RELEASE;
  if (existsSync(releasePath)) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers();
  const watcher = watch(dirname(releasePath), (_eventType, filename) => {
    if (filename?.toString() !== basename(releasePath)) return;
    watcher.close();
    resolve();
  });
  if (existsSync(releasePath)) {
    watcher.close();
    resolve();
  }
  return promise;
}
async function maybeBlock() {
  if (state.blockCall && hasSequence(...state.blockCall.split(" "))) await waitForRelease();
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

async function main() {
  if (hasSequence("docs", "get")) {
    await maybeBlock();
    respond(state.metadata);
  } else if (hasSequence("docs", "content", "get")) {
    await maybeBlock();
    respond(state.content);
  } else if (hasSequence("html", "source")) {
    await maybeBlock();
    respond(state.htmlSource);
  } else if (hasSequence("docs", "content", "edit")) {
    const request = await requestBody();
    writeFileSync(process.env.OMP_OCTO_BACKEND_SAFETY_REQUEST, JSON.stringify(request));
    if (flagValue("--base-version") !== state.content.baseVersion) {
      process.stderr.write("base_version_stale: remote body changed after this snapshot\\n");
      process.exitCode = 2;
      return;
    }
    await maybeBlock();
    respond(state.editResult);
  } else if (hasSequence("html", "publish")) {
    const request = await requestBody();
    writeFileSync(process.env.OMP_OCTO_BACKEND_SAFETY_REQUEST, JSON.stringify(request));
    if (request.version !== state.htmlSource.version + 1) {
      process.stderr.write("html_version_stale: remote source changed after this snapshot\\n");
      process.exitCode = 2;
      return;
    }
    await maybeBlock();
    respond(state.publishResult);
  } else {
    process.stderr.write("unexpected octo-cli invocation: " + JSON.stringify(args));
    process.exitCode = 90;
  }
}

await main();
`;

function installFixture(state: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "omp-octo-backend-safety-test-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const cliPath = path.join(bin, "octo-cli");
  const statePath = path.join(root, "state.json");
  const callsPath = path.join(root, "calls.jsonl");
  const requestPath = path.join(root, "request.json");
  const releasePath = path.join(root, "release");
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${fakeCli}`);
  chmodSync(cliPath, 0o755);
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(callsPath, "");
  process.env.PATH = [bin, savedEnv.get("PATH")].filter(Boolean).join(path.delimiter);
  process.env.OMP_OCTO_BACKEND_SAFETY_STATE = statePath;
  process.env.OMP_OCTO_BACKEND_SAFETY_CALLS = callsPath;
  process.env.OMP_OCTO_BACKEND_SAFETY_RELEASE = releasePath;
  process.env.OMP_OCTO_BACKEND_SAFETY_REQUEST = requestPath;

  return {
    calls(): string[][] {
      const contents = readFileSync(callsPath, "utf8").trim();
      return contents ? contents.split("\n").map((line) => JSON.parse(line) as string[]) : [];
    },
    request(): Record<string, unknown> | undefined {
      if (!existsSync(requestPath)) return undefined;
      return JSON.parse(readFileSync(requestPath, "utf8")) as Record<string, unknown>;
    },
    setState(nextState: Record<string, unknown>): void {
      writeFileSync(statePath, JSON.stringify(nextState));
    },
    release(): void {
      writeFileSync(releasePath, "");
    },
    async waitFor(predicate: () => boolean): Promise<void> {
      while (!predicate()) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const watcher = watch(root, () => {
          watcher.close();
          resolve();
        });
        if (predicate()) {
          watcher.close();
          resolve();
        }
        await promise;
      }
    },
  };
}

function hasSequence(args: string[], ...parts: string[]): boolean {
  return args.some((arg, index) => parts.every((part, offset) => args[index + offset] === part));
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Octo backend safety", () => {
  test("preserves same-paragraph strong+em formatting or rejects before editing", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_marks", docType: "doc", title: "Combined marks" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Before " },
                { type: "text", text: "X", marks: [{ type: "strong" }, { type: "em" }] },
                { type: "text", text: " after" },
              ],
            },
          ],
        },
      },
      editResult: { baseVersion: "opaque-base-v2" },
    });
    const document = await readDocument("d_marks");
    expect(document.text).toBe("Before ***X*** after");

    const result = await writeDocument(document, "Changed ***X*** after").then(
      (updated) => ({ updated }),
      (error: unknown) => ({ error }),
    );

    if ("error" in result) {
      expect(String(result.error)).toMatch(/lossless|cannot represent|unsupported/i);
      expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(0);
      return;
    }

    expect(result.updated.text).toBe("Changed ***X*** after");
    expect(JSON.stringify(fixture.request()?.ops)).toContain(
      '"text":"X","marks":[{"type":"strong"},{"type":"em"}]',
    );
  });

  test("rejects direct replacement of an Unsupported block placeholder before editing", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_unsupported", docType: "doc", title: "Unsupported block" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: {
          type: "doc",
          content: [
            { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "Important" }] }] },
          ],
        },
      },
    });
    const document = await readDocument("d_unsupported");

    await expect(writeDocument(document, "Ordinary replacement")).rejects.toThrow(/unsupported|lossless|cannot represent/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(0);
  });

  test("edits a CLI-created paragraph with null defaults and can restore it to empty", async () => {
    const paragraphAttrs = {
      indent: null,
      lineHeight: null,
      spaceAfter: null,
      spaceBefore: null,
      textAlign: null,
    };
    const initialState = {
      metadata: { docId: "d_cli_paragraph", docType: "doc", title: "CLI-created paragraph" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: paragraphAttrs,
              content: [{ type: "text", text: "Temporary content" }],
            },
          ],
        },
      },
      editResult: { baseVersion: "opaque-base-v2" },
    };
    const fixture = installFixture(initialState);
    const document = await readDocument("d_cli_paragraph");

    const edited = await writeDocument(document, "Updated content");
    expect(edited.text).toBe("Updated content");
    expect(fixture.request()).toMatchObject({
      ops: [
        {
          type: "replace",
          content: [
            {
              type: "paragraph",
              attrs: paragraphAttrs,
              content: [{ type: "text", text: "Updated content" }],
            },
          ],
        },
      ],
    });

    fixture.setState({
      ...initialState,
      content: { ...initialState.content, baseVersion: "opaque-base-v2" },
      editResult: { baseVersion: "opaque-base-v3" },
    });
    const cleared = await writeDocument(edited, "");
    expect(cleared.text).toBe("");
    expect(fixture.request()).toMatchObject({
      ops: [{ type: "delete", expect: { type: "paragraph" } }],
    });
  });

  test("rejects editing a paragraph with non-null unsupported formatting", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_formatted_paragraph", docType: "doc", title: "Formatted paragraph" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: {
                indent: null,
                lineHeight: null,
                spaceAfter: null,
                spaceBefore: null,
                textAlign: "center",
              },
              content: [{ type: "text", text: "Keep alignment" }],
            },
          ],
        },
      },
    });
    const document = await readDocument("d_formatted_paragraph");

    await expect(writeDocument(document, "Change alignment text")).rejects.toThrow(/formatting not representable/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(0);
  });

  test("does not report success when an ordinary document snapshot is stale even for identical text", async () => {
    const initialState = {
      metadata: { docId: "d_stale_doc", docType: "doc", title: "Stale document" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V1" }] }] },
      },
      editResult: { baseVersion: "opaque-base-v3" },
    };
    const fixture = installFixture(initialState);
    const document = await readDocument("d_stale_doc");
    fixture.setState({
      ...initialState,
      content: {
        baseVersion: "opaque-base-v2",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V2" }] }] },
      },
    });

    await expect(writeDocument(document, document.text)).rejects.toThrow();
  });

  test("does not report success on a stale snapshot for Markdown-equivalent input", async () => {
    const initialState = {
      metadata: { docId: "d_equivalent_stale_doc", docType: "doc", title: "Equivalent stale document" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V1" }] }] },
      },
    };
    const fixture = installFixture(initialState);
    const document = await readDocument("d_equivalent_stale_doc");
    const equivalentText = `${document.text}\n`;
    expect(equivalentText).not.toBe(document.text);
    await expect(writeDocument(document, equivalentText)).resolves.toBe(document);

    fixture.setState({
      ...initialState,
      content: {
        baseVersion: "opaque-base-v2",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "V2" }] }] },
      },
    });

    await expect(writeDocument(document, equivalentText)).rejects.toThrow();
  });

  test("does not report success when an HTML snapshot is stale even for identical text", async () => {
    const initialState = {
      metadata: { docId: "d_stale_html", docType: "html", octoDocSlug: "stale-html" },
      htmlSource: { slug: "stale-html", version: 7, html: "<h1>V1</h1>" },
      publishResult: { slug: "stale-html", version: 8 },
    };
    const fixture = installFixture(initialState);
    const document = await readDocument("d_stale_html");
    fixture.setState({
      ...initialState,
      htmlSource: { slug: "stale-html", version: 8, html: "<h1>V2</h1>" },
    });

    await expect(writeDocument(document, document.text)).rejects.toThrow();
  });

  test("forwards cancellation to an in-flight CLI read and stops follow-up reads", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_cancel_read", docType: "doc", title: "Cancelable read" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Read" }] }] },
      },
      blockCall: "docs get",
    });
    const controller = new AbortController();
    const reading = readDocument("d_cancel_read", controller.signal);
    await fixture.waitFor(() => fixture.calls().length === 1);

    controller.abort();
    fixture.release();
    await expect(reading).rejects.toThrow();
    expect(fixture.calls()).toHaveLength(1);
  });

  test("checks cancellation before launching a document edit", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_cancel_before_edit", docType: "doc", title: "Cancelable edit" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }] },
      },
      editResult: { baseVersion: "opaque-base-v2" },
    });
    const document = await readDocument("d_cancel_before_edit");
    const controller = new AbortController();
    controller.abort();

    const cancellation = await writeDocument(document, "After", controller.signal).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(cancellation).toMatch(/abort|cancel/i);
    expect(cancellation).not.toMatch(/may have been written|re-read/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(0);
  });

  test("does not report definite success after an issued edit is canceled", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_cancel_inflight", docType: "doc", title: "Cancelable edit" },
      content: {
        baseVersion: "opaque-base-v1",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }] },
      },
      editResult: { baseVersion: "opaque-base-v2" },
      blockCall: "docs content edit",
    });
    const document = await readDocument("d_cancel_inflight");
    const controller = new AbortController();
    const writing = writeDocument(document, "After", controller.signal);
    await fixture.waitFor(() => fixture.request() !== undefined);

    controller.abort();
    fixture.release();

    const cancellation = await writing.then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(cancellation).toMatch(/may have been written; re-read the document to verify/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "docs", "content", "edit"))).toHaveLength(1);
  });

  test("warns that HTML may have been written after an issued publish is canceled", async () => {
    const fixture = installFixture({
      metadata: { docId: "d_cancel_html", docType: "html", octoDocSlug: "cancel-html" },
      htmlSource: { slug: "cancel-html", version: 7, html: "<h1>Before</h1>" },
      publishResult: { slug: "cancel-html", version: 8 },
      blockCall: "html publish",
    });
    const document = await readDocument("d_cancel_html");
    const controller = new AbortController();
    const writing = writeDocument(document, "<h1>After</h1>", controller.signal);
    await fixture.waitFor(() => fixture.request() !== undefined);

    controller.abort();
    fixture.release();

    const cancellation = await writing.then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(cancellation).toMatch(/may have been written; re-read the document to verify/i);
    expect(fixture.calls().filter((args) => hasSequence(args, "html", "publish"))).toHaveLength(1);
  });
});
