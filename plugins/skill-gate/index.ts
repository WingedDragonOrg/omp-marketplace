import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { rewriteSystemText, stripSkillsFromPrompt } from "./src/prompt.ts";
import {
	type ActiveSkill,
	SkillGateRegistry,
	gateContext,
} from "./src/registry.ts";

/** Package export surface this plugin relies on; validated before use. */
interface SkillHost {
	getActiveSkills?: () => unknown;
}

const SKILL_URL = /^skill:\/\/([A-Za-z0-9._@-]+)/;

export default function skillGate(pi: ExtensionAPI) {
	const registry = new SkillGateRegistry();

	// `pi.pi` is the host package's export namespace; it has no static type here.
	const host = pi.pi as unknown as SkillHost;

	function activeSkills(): ActiveSkill[] {
		const raw = host.getActiveSkills?.();
		if (!Array.isArray(raw)) return [];
		const skills: ActiveSkill[] = [];
		for (const entry of raw) {
			if (!entry || typeof entry !== "object") continue;
			const candidate: Record<string, unknown> = entry as Record<
				string,
				unknown
			>;
			if (
				typeof candidate.name !== "string" ||
				typeof candidate.filePath !== "string"
			) {
				continue;
			}
			skills.push({
				name: candidate.name,
				description:
					typeof candidate.description === "string"
						? candidate.description
						: "",
				filePath: candidate.filePath,
				baseDir:
					typeof candidate.baseDir === "string" ? candidate.baseDir : "",
				source: typeof candidate.source === "string" ? candidate.source : "",
			});
		}
		return skills;
	}

	async function refresh(cwd: string): Promise<void> {
		const skills = activeSkills();
		if (skills.length === 0) {
			pi.logger?.debug?.("skill-gate: no active skills reported by host");
		}
		const decisions = await registry.evaluate(skills, gateContext(cwd));
		for (const decision of decisions) {
			for (const error of decision.errors) {
				pi.logger?.warn?.(`skill-gate: ${error}`);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx.cwd);
		const hidden = registry.blocked.size;
		if (hidden > 0) {
			ctx.ui.notify(
				`skill-gate: ${hidden} skill(s) hidden by activation conditions (/skill-gate for details)`,
				"info",
			);
		}
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (registry.evaluatedCwd !== ctx.cwd) await refresh(ctx.cwd);
		if (registry.blocked.size === 0) return;
		rewriteSystemText(event.payload, (text) =>
			stripSkillsFromPrompt(text, registry.blocked, registry.known),
		);
		return event.payload;
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "read") return;
		const path = event.input.path;
		if (typeof path !== "string") return;
		const match = SKILL_URL.exec(path.trim());
		if (!match || !registry.blocked.has(match[1])) return;
		return {
			block: true,
			reason: `skill "${match[1]}" is gated off in this environment: ${
				registry.reasonFor(match[1]) || "activation conditions not met"
			}`,
		};
	});

	pi.registerCommand("skill-gate", {
		description: "Show skill activation gates and why each one passed or failed",
		handler: async (args, ctx) => {
			if (args.trim() === "refresh") await refresh(ctx.cwd);
			const gated = registry.decisions.filter((decision) => decision.gated);
			const header = `skill-gate (cwd ${ctx.cwd}, ${registry.decisions.length} skills scanned)`;
			const lines =
				gated.length === 0
					? ["no skill declares a `when:` block"]
					: gated.map((decision) => {
							const status = decision.allowed ? "on " : "off";
							const why = decision.allowed
								? "conditions met"
								: decision.reasons.join("; ");
							return `${status}  ${decision.skill.name} — ${why}`;
						});
			const report = [header, ...lines].join("\n");
			// Print mode has no UI context; notify would silently drop the report.
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.log(report);
		},
	});
}
