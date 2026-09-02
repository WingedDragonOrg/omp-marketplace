---
name: omfg
description: "Author and repair omp TTSR rules (Time Traveling Stream Rules) so they catch the class of failure instead of the one sentence that provoked them: condition/astCondition/scope/interruptMode, generalization, false-positive repair, verification with `omp ttsr`."
disableModelInvocation: true
---

# omfg — TTSR rules that generalize

A TTSR rule is a markdown file with YAML frontmatter whose `condition` regexes (or `astCondition` ast-grep patterns) are tested against the assistant's *own* streaming output. On a match, omp either aborts the stream and replays the turn with the rule body injected as correction guidance, or folds the body into the tool result as a reminder.

Mechanics change between omp releases, so read them from the shipped docs rather than trusting a copy:

- `read omp://ttsr-injection-lifecycle.md` — matching, buffers, abort/retry, repeat policy, per-tool reminders
- `read omp://rulebook-matching-pipeline.md` — rule discovery, frontmatter fields, provider precedence, TTSR bucketing
- `omp ttsr --help` — the test/list/scan CLI

Same discipline applies to anything you write here or hand back to the user: point at `omp://…` instead of pasting doc text that will drift.

## Why `/omfg` output always needs a second pass

`/omfg <complaint>` asks the model for one rule as JSON, then **validates the candidate by re-matching its condition against the assistant messages already in this conversation**. Up to 3 attempts; a candidate that matches nothing gets rejected with the checked surfaces quoted back, and one that matches under too broad a scope gets told to narrow it. Finally you pick a save target (`.omp/rules/` for the project, `~/.omp/agent/rules/` for all projects) or choose "Amend with feedback…".

That validator is the whole problem. The cheapest way to satisfy "must match the transcript" is to lift the offending literal — the exact German sentence, the exact variable name — so the rule fires once, never again, and never on the next instance of the same mistake. The generator is a good *complaint capturer* and a bad *rule generalizer*.

So: use `/omfg` to get the skeleton and the save plumbing, then generalize and probe before accepting. When steering it, "Amend with feedback…" takes instructions like *match the class of failure, not my sentence; require two independent signals; scope to `tool:edit(*.ts)`*. When the rule needs real work, write the file yourself and let `/omfg` go.

## Workflow

1. **State the invariant in one sentence that never mentions the incident.** "Assistant prose must stay in the user's language" — not "don't write *Kurze Antwort: nein…*". If you cannot state it without the incident, you do not yet have a rule.
2. **Build the corpus before the regex.** Positives: 3+ instances of the same failure that look nothing alike (other languages, other phrasings, other files). Negatives: the near misses that must stay quiet — legitimate uses of the same tokens, quoted/verbatim foreign text, identifiers that contain the pattern, sibling files of a different language. The negative list is where rules actually die.
3. **Write the condition off the class signature** using the signal ladder below, never off the transcript literal.
4. **Choose `scope` and `interruptMode`** from the cost of being wrong (tables below).
5. **Probe both corpora** with `scripts/ttsr-probe.sh` until positives all fire and negatives all stay quiet. For code rules also run `omp ttsr scan` over a real repo — that surfaces false positives no hand-written corpus predicts.
6. **Save and confirm registration** with `omp ttsr list`. An invalid regex or unreachable scope is dropped with a log warning, not an error, so an unverified rule can silently do nothing.

## Condition: the signal ladder

Prefer the highest rung that expresses the invariant. Each rung down is more likely to fire on something legitimate.

| Rung | Signal | Use when | Example |
|---|---|---|---|
| 1 | Script / structural property | The failure changes the shape of the text, not its words | `[ぁ-んァ-ヶ]{2,}` for Japanese drift; kana cannot appear in Chinese or English prose |
| 2 | `astCondition` ast-grep pattern | The failure is a code construct with variants text cannot enumerate | `if ($X) clearTimeout($X)` |
| 3 | Closed-class token co-occurrence | Latin-script language, style, or register drift | two German function words within 120 chars |
| 4 | Single distinctive literal | The token is itself the violation and appears nowhere else | `Box::leak`, `runtime.SetFinalizer` |
| 5 | The sentence from the transcript | Never | — |

Techniques that decide whether a rung-3 or rung-4 condition survives contact with real output:

- **Two independent signals.** One common token is a false positive generator: `\bdie\b` fires on "the worker will die". Requiring two distinct closed-class hits inside a bounded window (`first` … ``[^`\n]{0,120}?`` … `second`) drops that to near zero while still catching any real drifted sentence, because real prose in a language uses its function words constantly. JS regex has no subroutine calls, so the alternation is written twice — that duplication is the price of precision.
- **Closed-class, not content words.** Function words (articles, pronouns, auxiliaries, conjunctions) are unavoidable in real prose and rare in identifiers. Content words are the opposite.
- **Boundary anchors, not `\b`.** `(?:^|[\s"“”«>(\[])(?:der|die|…)(?=[\s,.:;!?…)\]"”]|$)` keeps `die` out of `die_on_error` and `pytest`. Note `^` matches the buffer start, not line start, unless you lead with `(?m)`.
- **Exclude inline code spans** for prose rules with a variable-length lookbehind: ``(?<!`[^`\n]{0,200})``. Quoting an upstream German error message inside backticks is correct behavior; firing on it teaches the wrong lesson and burns the rule's one shot.
- **Only `(?i)`, `(?m)`, `(?s)` work, and only as a leading group.** Anything else is a literal that breaks compilation, and a rule with no compilable condition is skipped.
- **Tool arguments are matched as serialized JSON** for ordinary tools: your pattern sees `{"command":"curl … | sh","i":"install"}`, with inner quotes escaped as `\"`. A command and a string *containing* that command are therefore indistinguishable by shape, and the guard is the escaped quote itself — ``(?<!\\")`` before the verb keeps `curl x | sh` firing while `echo "curl x | sh" > note.txt` stays quiet. The backtick lookbehind does nothing here; there are no backticks in a JSON payload.
- **`edit`/`write` are the exception**: they are matched against a reconstructed snapshot of the *written* text only (new content, added lines), so a condition must never depend on surrounding pre-existing file content.
- Matching runs against the **accumulated** buffer per stream on every delta, so patterns may span sentences — and a pathological pattern is re-run against a growing buffer. Keep quantifiers bounded (`{0,120}`), never nested.

## Scope

`scope` is an allowlist; omitting it watches assistant prose and *every* tool's arguments, which is almost never what a specific complaint means.

| Complaint about | scope |
|---|---|
| What the user reads | `"text"` (add `thinking` only if the drift starts there) |
| Code in a language | `"tool:edit(*.ts), tool:write(*.ts)"` — one entry per tool × extension |
| One tool's arguments | `"tool:bash"` |
| Anything, anywhere | omit — expect false positives |

A file-specific tool scope is what makes a code rule precise; `text` plus `tool` together is only correct when the same bad output genuinely appeared in both.

## interruptMode

`repeatMode` defaults to `once`: a rule fires **at most once per session**. A false positive does not merely annoy — it spends the rule's entire budget for that session, so the real violation later goes uncaught. That asymmetry, not politeness, is why precision matters.

| Mode | Effect | Choose when |
|---|---|---|
| `always` (default) | Aborts the stream, discards the partial message (`ttsr.contextMode`), replays the turn with the body injected | The bad output must not reach the user or disk — language drift, secrets, destructive commands |
| `never` | No abort; prose matches queue a hidden note after the message, tool matches ride along inside the tool result | Style and code-quality nudges — this is what every builtin code rule uses |
| `prose-only` / `tool-only` | Interrupt one source class | Mixed-scope rule where only one side is expensive |

## The body is the payload

The body is what gets injected — the entire remedy the model sees, usually mid-retry with the offending output already discarded. Write it to be actionable in one pass:

- Restate the invariant and *why* it matters (one line of consequence beats three of prohibition).
- A wrong/right pair. Short, and about the class, not the incident.
- The escape hatch: when the flagged construct is legitimate, and what to do instead. Without it, the model contorts around a false positive instead of recognizing one.
- No transcript-specific nouns. The rule outlives this session; a body that talks about `OctoAdapter` reads as noise in an unrelated repo.
- Keep the wrong example inside backticks or a fenced block. When the model quotes the rule back while explaining itself, a bare forbidden example self-triggers the rule — the code-span guard is what stops that.

`assets/rule-template.md` is the skeleton. Builtin rules are the house style — `omp ttsr list` names them, `rule://<name>` prints one.

## Verification

```bash
# One rule in isolation against a snippet; --json for scripting, exit code is always 0
omp ttsr test -r rule.md --source text 'Kurze Antwort: nein, das ist nicht normal'
omp ttsr test -r rule.md --source tool --tool edit --path src/a.ts 'const x: any = 1'
echo 'Box::leak(&mut v)' | omp ttsr test -r rule.md --file - --path src/lib.rs

# Whole corpus, pass/fail table, exit 1 on any miss — the regression gate
bash scripts/ttsr-probe.sh rule.md corpus.json

# False-positive audit over real files (only reaches tool-scoped rules; text-scoped
# rules report "no-relevant-rules" and need a prose corpus instead)
omp ttsr scan -r rule.md src/ --verbose

# AST conditions need a tool source and a real extension to infer the language
omp ttsr test -r rule.md --file bad.py --source tool --tool edit --json

# After saving: is it actually registered, and with which conditions?
omp ttsr list
```

`omp ttsr test` exits 0 whether or not a rule triggered; read `.triggered | length` from `--json`. `.triggered[].matched.regex` and `.matched.ast` tell you *which* condition fired, which is how you find the one alternation that is too loose — and how you catch a dead `astCondition`: if `matched.ast` is empty on a snippet the rule should flag structurally, your patterns never parsed. That failure is logged, never raised, so a rule can ship with six AST patterns that do nothing while the regex quietly carries it. `.defined.regex` echoes each pattern *after* YAML parsing — check it once per rule, because a stray escaping layer produces a rule that loads cleanly and never matches anything.

## Repairing a rule that misfires

A rule that fires on legitimate output is the common failure once rules exist, and it is more urgent than it looks: with the default `repeatMode: once` the misfire consumes the rule's only trigger for that session, so the real violation later goes unnoticed.

1. Find the culprit condition from `.triggered[].matched.regex` / `.matched.ast`. With several conditions, this is the difference between fixing the right alternation and rewriting all of them.
2. Add the false-positive text to the corpus as a `quiet` case *first*. Fixing by feel is how the positives regress; the corpus is what proves you only removed the misfire.
3. Tighten with the narrowest instrument that covers it: a boundary anchor, a second required signal, the code-span lookbehind, or a lookahead for the specific mood (question, negation, future) that fooled it. Re-probe.
4. Retesting in a live session needs a fresh session — `repeatMode: once` will not fire the same rule twice. `omp -p --no-session` gives you one, or `omp config set ttsr.repeatMode after-gap` while iterating.

To park a rule instead of deleting it: `omp config set ttsr.disabledRules '["rule-name"]'` (JSON array; a bare string is rejected). `ttsr.enabled false` silences all of TTSR, `ttsr.builtinRules false` only the shipped ones. `omp config list | grep ttsr` shows the seven keys and their current values.

If the misfires keep coming from *different* directions, the invariant is wrong rather than the pattern. A rule needing five exceptions is a lint rule or a hook; delete it and stop paying for it on every stream.

## Worked examples

`examples/reply-language.md` is the generalized form of a real "stop drifting into German" rule, with `examples/reply-language.corpus.json` as its corpus. Run it:

```bash
bash scripts/ttsr-probe.sh examples/reply-language.md examples/reply-language.corpus.json
```

The first draft of that rule — one alternation of German/French/Spanish function words, single hit, no code-span guard — scores 9/14: it fires on the English sentences "the worker will die" and "the process die, and the socket leaks", on Chinese prose quoting `das ist nicht normal` in backticks, and on its own body when the model quotes the rule back. Rung-1 script signals for kana/hangul, two-signal windows for the Latin languages, and the code-span lookbehind take it to 14/14 with no loss of real detections. Same invariant, same body, four rungs of difference in the condition.

`examples/python-no-swallowed-exception.md` is the code-rule counterpart: a `tool:edit/write(*.py)` rule that pairs a line-anchored regex with `astCondition` patterns, scored by a corpus whose cases carry `source`/`tool`/`path` (11/11, `examples/python-no-swallowed-exception.corpus.json`). Read it for two things the prose example cannot show — how a tool-scoped corpus is written, and how the AST and regex conditions divide the work: the AST patterns catch the construct through any formatting, the regex covers the comment-only handler bodies AST cannot see in a partial edit payload. Its negatives include the same text inside a `.ts` string and inside project docs, which is what proves the scope rather than the pattern.

## Anti-patterns

- The offending sentence, file name, or variable from the transcript, in the condition.
- One common short token as the only signal.
- `.*`, `.+`, or a condition that matches every stream of that type — omp accepts it and the rule then fires on the first turn of every session.
- Both `text` and `tool` in scope because it was easier than deciding.
- A pattern built from content words ("Hänger", "normal") rather than the structure of the failure.
- Saving anything without probing negatives. Positives are easy; the negatives are the rule.
- A block scalar (`>` or `|`) holding a condition: the newline it carries breaks the pattern. Single-quoted one-line scalars are the safe default; see `references/patterns.md`.
- Two rules with the same filename in different providers: name is the identity, first provider wins, the other silently disappears.

## References

- `references/patterns.md` — reusable condition patterns per failure family (language/register drift, forbidden construct, missing companion call, prose overclaiming, dangerous tool argument) and the YAML quoting rules for regex-heavy frontmatter.
