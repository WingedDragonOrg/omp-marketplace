import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFileSync } from "node:child_process";

/**
 * Git cannot ship hooks through a clone (core.hooksPath is local config, by design:
 * cloning must not arm arbitrary code execution). This repo-local omp extension arms
 * it on the first session opened in the checkout, so contributors using omp never have
 * to run the setup line. CI re-runs the same check as the real gate.
 */
const HOOKS_PATH = ".githooks";

export default function armGitHooks(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const git = (args: string[]): string =>
			execFileSync("git", args, {
				cwd: ctx.cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();

		try {
			const top = git(["rev-parse", "--show-toplevel"]);
			let current = "";
			try {
				current = git(["config", "--local", "--get", "core.hooksPath"]);
			} catch {
				current = "";
			}
			if (current === HOOKS_PATH) return;

			git(["config", "--local", "core.hooksPath", HOOKS_PATH]);
			ctx.ui.notify(`armed pre-commit catalog check (core.hooksPath=${HOOKS_PATH}) in ${top}`, "info");
		} catch {
			// not a git checkout, or git unavailable — nothing to arm
		}
	});
}
