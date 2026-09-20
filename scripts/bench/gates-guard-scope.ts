/**
 * Four fixed offline workloads over production plugin code: skill-gate
 * (allow/deny gates, registry hot re-read), multica-mention-guard (roster
 * validation, stop-state reduction) and auto-learn-scope (project-skill
 * create/update/delete roundtrip).
 *
 * Fixtures live in temp dirs created by setup() and removed by teardown();
 * nothing touches the network, the `multica` CLI, or the user's own config (the
 * runner disables globalThis.fetch). run() repeats a frozen loop count, so every
 * round does identical work and returns the same checksum; exhaustive
 * defence-branch coverage stays with the plugins' own test suites.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type ProjectSkillWriter,
	createProjectSkillWriter,
} from "../../plugins/auto-learn-scope/src/project-skills.ts";
import { type GateContext, evaluateGate, parseGate } from "../../plugins/skill-gate/src/gate.ts";
import { type ActiveSkill, SkillGateRegistry } from "../../plugins/skill-gate/src/registry.ts";
import {
	resolveTaskContext,
	validateMentionBody,
} from "../../plugins/multica-mention-guard/src/domain.ts";
import {
	type GuardBackend,
	type GuardComment,
	type GuardSnapshot,
	MentionGuard,
} from "../../plugins/multica-mention-guard/src/guard.ts";
import type { BenchmarkCase } from "./types";

const FNV_OFFSET = 0x811c9dc5;

/** FNV-1a mixing of numeric observations only: no text hashing in the timed path. */
function fold(hash: number, value: number): number {
	return Math.imul(hash ^ (value | 0), 0x01000193) >>> 0;
}

const BENCH_ENV: Record<string, string | undefined> = {
	BENCH_FLAG: "on",
	BENCH_MODE: "fast",
	BENCH_ON: "yes",
};

/** The frozen host context every gate decision is made against. */
function benchContext(cwd: string): GateContext {
	return { platform: "darwin", arch: "arm64", cwd, home: "/bench/home", env: BENCH_ENV };
}

/* ---------------------------------------------------- skill-gate: evaluation */

type GateFixture = {
	readonly label: string;
	readonly raw: unknown;
	readonly ok: boolean;
	readonly failures: number;
	readonly errors: number;
};

const GATE_FIXTURES: readonly GateFixture[] = [
	{ label: "os-arch", raw: { os: ["darwin"], arch: ["arm64"] }, ok: true, failures: 0, errors: 0 },
	{ label: "os-negated", raw: { os: ["!darwin"] }, ok: false, failures: 1, errors: 0 },
	{ label: "env-presence", raw: { env: { BENCH_FLAG: true, BENCH_ABSENT: false } }, ok: true, failures: 0, errors: 0 },
	{ label: "env-regex", raw: { env: { BENCH_MODE: "/^(fast|slow)$/" } }, ok: true, failures: 0, errors: 0 },
	{ label: "env-missing", raw: { env: { BENCH_ABSENT: true } }, ok: false, failures: 1, errors: 0 },
	{ label: "cwd", raw: { cwd: ["__ROOT__"] }, ok: true, failures: 0, errors: 0 },
	{ label: "files-hit", raw: { files: ["package.json"] }, ok: true, failures: 0, errors: 0 },
	{ label: "files-miss", raw: { files: ["missing-*.lock"] }, ok: false, failures: 1, errors: 0 },
	{ label: "command", raw: { command: ["git"] }, ok: true, failures: 0, errors: 0 },
	{ label: "any-nested", raw: { any: [{ env: { BENCH_MODE: "slow" } }, { files: ["missing-*.lock"] }] }, ok: false, failures: 1, errors: 0 },
	{ label: "all-not-nested", raw: { all: [{ os: ["darwin"] }, { not: { files: ["missing-*.lock"] } }] }, ok: true, failures: 0, errors: 0 },
	{ label: "unknown-condition", raw: { os: ["darwin"], bogus_key: true }, ok: true, failures: 0, errors: 1 },
];

const GATE_PASSES = 52;

let gateRoot = "";
let gateFixtures: GateFixture[] = [];
let gateContext: GateContext | undefined;

const skillGateNestedEval: BenchmarkCase = {
	name: "skill_gate_nested_eval",
	operations: GATE_FIXTURES.length * GATE_PASSES,
	async setup() {
		gateRoot = await mkdtemp(join(tmpdir(), "omp-bench-gates-"));
		await writeFile(join(gateRoot, "package.json"), '{"name":"bench-fixture"}\n', "utf8");
		gateFixtures = GATE_FIXTURES.map((fixture) => ({
			...fixture,
			raw: JSON.parse(JSON.stringify(fixture.raw).replaceAll("__ROOT__", gateRoot)),
		}));
		gateContext = benchContext(gateRoot);
	},
	async run(): Promise<number> {
		let hash = FNV_OFFSET;
		for (let pass = 0; pass < GATE_PASSES; pass += 1) {
			for (const fixture of gateFixtures) {
				const parsed = parseGate(fixture.raw, "when");
				hash = fold(hash, parsed.errors.length);
				if (!parsed.block) continue;
				const result = await evaluateGate(parsed.block, gateContext!);
				hash = fold(hash, result.ok ? 1 : 0);
				hash = fold(hash, result.failures.length);
			}
		}
		return hash >>> 0;
	},
	async verify(): Promise<void> {
		for (const fixture of gateFixtures) {
			const parsed = parseGate(fixture.raw, "when");
			assert.equal(parsed.errors.length, fixture.errors, `${fixture.label}: parse errors`);
			assert.ok(parsed.block, `${fixture.label}: gate must parse`);
			const result = await evaluateGate(parsed.block, gateContext!);
			assert.equal(result.ok, fixture.ok, `${fixture.label}: allow/deny verdict`);
			assert.equal(result.failures.length, fixture.failures, `${fixture.label}: failure count`);
		}
	},
	async teardown() {
		if (gateRoot) await rm(gateRoot, { recursive: true, force: true });
	},
};

/* ------------------------------------------------ skill-gate: registry cache */

const BLOCKED_GATE = "---\nname: gated_off\ndescription: Requires env.\nwhen:\n  env:\n    BENCH_OFF: true\n---\n\nBody.\n";
const BLOCKED_GATE_SATISFIED =
	"---\nname: gated_off\ndescription: Requires env.\nwhen:\n  env:\n    BENCH_ON: true\n---\n\nBody.\n";
const REGISTRY_PASSES = 56;
/** Fixed mtimes: the cache is keyed on mtime equality, so no wall clock may leak in. */
const BLOCKED_EPOCH = new Date("2024-01-01T00:00:00.000Z");
const SATISFIED_EPOCH = new Date("2024-06-01T00:00:00.000Z");

let registryRoot = "";
let registryContext: GateContext | undefined;
let registrySkills: ActiveSkill[] = [];

const skillGateRegistryHotRead: BenchmarkCase = {
	name: "skill_gate_registry_hot_read",
	operations: 2 * 2 * REGISTRY_PASSES,
	async setup() {
		registryRoot = await mkdtemp(join(tmpdir(), "omp-bench-registry-"));
		await writeFile(join(registryRoot, "always_on.md"), "---\nname: always_on\ndescription: No gate.\n---\n\nBody.\n");
		await writeFile(join(registryRoot, "gated_off.md"), BLOCKED_GATE);
		await utimes(join(registryRoot, "gated_off.md"), BLOCKED_EPOCH, BLOCKED_EPOCH);
		registryContext = benchContext(registryRoot);
		registrySkills = ["always_on", "gated_off"].map((name) => ({
			name,
			description: name,
			filePath: join(registryRoot, `${name}.md`),
			baseDir: registryRoot,
		}));
	},
	async run(): Promise<number> {
		let hash = FNV_OFFSET;
		for (let pass = 0; pass < REGISTRY_PASSES; pass += 1) {
			const registry = new SkillGateRegistry();
			// The first read loads every skill file, the second hits the mtime cache.
			const cold = await registry.evaluate(registrySkills, registryContext!);
			const hot = await registry.evaluate(registrySkills, registryContext!);
			hash = fold(hash, registry.blocked.size);
			for (const decisions of [cold, hot]) {
				for (const decision of decisions) {
					hash = fold(hash, decision.gated ? 1 : 0);
					hash = fold(hash, decision.allowed ? 1 : 0);
					hash = fold(hash, decision.reasons.length);
					hash = fold(hash, decision.errors.length);
				}
			}
		}
		return hash >>> 0;
	},
	async verify(): Promise<void> {
		const registry = new SkillGateRegistry();
		const decisions = await registry.evaluate(registrySkills, registryContext!);
		assert.deepEqual([...registry.blocked], ["gated_off"], "gated-off skill must be hidden");
		const gated = decisions.find((decision) => decision.skill.name === "gated_off")!;
		assert.equal(gated.gated && !gated.allowed, true, "gated skill must report its blocked verdict");
		const alwaysOn = decisions.find((decision) => decision.skill.name === "always_on")!;
		assert.equal(alwaysOn.gated || !alwaysOn.allowed, false, "ungated skill must stay visible");

		// Hot re-read: an edited gate takes effect on the next evaluate.
		const blockedFile = join(registryRoot, "gated_off.md");
		await writeFile(blockedFile, BLOCKED_GATE_SATISFIED);
		await utimes(blockedFile, SATISFIED_EPOCH, SATISFIED_EPOCH);
		await registry.evaluate(registrySkills, registryContext!);
		assert.equal(registry.blocked.size, 0, "edited gate must be re-read");
		// Restore the blocked gate and its fixture mtime so both passes start equal.
		await writeFile(blockedFile, BLOCKED_GATE);
		await utimes(blockedFile, BLOCKED_EPOCH, BLOCKED_EPOCH);
	},
	async teardown() {
		if (registryRoot) await rm(registryRoot, { recursive: true, force: true });
	},
};

/* ------------------------------------------------------- multica mention guard */

const SELF_AGENT = "11111111-1111-1111-1111-111111111111";
const PEER_AGENT = "22222222-2222-2222-2222-222222222222";
const UNKNOWN_AGENT = "44444444-4444-4444-4444-444444444444";
const TASK_ID = "55555555-5555-5555-5555-555555555555";
const WORKSPACE_ID = "66666666-6666-6666-6666-666666666666";
const ISSUE_ID = "77777777-7777-7777-7777-777777777777";
const PARENT_ID = "88888888-8888-8888-8888-888888888888";
const AGENT_MENTION = `[@Peer](mention://agent/${PEER_AGENT})`;
const ROSTER = { agentIds: new Set([SELF_AGENT, PEER_AGENT]), memberIds: new Set<string>() };
const STOP_SIGNAL = new AbortController().signal;
const MENTION_PASSES = 400;

const MENTION_BODIES: ReadonlyArray<{
	body: string;
	ok: boolean;
	reason: "missing" | "invalid-target";
	targets: number;
}> = [
	{ body: AGENT_MENTION, ok: true, reason: "missing", targets: 1 },
	{ body: `${AGENT_MENTION} again ${AGENT_MENTION}`, ok: true, reason: "missing", targets: 1 },
	{ body: "Finished the work.", ok: false, reason: "missing", targets: 0 },
	{ body: `[@Me](mention://agent/${SELF_AGENT})`, ok: false, reason: "invalid-target", targets: 0 },
	{ body: `[@Ghost](mention://agent/${UNKNOWN_AGENT})`, ok: false, reason: "invalid-target", targets: 0 },
];

interface StopScenario {
	readonly label: string;
	readonly body: string;
	/** An earlier, different comment of this task exists, so fallback delivery is gone. */
	readonly ownPriorComment?: boolean;
	readonly publish: "confirm" | "dispatched-then-failed";
	readonly snapshotUnavailable?: boolean;
	/** Consumer-visible outcome of the first stop. */
	readonly continued: boolean;
	/** Publications across both stops: a second POST must never happen. */
	readonly publishes: number;
}

const STOP_SCENARIOS: readonly StopScenario[] = [
	{ label: "publish-then-release", body: `Done. ${AGENT_MENTION}`, ownPriorComment: true, publish: "confirm", continued: false, publishes: 1 },
	{ label: "block-missing-mention", body: "Done, nothing to hand over.", publish: "confirm", continued: true, publishes: 1 },
	{ label: "never-retry-unknown-dispatch", body: `Done. ${AGENT_MENTION}`, ownPriorComment: true, publish: "dispatched-then-failed", continued: true, publishes: 1 },
	{ label: "fail-closed-without-roster", body: `Done. ${AGENT_MENTION}`, publish: "confirm", snapshotUnavailable: true, continued: false, publishes: 0 },
];

function taskComment(content: string, parentId: string): GuardComment {
	return { issueId: ISSUE_ID, sourceTaskId: TASK_ID, authorType: "agent", authorId: SELF_AGENT, type: "comment", parentId, content };
}

/** Drives two consecutive stops through the real guard against a stub backend. */
async function driveStop(scenario: StopScenario): Promise<{ continued: boolean; publishes: number }> {
	const comments: GuardComment[] = scenario.ownPriorComment
		? [taskComment("Earlier progress note.", PARENT_ID)]
		: [];
	let publishes = 0;
	const snapshot = (): GuardSnapshot => ({
		comments: [...comments],
		agentIds: ROSTER.agentIds,
		memberIds: ROSTER.memberIds,
		expectedParentId: PARENT_ID,
		rosterVerified: true,
	});
	const backend: GuardBackend = {
		async loadSnapshot() {
			if (scenario.snapshotUnavailable) throw new Error("snapshot unavailable");
			return snapshot();
		},
		async publishFinal(body, parentId, _signal, onDispatched) {
			publishes += 1;
			onDispatched();
			if (scenario.publish === "dispatched-then-failed") throw new Error("dispatch unconfirmed");
			comments.push(taskComment(body, parentId ?? PARENT_ID));
		},
	};
	const guard = new MentionGuard({ kind: "active", taskId: TASK_ID, agentId: SELF_AGENT, workspaceId: WORKSPACE_ID, issueId: ISSUE_ID }, backend);
	const event = {
		signal: STOP_SIGNAL,
		stop_hook_active: false,
		last_assistant_message: { content: [{ type: "text", text: scenario.body }] },
	};
	const first = await guard.handleSessionStop(event);
	// A later stop must never re-POST the final: the counts below cover both stops.
	await guard.handleSessionStop(event);
	return { continued: first !== undefined, publishes };
}

const mentionGuardStopReduction: BenchmarkCase = {
	name: "mention_guard_stop_reduction",
	operations: (MENTION_BODIES.length + STOP_SCENARIOS.length) * MENTION_PASSES,
	async run(): Promise<number> {
		let hash = FNV_OFFSET;
		for (let pass = 0; pass < MENTION_PASSES; pass += 1) {
			for (const fixture of MENTION_BODIES) {
				const validation = validateMentionBody(fixture.body, ROSTER, SELF_AGENT);
				hash = fold(hash, validation.ok ? 1 : 0);
				hash = fold(hash, validation.ok ? validation.targetCount : validation.reason.length);
			}
			for (const scenario of STOP_SCENARIOS) {
				const observation = await driveStop(scenario);
				hash = fold(hash, observation.continued ? 1 : 0);
				hash = fold(hash, observation.publishes);
			}
		}
		return hash >>> 0;
	},
	async verify(): Promise<void> {
		for (const fixture of MENTION_BODIES) {
			const validation = validateMentionBody(fixture.body, ROSTER, SELF_AGENT);
			assert.equal(validation.ok, fixture.ok, `${fixture.body}: mention verdict`);
			assert.equal(
				validation.ok ? validation.targetCount : validation.reason,
				fixture.ok ? fixture.targets : fixture.reason,
				"duplicate mentions count once, bad targets are rejected",
			);
		}
		const active = resolveTaskContext({}, undefined);
		assert.equal(active.kind, "inactive", "no task signal must stay passive");
		for (const scenario of STOP_SCENARIOS) {
			const observation = await driveStop(scenario);
			assert.equal(observation.continued, scenario.continued, `${scenario.label}: continuation`);
			assert.equal(observation.publishes, scenario.publishes, `${scenario.label}: publications across both stops`);
		}
	},
};

/* ------------------------------------------------------ auto-learn-scope writer */

const WRITER_SKILL = "bench-roundtrip";
const WRITER_PROBE = "bench-verify-probe";
const WRITER_DESCRIPTION = "Fixed roundtrip workload.";
const WRITER_DESCRIPTION_UPDATED = "Fixed roundtrip workload updated.";
const WRITER_BODY = "# Bench Roundtrip\n\n1. First step.";
const WRITER_BODY_UPDATED = "# Bench Roundtrip\n\n1. Replaced step.";

/** Byte-for-byte shape the writer persists for a plain (unquoted) description. */
function standardSkillText(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

function skillDir(root: string, name: string): string {
	return join(root, ".omp", "skills", name);
}

let writerRoot = "";
let writerCwd = "";
let projectWriter: ProjectSkillWriter | undefined;

const projectSkillWriterCycle: BenchmarkCase = {
	name: "project_skill_writer_cycle",
	operations: 3,
	async setup() {
		writerRoot = await mkdtemp(join(tmpdir(), "omp-bench-writer-"));
		execFileSync("git", ["init", "--quiet", writerRoot], { stdio: "ignore" });
		writerCwd = join(writerRoot, "packages", "app");
		await mkdir(writerCwd, { recursive: true });
		projectWriter = createProjectSkillWriter();
	},
	async run(): Promise<number> {
		const writer = projectWriter!;
		const created = await writer.create({ cwd: writerCwd, name: WRITER_SKILL, description: WRITER_DESCRIPTION, body: WRITER_BODY });
		const first = await readFile(created.path, "utf8");
		await writer.update({ cwd: writerCwd, name: WRITER_SKILL, description: WRITER_DESCRIPTION_UPDATED, body: WRITER_BODY_UPDATED });
		const second = await readFile(created.path, "utf8");
		await writer.delete({ cwd: writerCwd, name: WRITER_SKILL });
		// Only the persisted bytes are folded: fixture paths must not leak in.
		let hash = fold(FNV_OFFSET, first.length);
		hash = fold(hash, second.length);
		return hash >>> 0;
	},
	async verify(): Promise<void> {
		const writer = projectWriter!;
		await rm(skillDir(writerRoot, WRITER_PROBE), { recursive: true, force: true });
		const created = await writer.create({ cwd: writerCwd, name: WRITER_PROBE, description: WRITER_DESCRIPTION, body: WRITER_BODY });
		assert.equal(created.path, join(skillDir(writerRoot, WRITER_PROBE), "SKILL.md"), "project path layout");
		const persisted = await readFile(created.path, "utf8");
		assert.equal(persisted, standardSkillText(WRITER_PROBE, WRITER_DESCRIPTION, WRITER_BODY), "skill roundtrip");
		await assert.rejects(writer.create({ cwd: writerCwd, name: WRITER_PROBE, description: "Other.", body: "Other body." }), /exist/i);
		await writer.update({ cwd: writerCwd, name: WRITER_PROBE, description: WRITER_DESCRIPTION_UPDATED, body: WRITER_BODY_UPDATED });
		assert.equal(
			await readFile(created.path, "utf8"),
			standardSkillText(WRITER_PROBE, WRITER_DESCRIPTION_UPDATED, WRITER_BODY_UPDATED),
			"update replaces frontmatter and body",
		);
		await writer.delete({ cwd: writerCwd, name: WRITER_PROBE });
		await assert.rejects(stat(skillDir(writerRoot, WRITER_PROBE)), "delete removes the skill");
	},
	async teardown() {
		if (writerRoot) await rm(writerRoot, { recursive: true, force: true });
	},
};

export const cases: BenchmarkCase[] = [
	skillGateNestedEval,
	skillGateRegistryHotRead,
	mentionGuardStopReduction,
	projectSkillWriterCycle,
];
