// Runtime validation for `multica --output json` payloads.
//
// Marketplace plugins are installed by symlinking the cached directory into
// `~/.omp/plugins/node_modules/<name>`; no dependency install runs, so a bare
// `import { z } from "zod"` fails to resolve at extension load time. These
// hand-written parsers keep the same accept/reject boundary the zod schemas
// had: unknown keys are ignored, a missing or mistyped known field rejects the
// whole record, and rejection is reported as `undefined`.
import { normalizeUuid } from "./domain";

export interface CommentRecord {
  issue_id: string;
  source_task_id: string | null;
  author_type: string;
  author_id: string;
  type: string;
  parent_id: string | null;
  content: string;
}

export interface AgentRecord {
  id: string;
  archived_at: string | null;
  runtime_bound: boolean;
}

export interface MemberRecord {
  user_id: string;
}

export interface RunRecord {
  id: string;
  trigger_comment_id: string | null;
}

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

export function parseComment(value: unknown): CommentRecord | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  if (
    !isString(fields.issue_id) ||
    !isString(fields.author_type) ||
    !isString(fields.author_id) ||
    !isString(fields.type) ||
    !isString(fields.content) ||
    !isOptionalNullableString(fields.source_task_id) ||
    !isOptionalNullableString(fields.parent_id)
  ) {
    return undefined;
  }
  return {
    issue_id: fields.issue_id,
    source_task_id: fields.source_task_id ?? null,
    author_type: fields.author_type,
    author_id: fields.author_id,
    type: fields.type,
    parent_id: fields.parent_id ?? null,
    content: fields.content,
  };
}

export function parseAgent(value: unknown): AgentRecord | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  if (
    !isString(fields.id) ||
    !isNullableString(fields.archived_at) ||
    typeof fields.runtime_bound !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: fields.id,
    archived_at: fields.archived_at,
    runtime_bound: fields.runtime_bound,
  };
}

export function parseMember(value: unknown): MemberRecord | undefined {
  const fields = asFields(value);
  if (!fields || !isString(fields.user_id)) return undefined;
  return { user_id: fields.user_id };
}

export function parseRun(value: unknown): RunRecord | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  if (!isString(fields.id) || !isOptionalNullableString(fields.trigger_comment_id)) {
    return undefined;
  }
  return { id: fields.id, trigger_comment_id: fields.trigger_comment_id ?? null };
}

export function parseCreatedComment(value: unknown): { id: string } | undefined {
  const fields = asFields(value);
  if (!fields) return undefined;
  const id = normalizeUuid(fields.id);
  return id === undefined ? undefined : { id };
}
