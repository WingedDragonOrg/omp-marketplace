/**
 * Surgical edits to the rendered `<skills>` block of a system prompt.
 *
 * Two shapes ship in oh-my-pi 18.x:
 *   default template  ->  <skill name="foo">\n<description>\n</skill>
 *   custom template   ->  - foo: <description spanning one or more lines>
 *
 * Entry starts are only recognised for names the session actually discovered,
 * so a description line that happens to look like a list item is never
 * mistaken for the next entry.
 */

const OPEN_TAG = "<skills>";
const CLOSE_TAG = "</skills>";

/** Instruction lines that only make sense while at least one skill is listed. */
const PREAMBLE_PATTERNS = [
	/^Matching skill .* first\.$/,
	/^Skills are specialized knowledge\..*$/,
	/^If a skill applies, you MUST read .*$/,
];

export function stripSkillsFromPrompt(
	prompt: string,
	blocked: ReadonlySet<string>,
	known: ReadonlySet<string>,
): string {
	if (blocked.size === 0) return prompt;
	const open = prompt.indexOf(OPEN_TAG);
	if (open < 0) return prompt;
	const close = prompt.indexOf(CLOSE_TAG, open);
	if (close < 0) return prompt;

	const bodyStart = open + OPEN_TAG.length;
	const body = prompt.slice(bodyStart, close);
	const entries = body.includes("<skill name=")
		? splitTaggedEntries(body)
		: splitListEntries(body, known);

	const kept = entries.filter((entry) => !blocked.has(entry.name));
	if (kept.length === entries.length) return prompt;

	if (kept.length === 0) {
		const head = trimPreamble(prompt.slice(0, open));
		return head + prompt.slice(close + CLOSE_TAG.length).replace(/^\n+/, "\n");
	}

	const rebuilt = kept.map((entry) => entry.text).join("\n");
	return `${prompt.slice(0, bodyStart)}\n${rebuilt}\n${prompt.slice(close)}`;
}

interface SkillEntry {
	name: string;
	text: string;
}

function splitTaggedEntries(body: string): SkillEntry[] {
	const entries: SkillEntry[] = [];
	const pattern = /<skill name="([^"]+)">[\s\S]*?<\/skill>/g;
	for (const match of body.matchAll(pattern)) {
		entries.push({ name: match[1], text: match[0] });
	}
	return entries;
}

function splitListEntries(
	body: string,
	known: ReadonlySet<string>,
): SkillEntry[] {
	const entries: SkillEntry[] = [];
	let current: SkillEntry | undefined;
	for (const line of body.split("\n")) {
		const match = /^- ([A-Za-z0-9._@/-]+): /.exec(line);
		if (match && known.has(match[1])) {
			if (current) entries.push(current);
			current = { name: match[1], text: line };
			continue;
		}
		if (!current) continue;
		current.text += `\n${line}`;
	}
	if (current) entries.push(current);
	return entries.map((entry) => ({
		name: entry.name,
		text: entry.text.replace(/\n+$/, ""),
	}));
}

function trimPreamble(head: string): string {
	const lines = head.split("\n");
	while (lines.length > 0) {
		const last = lines[lines.length - 1];
		if (last.trim() === "") {
			lines.pop();
			continue;
		}
		if (PREAMBLE_PATTERNS.some((pattern) => pattern.test(last.trim()))) {
			lines.pop();
			continue;
		}
		break;
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Rewrites every system-role text of a provider wire payload in place.
 * Covers the OpenAI shape (`messages[0].role === "system"`) and the Anthropic
 * shape (top-level `system` string or content-block array).
 */
export function rewriteSystemText(
	payload: unknown,
	rewrite: (text: string) => string,
): boolean {
	if (!payload || typeof payload !== "object") return false;
	const request: Record<string, unknown> = payload as Record<string, unknown>;
	let changed = false;

	if (typeof request.system === "string") {
		const next = rewrite(request.system);
		if (next !== request.system) {
			request.system = next;
			changed = true;
		}
	} else if (Array.isArray(request.system)) {
		changed = rewriteBlocks(request.system, rewrite) || changed;
	}

	if (Array.isArray(request.messages)) {
		for (const message of request.messages) {
			if (!message || typeof message !== "object") continue;
			const entry: Record<string, unknown> = message as Record<
				string,
				unknown
			>;
			if (entry.role !== "system" && entry.role !== "developer") continue;
			if (typeof entry.content === "string") {
				const next = rewrite(entry.content);
				if (next !== entry.content) {
					entry.content = next;
					changed = true;
				}
			} else if (Array.isArray(entry.content)) {
				changed = rewriteBlocks(entry.content, rewrite) || changed;
			}
		}
	}

	return changed;
}

function rewriteBlocks(
	blocks: unknown[],
	rewrite: (text: string) => string,
): boolean {
	let changed = false;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const entry: Record<string, unknown> = block as Record<string, unknown>;
		if (typeof entry.text !== "string") continue;
		const next = rewrite(entry.text);
		if (next !== entry.text) {
			entry.text = next;
			changed = true;
		}
	}
	return changed;
}
