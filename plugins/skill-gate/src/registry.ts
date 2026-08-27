import {
	type GateBlock,
	type GateContext,
	GATE_FIELDS,
	evaluateGate,
	parseGate,
} from "./gate.ts";

export interface ActiveSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source?: string;
}

export interface SkillDecision {
	skill: ActiveSkill;
	gated: boolean;
	allowed: boolean;
	reasons: string[];
	errors: string[];
}

interface CachedGate {
	mtimeMs: number;
	block?: GateBlock;
	errors: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Reads gates straight off disk. `getActiveSkills()` hands back the exact
 * `filePath` the session resolved, so precedence/dedup is already settled and
 * this never has to re-implement discovery.
 */
export class SkillGateRegistry {
	readonly #cache = new Map<string, CachedGate>();
	#decisions: SkillDecision[] = [];
	#blocked = new Set<string>();
	#known = new Set<string>();
	#evaluatedCwd = "";

	get blocked(): ReadonlySet<string> {
		return this.#blocked;
	}

	get known(): ReadonlySet<string> {
		return this.#known;
	}

	get decisions(): readonly SkillDecision[] {
		return this.#decisions;
	}

	get evaluatedCwd(): string {
		return this.#evaluatedCwd;
	}

	async evaluate(
		skills: readonly ActiveSkill[],
		ctx: GateContext,
	): Promise<readonly SkillDecision[]> {
		const decisions: SkillDecision[] = [];
		const blocked = new Set<string>();
		const known = new Set<string>();

		for (const skill of skills) {
			known.add(skill.name);
			const gate = await this.#gateFor(skill.filePath);
			if (!gate?.block) {
				decisions.push({
					skill,
					gated: false,
					allowed: true,
					reasons: [],
					errors: gate?.errors ?? [],
				});
				continue;
			}
			const result = await evaluateGate(gate.block, ctx);
			if (!result.ok) blocked.add(skill.name);
			decisions.push({
				skill,
				gated: true,
				allowed: result.ok,
				reasons: result.failures,
				errors: gate.errors,
			});
		}

		this.#decisions = decisions;
		this.#blocked = blocked;
		this.#known = known;
		this.#evaluatedCwd = ctx.cwd;
		return decisions;
	}

	reasonFor(name: string): string {
		const decision = this.#decisions.find(
			(candidate) => candidate.skill.name === name,
		);
		if (!decision || decision.allowed) return "";
		return decision.reasons.join("; ");
	}

	async #gateFor(filePath: string): Promise<CachedGate | undefined> {
		let mtimeMs = 0;
		try {
			mtimeMs = (await Bun.file(filePath).stat()).mtimeMs;
		} catch {
			return undefined;
		}
		const cached = this.#cache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached;

		let text = "";
		try {
			text = await Bun.file(filePath).text();
		} catch {
			return undefined;
		}
		const parsed = parseFrontmatterGate(text, filePath);
		const entry: CachedGate = { mtimeMs, ...parsed };
		this.#cache.set(filePath, entry);
		return entry;
	}
}

export function parseFrontmatterGate(
	source: string,
	filePath: string,
): { block?: GateBlock; errors: string[] } {
	const match = FRONTMATTER.exec(source);
	if (!match) return { errors: [] };

	let frontmatter: unknown;
	try {
		frontmatter = Bun.YAML.parse(match[1]);
	} catch (error) {
		return {
			errors: [`${filePath}: frontmatter is not valid YAML (${String(error)})`],
		};
	}
	if (!frontmatter || typeof frontmatter !== "object") return { errors: [] };

	const fields: Record<string, unknown> = frontmatter as Record<
		string,
		unknown
	>;
	for (const field of GATE_FIELDS) {
		if (!(field in fields)) continue;
		const parsed = parseGate(fields[field], field);
		return {
			block: parsed.block,
			errors: parsed.errors.map((error) => `${filePath}: ${error}`),
		};
	}
	return { errors: [] };
}

export function gateContext(cwd: string): GateContext {
	return {
		platform: process.platform,
		arch: process.arch,
		cwd,
		home: process.env.HOME ?? process.env.USERPROFILE ?? "",
		env: process.env,
	};
}
