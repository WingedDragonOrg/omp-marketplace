/**
 * Declarative activation gate for SKILL.md frontmatter.
 *
 * Field vocabulary is borrowed from established manifests instead of invented:
 *   os/arch      -> npm package.json `os` / `cpu` (including `!negation`)
 *   env/cwd/...  -> Ansible-style `when:` conditions, all-of by default
 *   any/all/not  -> JSON-Schema style boolean combinators
 *
 * Deliberately NOT supported: arbitrary shell/JS evaluation. A skill file is
 * data pulled from a marketplace; running it at session start would turn
 * `plugin install` into code execution.
 */

export type EnvRequirement = string | boolean;

export interface GateBlock {
	os?: string[];
	arch?: string[];
	env?: Record<string, EnvRequirement>;
	cwd?: string[];
	files?: string[];
	command?: string[];
	any?: GateBlock[];
	all?: GateBlock[];
	not?: GateBlock;
}

export interface GateContext {
	platform: string;
	arch: string;
	cwd: string;
	home: string;
	env: Record<string, string | undefined>;
}

export interface GateResult {
	ok: boolean;
	/** Human-readable reasons the gate failed; empty when `ok`. */
	failures: string[];
}

const GATE_KEYS: Record<string, true> = {
	os: true,
	arch: true,
	env: true,
	cwd: true,
	files: true,
	command: true,
	any: true,
	all: true,
	not: true,
};

const STRING_LIST_KEYS = ["os", "arch", "cwd", "files", "command"] as const;

/** Frontmatter keys that may carry a gate, in precedence order. */
export const GATE_FIELDS = ["when", "requires"] as const;

export interface ParsedGate {
	block?: GateBlock;
	errors: string[];
}

export function parseGate(value: unknown, path = "when"): ParsedGate {
	const errors: string[] = [];
	const block = parseBlock(value, path, errors);
	return { block, errors };
}

function parseBlock(
	value: unknown,
	path: string,
	errors: string[],
): GateBlock | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${path}: expected a mapping, got ${typeName(value)}`);
		return undefined;
	}

	const source: Record<string, unknown> = { ...value };
	const block: GateBlock = {};

	for (const key of Object.keys(source)) {
		if (GATE_KEYS[key] !== true) {
			errors.push(`${path}.${key}: unknown condition`);
		}
	}

	for (const key of STRING_LIST_KEYS) {
		if (!(key in source)) continue;
		const list = toStringList(source[key]);
		if (list === undefined) {
			errors.push(
				`${path}.${key}: expected a string or list of strings, got ${typeName(source[key])}`,
			);
			continue;
		}
		if (list.length > 0) block[key] = list;
	}

	if ("env" in source) {
		const env = parseEnv(source.env, `${path}.env`, errors);
		if (env && Object.keys(env).length > 0) block.env = env;
	}

	for (const key of ["any", "all"] as const) {
		if (!(key in source)) continue;
		const raw = source[key];
		if (!Array.isArray(raw)) {
			errors.push(`${path}.${key}: expected a list of condition blocks`);
			continue;
		}
		const children: GateBlock[] = [];
		for (const [index, entry] of raw.entries()) {
			const child = parseBlock(entry, `${path}.${key}[${index}]`, errors);
			if (child) children.push(child);
		}
		if (children.length > 0) block[key] = children;
	}

	if ("not" in source) {
		const child = parseBlock(source.not, `${path}.not`, errors);
		if (child) block.not = child;
	}

	return Object.keys(block).length > 0 ? block : undefined;
}

function parseEnv(
	value: unknown,
	path: string,
	errors: string[],
): Record<string, EnvRequirement> | undefined {
	if (Array.isArray(value)) {
		// `env: [FOO, BAR]` -> both must be set. Common shorthand, keep it working.
		const shorthand: Record<string, EnvRequirement> = {};
		for (const entry of value) {
			if (typeof entry !== "string") {
				errors.push(`${path}: list entries must be variable names`);
				continue;
			}
			shorthand[entry] = true;
		}
		return shorthand;
	}
	if (typeof value !== "object" || value === null) {
		errors.push(`${path}: expected a mapping of NAME -> value`);
		return undefined;
	}
	const requirements: Record<string, EnvRequirement> = {};
	for (const [name, requirement] of Object.entries(value)) {
		if (typeof requirement === "string" || typeof requirement === "boolean") {
			requirements[name] = requirement;
			continue;
		}
		if (typeof requirement === "number") {
			requirements[name] = String(requirement);
			continue;
		}
		errors.push(
			`${path}.${name}: expected string, boolean or number, got ${typeName(requirement)}`,
		);
	}
	return requirements;
}

function toStringList(value: unknown): string[] | undefined {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return undefined;
	const list: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return undefined;
		if (entry.trim()) list.push(entry.trim());
	}
	return list;
}

function typeName(value: unknown): string {
	if (value === null) return "null";
	return Array.isArray(value) ? "list" : typeof value;
}

export async function evaluateGate(
	block: GateBlock,
	ctx: GateContext,
): Promise<GateResult> {
	const failures: string[] = [];

	if (block.os && !matchesNpmList(block.os, ctx.platform)) {
		failures.push(`os ${ctx.platform} not in [${block.os.join(", ")}]`);
	}
	if (block.arch && !matchesNpmList(block.arch, ctx.arch)) {
		failures.push(`arch ${ctx.arch} not in [${block.arch.join(", ")}]`);
	}
	if (block.env) {
		for (const [name, requirement] of Object.entries(block.env)) {
			const failure = checkEnv(name, requirement, ctx.env[name]);
			if (failure) failures.push(failure);
		}
	}
	if (block.cwd && !matchesGlobList(block.cwd, ctx.cwd, ctx.home)) {
		failures.push(`cwd ${ctx.cwd} does not match [${block.cwd.join(", ")}]`);
	}
	if (block.command) {
		for (const name of block.command) {
			if (!Bun.which(name)) failures.push(`command not on PATH: ${name}`);
		}
	}
	if (block.files) {
		for (const pattern of block.files) {
			if (!(await hasMatchingFile(pattern, ctx.cwd))) {
				failures.push(`no file matches ${pattern}`);
			}
		}
	}

	if (block.all) {
		for (const child of block.all) {
			const result = await evaluateGate(child, ctx);
			if (!result.ok) failures.push(...result.failures);
		}
	}

	if (block.any && block.any.length > 0) {
		const results = await Promise.all(
			block.any.map((child) => evaluateGate(child, ctx)),
		);
		if (!results.some((result) => result.ok)) {
			const detail = results
				.flatMap((result) => result.failures)
				.join("; ");
			failures.push(`none of the \`any\` branches matched (${detail})`);
		}
	}

	if (block.not) {
		const result = await evaluateGate(block.not, ctx);
		if (result.ok) failures.push("`not` condition matched");
	}

	return { ok: failures.length === 0, failures };
}

/** npm `os`/`cpu` semantics: `!x` blocks, plain entries form an allowlist. */
function matchesNpmList(patterns: string[], actual: string): boolean {
	const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
	const blocked = patterns.some(
		(pattern) => pattern.startsWith("!") && pattern.slice(1) === actual,
	);
	if (blocked) return false;
	if (positive.length === 0) return true;
	return positive.some((pattern) => pattern === "*" || pattern === actual);
}

function checkEnv(
	name: string,
	requirement: EnvRequirement,
	actual: string | undefined,
): string | undefined {
	const present = actual !== undefined && actual !== "";
	if (requirement === true) {
		return present ? undefined : `env ${name} is unset`;
	}
	if (requirement === false) {
		return present ? `env ${name} is set` : undefined;
	}
	const regex = asRegex(requirement);
	if (regex) {
		if (!present || !regex.test(actual)) {
			return `env ${name}=${actual ?? "<unset>"} does not match ${requirement}`;
		}
		return undefined;
	}
	return actual === requirement
		? undefined
		: `env ${name}=${actual ?? "<unset>"} != ${requirement}`;
}

/** `/pattern/flags` is the conventional inline-regex spelling in YAML configs. */
function asRegex(value: string): RegExp | undefined {
	const match = /^\/(.*)\/([gimsuy]*)$/s.exec(value);
	if (!match) return undefined;
	try {
		return new RegExp(match[1], match[2]);
	} catch {
		return undefined;
	}
}

function matchesGlobList(
	patterns: string[],
	target: string,
	home: string,
): boolean {
	let sawPositive = false;
	let matched = false;
	for (const pattern of patterns) {
		const negated = pattern.startsWith("!");
		const expanded = expandHome(negated ? pattern.slice(1) : pattern, home);
		const hit =
			new Bun.Glob(expanded).match(target) ||
			new Bun.Glob(`${expanded.replace(/\/+$/, "")}/**`).match(target);
		if (negated) {
			if (hit) return false;
			continue;
		}
		sawPositive = true;
		if (hit) matched = true;
	}
	return sawPositive ? matched : true;
}

function expandHome(pattern: string, home: string): string {
	if (pattern === "~") return home;
	return pattern.startsWith("~/") ? `${home}/${pattern.slice(2)}` : pattern;
}

async function hasMatchingFile(pattern: string, cwd: string): Promise<boolean> {
	try {
		for await (const _match of new Bun.Glob(pattern).scan({
			cwd,
			onlyFiles: true,
			followSymlinks: false,
		})) {
			return true;
		}
	} catch {
		return false;
	}
	return false;
}
