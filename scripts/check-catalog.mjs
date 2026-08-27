#!/usr/bin/env node
/**
 * Marketplace catalog consistency check.
 *
 * Reads the STAGED content (git index), not the working tree: the failure this
 * guards against is a `git mv` whose index still carries the pre-rename blobs
 * while the working tree looks correct.
 *
 * Usage:
 *   node scripts/check-catalog.mjs           # check the index (what pre-commit does)
 *   node scripts/check-catalog.mjs --worktree # check the working tree instead
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

const WORKTREE = process.argv.includes("--worktree");
const OMP_CATALOG = ".omp-plugin/marketplace.json";
const CLAUDE_CATALOG = ".claude-plugin/marketplace.json";
const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const EXT_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

const errors = [];
const fail = (msg) => errors.push(msg);

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const tracked = new Set(
	git(["ls-files", "--cached"])
		.split("\n")
		.filter(Boolean),
);

const has = (path) => (WORKTREE ? existsSync(path) : tracked.has(path));

const read = (path) => {
	if (WORKTREE) return readFileSync(path, "utf8");
	return git(["show", `:${path}`]);
};

const readJson = (path) => {
	try {
		return JSON.parse(read(path));
	} catch (err) {
		fail(`${path}: invalid JSON — ${err.message}`);
		return undefined;
	}
};

/** Directories directly under `root` that contain at least one tracked file. */
const childDirs = (root) => {
	const prefix = root ? `${root}/` : "";
	const names = new Set();
	const paths = WORKTREE
		? git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n")
		: [...tracked];
	for (const p of paths) {
		if (!p.startsWith(prefix)) continue;
		const rest = p.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash > 0) names.add(rest.slice(0, slash));
	}
	return names;
};

const checkName = (value, label) => {
	if (typeof value !== "string" || !NAME_RE.test(value) || value.length > 64) {
		fail(`${label}: "${value}" is not a valid id (lowercase a-z0-9, '-', '.', must start/end alphanumeric, <=64 chars)`);
		return false;
	}
	return true;
};

if (!has(OMP_CATALOG)) {
	fail(`${OMP_CATALOG} is missing from the commit`);
} else {
	const catalog = readJson(OMP_CATALOG);

	if (has(CLAUDE_CATALOG) && read(CLAUDE_CATALOG) !== read(OMP_CATALOG)) {
		fail(`${CLAUDE_CATALOG} differs from ${OMP_CATALOG}; the Claude Code mirror must be byte-identical`);
	}

	if (catalog) {
		checkName(catalog.name, "marketplace name");
		if (!catalog.owner?.name) fail("marketplace owner.name is required");
		if (!Array.isArray(catalog.plugins)) fail("marketplace plugins[] is required");

		const rawRoot = catalog.metadata?.pluginRoot ?? "";
		const pluginRoot = rawRoot.replace(/^\.\//, "").replace(/\/$/, "");
		const entries = Array.isArray(catalog.plugins) ? catalog.plugins : [];
		const seen = new Map();
		const claimedDirs = new Set();

		for (const entry of entries) {
			const label = `plugin "${entry?.name ?? "<unnamed>"}"`;
			if (!checkName(entry?.name, `${label} name`)) continue;
			if (seen.has(entry.name)) fail(`${label}: duplicate entry`);
			seen.set(entry.name, entry);

			const source = entry.source;
			if (typeof source !== "string") {
				if (!source || typeof source !== "object" || !source.source) fail(`${label}: source is required`);
				continue; // remote sources (github/url/git-subdir) are not local trees
			}
			if (!source.startsWith("./")) {
				fail(`${label}: string source must start with "./" (got "${source}")`);
				continue;
			}

			const dirName = source.slice(2).replace(/\/$/, "");
			const dir = pluginRoot ? posix.join(pluginRoot, dirName) : dirName;
			claimedDirs.add(dirName.split("/")[0]);

			if (childDirs(pluginRoot).has(dirName.split("/")[0]) === false) {
				fail(`${label}: source "${source}" resolves to ${dir}/ which has no files in this commit`);
				continue;
			}
			if (dirName !== entry.name) {
				fail(`${label}: directory is ${dir}/ — rename it to ${posix.join(pluginRoot, entry.name)}/ or fix the catalog name`);
			}

			for (const manifest of [`${dir}/package.json`, `${dir}/.omp-plugin/plugin.json`, `${dir}/.claude-plugin/plugin.json`]) {
				if (!has(manifest)) continue;
				const data = readJson(manifest);
				if (!data) continue;
				if (data.name !== undefined && data.name !== entry.name) {
					fail(`${manifest}: name "${data.name}" != catalog name "${entry.name}"`);
				}
				if (entry.version !== undefined && data.version !== undefined && data.version !== entry.version) {
					fail(`${manifest}: version "${data.version}" != catalog version "${entry.version}"`);
				}
			}

			const pkgPath = `${dir}/package.json`;
			if (has(pkgPath)) {
				const pkg = readJson(pkgPath) ?? {};
				const extensions = pkg.omp?.extensions ?? pkg.pi?.extensions ?? [];
				for (const rel of extensions) {
					const target = posix.normalize(posix.join(dir, String(rel)));
					const ok = has(target) || EXT_CANDIDATES.some((c) => has(posix.join(target, c)));
					if (!ok) fail(`${pkgPath}: omp.extensions entry "${rel}" is not in this commit (${target})`);
				}
			}
		}

		for (const dir of childDirs(pluginRoot)) {
			if (!claimedDirs.has(dir)) {
				fail(`${posix.join(pluginRoot, dir)}/ has no catalog entry — add one to ${OMP_CATALOG} (and the Claude mirror) or drop the directory`);
			}
		}
	}
}

if (errors.length) {
	const scope = WORKTREE ? "working tree" : "staged commit";
	console.error(`✖ marketplace catalog check failed (${scope}):\n`);
	for (const e of errors) console.error(`  - ${e}`);
	console.error(`\nRe-check with: node ${join("scripts", "check-catalog.mjs")}${WORKTREE ? " --worktree" : ""}`);
	process.exit(1);
}

console.error("✔ marketplace catalog is consistent");
