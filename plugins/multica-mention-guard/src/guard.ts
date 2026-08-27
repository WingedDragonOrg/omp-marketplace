import {
  classifyNoActionEvidence,
  normalizeUuid,
  validateMentionBody,
  type TaskContext,
} from "./domain";

export interface GuardComment {
  issueId: string;
  sourceTaskId: string | null;
  authorType: string;
  authorId: string;
  type: string;
  parentId: string | null;
  content: string;
}

export interface GuardSnapshot {
  comments: GuardComment[];
  agentIds: ReadonlySet<string>;
  memberIds: ReadonlySet<string>;
  expectedParentId: string | null;
  rosterVerified: boolean;
}

export interface GuardBackend {
  loadSnapshot(signal: AbortSignal): Promise<GuardSnapshot>;
  publishFinal(
    body: string,
    parentId: string | null,
    signal: AbortSignal,
    onDispatched: () => void,
  ): Promise<void>;
}

export interface StopEvent {
  signal: AbortSignal;
  stop_hook_active: boolean;
  last_assistant_message?: unknown;
}

export interface ToolResultEvent {
  toolName: string;
  input: unknown;
  content: unknown;
  isError: boolean;
}

export interface StopContinuation {
  continue: true;
  additionalContext: string;
}

type ActiveTaskContext = Extract<TaskContext, { kind: "active" }>;
type PublicationAttempt = "none" | "in_flight" | "confirmed" | "dispatch_unknown";
type FinalProblem = "empty" | "too-long" | "missing" | "invalid-target";

export class MentionGuard {
  private reminderIssued = false;
  private noActionEvidence: "none" | "permissive" | "confirmed" = "none";
  private publicationAttempt: PublicationAttempt = "none";
  private stopTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: ActiveTaskContext,
    private readonly backend: GuardBackend,
  ) {}

  observeToolResult(event: ToolResultEvent): void {
    if (event.toolName !== "bash") return;
    const command =
      typeof event.input === "object" &&
      event.input !== null &&
      !Array.isArray(event.input) &&
      "command" in event.input &&
      typeof event.input.command === "string"
        ? event.input.command
        : "";
    let output = "";
    if (Array.isArray(event.content)) {
      for (const block of event.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          output += block.text;
        }
      }
    } else if (typeof event.content === "string") {
      output = event.content;
    }

    const evidence = classifyNoActionEvidence({ command, output, isError: event.isError });
    if (
      evidence === "confirmed" ||
      (evidence === "permissive" && this.noActionEvidence === "none")
    ) {
      this.noActionEvidence = evidence;
    }
  }

  handleSessionStop(event: StopEvent): Promise<StopContinuation | undefined> {
    const run = this.stopTail.then(
      () => this.handleSessionStopSerial(event),
      () => this.handleSessionStopSerial(event),
    );
    this.stopTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleSessionStopSerial(
    event: StopEvent,
  ): Promise<StopContinuation | undefined> {
    if (this.noActionEvidence !== "none" || this.reminderIssued) return undefined;

    // Another extension owns this continuation chain. Stacking another hidden
    // turn would lose its original-final boundary and can re-open a loop.
    if (event.stop_hook_active) return undefined;

    // Once a child may have dispatched, no later entry may create another POST.
    if (this.publicationAttempt !== "none") return undefined;

    let snapshot: GuardSnapshot;
    try {
      snapshot = await this.backend.loadSnapshot(event.signal);
    } catch {
      // Do not steal the final when the guard cannot establish the routing and
      // roster snapshot. Normal Multica completion is safer than a blind hook.
      return undefined;
    }

    const body = this.serializeFinal(event.last_assistant_message);
    const currentComments = snapshot.comments.filter(comment =>
      this.belongsToCurrentTask(comment),
    );
    const exactFinalDelivered = currentComments.some(
      comment =>
        this.parentMatches(comment.parentId, snapshot.expectedParentId) &&
        this.persistableText(comment.content) === body,
    );
    const fallbackAvailable = currentComments.length === 0;

    let mentionSatisfied = false;
    let invalidTarget = false;
    for (const candidate of [body, ...currentComments.map(comment => comment.content)]) {
      const validation = validateMentionBody(
        candidate,
        { agentIds: snapshot.agentIds, memberIds: snapshot.memberIds },
        this.context.agentId,
      );
      if (validation.ok) mentionSatisfied = true;
      else if (validation.reason === "invalid-target") invalidTarget = true;
    }

    const bodyProblem = this.finalBodyProblem(body);
    const needsReminder =
      bodyProblem !== undefined ||
      !snapshot.rosterVerified ||
      invalidTarget ||
      !mentionSatisfied;
    if (exactFinalDelivered) {
      if (!needsReminder) return undefined;
      return this.coordinationReminder(
        bodyProblem ?? (invalidTarget ? "invalid-target" : "missing"),
      );
    }

    const needsManualDelivery = !exactFinalDelivered && (!fallbackAvailable || needsReminder);

    if (!needsManualDelivery) return undefined;

    const publication = await this.publishOnce(body, snapshot.expectedParentId, event.signal);
    if (publication === "confirmed") {
      if (!needsReminder) return undefined;
      return this.coordinationReminder(bodyProblem ?? (invalidTarget ? "invalid-target" : "missing"));
    }

    if (publication === "pre-dispatch-failed") {
      if (fallbackAvailable) return undefined;
      return this.deliveryRecoveryReminder();
    }

    // A request may have reached the server. Never retry it or start a second
    // reminder chain; fall back to Multica completion when possible.
    if (!fallbackAvailable) return this.deliveryUncertaintyReminder();
    return undefined;
  }

  private async publishOnce(
    body: string,
    parentId: string | null,
    signal: AbortSignal,
  ): Promise<"confirmed" | "pre-dispatch-failed" | "dispatch-unknown"> {
    this.publicationAttempt = "in_flight";
    let dispatched = false;
    try {
      await this.backend.publishFinal(body, parentId, signal, () => {
        dispatched = true;
      });
      dispatched = true;
    } catch {
      if (!dispatched) {
        this.publicationAttempt = "none";
        return "pre-dispatch-failed";
      }
      this.publicationAttempt = "dispatch_unknown";
    }

    try {
      const refreshed = await this.backend.loadSnapshot(signal);
      const confirmed = refreshed.comments.some(
        comment =>
          this.belongsToCurrentTask(comment) &&
          this.parentMatches(comment.parentId, parentId) &&
          this.persistableText(comment.content) === body,
      );
      if (confirmed) {
        this.publicationAttempt = "confirmed";
        return "confirmed";
      }
    } catch {
      // The attempt state below remains dispatch_unknown.
    }

    this.publicationAttempt = "dispatch_unknown";
    return "dispatch-unknown";
  }

  private belongsToCurrentTask(comment: GuardComment): boolean {
    return (
      normalizeUuid(comment.issueId) === this.context.issueId &&
      normalizeUuid(comment.sourceTaskId) === this.context.taskId &&
      comment.authorType === "agent" &&
      normalizeUuid(comment.authorId) === this.context.agentId &&
      comment.type === "comment"
    );
  }

  private parentMatches(actual: string | null, expected: string | null): boolean {
    const actualId = actual === null ? null : normalizeUuid(actual);
    const expectedId = expected === null ? null : normalizeUuid(expected);
    return actualId !== undefined && expectedId !== undefined && actualId === expectedId;
  }

  private serializeFinal(message: unknown): string {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      return "";
    }
    let text = "";
    for (const block of message.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        !Array.isArray(block) &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        text += block.text;
      }
    }
    return this.persistableText(text);
  }

  private persistableText(text: string): string {
    return text.replaceAll("\0", "");
  }

  private finalBodyProblem(body: string): "empty" | "too-long" | undefined {
    if (body.trim().length === 0) return "empty";
    let runeCount = 0;
    for (const _character of body) {
      runeCount++;
      if (runeCount > 8_000) return "too-long";
    }
    return undefined;
  }

  private coordinationReminder(reason: FinalProblem): StopContinuation {
    this.reminderIssued = true;
    const explanation: Record<FinalProblem, string> = {
      empty: "原始 final 为空，请只决定本轮是否需要 coordination。",
      "too-long": "原始 final 已原样交付，但正文很长；不要重述它。",
      missing: "当前 task 尚无合法 participant mention。",
      "invalid-target": "当前 task 中存在格式错误或不可用的 mention 目标。",
    };
    return {
      continue: true,
      additionalContext:
        `${explanation[reason]} 原始完整 final 已由 hook 原样发布，不要重述、改写或再次发布它。` +
        " 只有需要把具体后续工作交给某个 agent 时，才另发一条最小 coordination comment：先运行 `multica agent list --output json`，使用 `[@Name](mention://agent/<uuid>)`，并明确该 agent 要执行的具体动作；不得仅为确认、致谢或关闭线程 mention 触发者。" +
        " 如果只是确认、线程关闭或确实没有后续动作，请不要 mention 任何 agent，也不要再发 comment；可以完全不 mention。" +
        " 只有确实需要让人知晓时，才可通过 `multica workspace member list --output json` 查询 `user_id` 后另发最小 `[@Name](mention://member/<uuid>)` comment；member mention 不启动 agent run。" +
        " 本 hook 在当前 MULTICA_TASK_ID 只提醒一次；下一次 stop 无条件放行。",
    };
  }
  private deliveryUncertaintyReminder(): StopContinuation {
    this.reminderIssued = true;
    return {
      continue: true,
      additionalContext:
        "Hook 已尝试原样发布上一条 final，但 comment-add 可能已经 dispatch，交付状态未确认。不要重述、改写或重试发布原 final；本 hook也不会再次 POST。请先检查 issue feed。只有确认存在具体后续工作时，才可另发最小 agent coordination comment；无后续动作时不要 mention agent、不要发 comment。本 hook只提醒一次，下一次 stop 无条件放行。",
    };
  }


  private deliveryRecoveryReminder(): StopContinuation {
    this.reminderIssued = true;
    return {
      continue: true,
      additionalContext:
        "Hook 在真正 dispatch 前未能持久化原始 final，而当前 task 已有其它 comment，Multica fallback 会跳过 final。请不要重述或改写：使用 `--content-file` 将上一条原始 final 原样发布一次。随后再按实际需要决定是否另发最小 coordination comment；无后续动作时不要 mention agent。本 hook只提醒一次，下一次 stop 无条件放行。",
    };
  }
}
