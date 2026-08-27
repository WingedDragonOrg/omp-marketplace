const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PARTICIPANT_MENTION_PATTERN =
  /\[@(.+?)\]\(mention:\/\/(agent|member)\/([^)]+)\)/g;

export type TaskContext =
  | { kind: "inactive" }
  | {
      kind: "invalid";
      reason:
        | "partial-task-environment"
        | "invalid-task-identity"
        | "missing-task-marker"
        | "invalid-task-marker"
        | "task-marker-mismatch";
    }
  | {
      kind: "active";
      taskId: string;
      agentId: string;
      workspaceId: string;
      issueId: string;
    };

export type MentionValidation =
  | { ok: true; targetCount: number }
  | { ok: false; reason: "missing" | "invalid-target" };

export function normalizeUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

export function resolveTaskContext(
  env: Record<string, string | undefined>,
  markerText: string | undefined,
): TaskContext {
  const rawTaskId = env.MULTICA_TASK_ID?.trim() ?? "";
  const rawAgentId = env.MULTICA_AGENT_ID?.trim() ?? "";
  const rawWorkspaceId = env.MULTICA_WORKSPACE_ID?.trim() ?? "";
  const presentCount = Number(rawTaskId !== "") + Number(rawAgentId !== "") + Number(rawWorkspaceId !== "");

  if (presentCount === 0) return { kind: "inactive" };
  if (presentCount !== 3) return { kind: "invalid", reason: "partial-task-environment" };

  const taskId = normalizeUuid(rawTaskId);
  const agentId = normalizeUuid(rawAgentId);
  const workspaceId = normalizeUuid(rawWorkspaceId);
  if (!taskId || !agentId || !workspaceId) {
    return { kind: "invalid", reason: "invalid-task-identity" };
  }
  if (markerText === undefined) {
    return { kind: "invalid", reason: "missing-task-marker" };
  }

  let marker: unknown;
  try {
    marker = JSON.parse(markerText);
  } catch {
    return { kind: "invalid", reason: "invalid-task-marker" };
  }
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return { kind: "invalid", reason: "invalid-task-marker" };
  }
  const markerFields = marker as {
    managed_by?: unknown;
    agent_id?: unknown;
    issue_id?: unknown;
  };
  if (markerFields.managed_by !== "multica-daemon-task") {
    return { kind: "invalid", reason: "invalid-task-marker" };
  }

  const markerAgentId = normalizeUuid(markerFields.agent_id);
  const issueId = normalizeUuid(markerFields.issue_id);
  if (!markerAgentId || !issueId) {
    return { kind: "invalid", reason: "invalid-task-marker" };
  }
  if (markerAgentId !== agentId) {
    return { kind: "invalid", reason: "task-marker-mismatch" };
  }

  return { kind: "active", taskId, agentId, workspaceId, issueId };
}

export function validateMentionBody(
  body: string,
  roster: { agentIds: ReadonlySet<string>; memberIds: ReadonlySet<string> },
  selfAgentId: string,
): MentionValidation {
  const self = normalizeUuid(selfAgentId);
  const agentIds = normalizedIdSet(roster.agentIds);
  const memberIds = normalizedIdSet(roster.memberIds);
  const uniqueTargets = new Set<string>();
  let participantMentionCount = 0;

  PARTICIPANT_MENTION_PATTERN.lastIndex = 0;
  for (const match of body.matchAll(PARTICIPANT_MENTION_PATTERN)) {
    participantMentionCount++;
    const type = match[2] as "agent" | "member";
    const id = normalizeUuid(match[3]);
    const valid =
      id !== undefined &&
      (type === "agent" ? id !== self && agentIds.has(id) : memberIds.has(id));
    if (!valid) return { ok: false, reason: "invalid-target" };
    uniqueTargets.add(`${type}:${id}`);
  }

  if (participantMentionCount === 0) return { ok: false, reason: "missing" };
  return { ok: true, targetCount: uniqueTargets.size };
}

function normalizedIdSet(ids: ReadonlySet<string>): Set<string> {
  const normalized = new Set<string>();
  for (const id of ids) {
    const value = normalizeUuid(id);
    if (value) normalized.add(value);
  }
  return normalized;
}

export function classifyNoActionEvidence(result: {
  command: string;
  output: string;
  isError: boolean;
}): "none" | "permissive" | "confirmed" {
  const command = result.command.replaceAll("\\\n", " ");
  const segments = command.split(/&&|\|\||[;\n|]/);
  const commandPattern =
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*\s+)?(?:\S*\/)?multica\b.*?\bsquad\s+activity\s+(?:"[^"]*"|'[^']*'|[^\s]+)\s+no_action\b/is;
  const hasCandidate = segments.some(segment => commandPattern.test(segment.trim()));
  if (!hasCandidate) return "none";

  if (result.output.includes("Squad evaluation recorded: no_action")) {
    return "confirmed";
  }

  if (/"action"\s*:\s*"squad_leader_evaluated"/.test(result.output)) {
    return "confirmed";
  }
  if (
    /(?:^|\n)\s*(?:error:|failed(?:\s+to)?\b)|only the squad leader agent can record evaluations|invalid outcome/i.test(
      result.output,
    )
  ) {
    return "none";
  }
  return result.isError ? "none" : "permissive";
}
