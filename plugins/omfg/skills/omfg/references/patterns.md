# Condition patterns by failure family

Reusable shapes for the five families that cover most `/omfg` complaints. Adapt the token lists; keep the structure.

Field semantics and provider precedence live in the shipped docs — `read omp://rulebook-matching-pipeline.md` — not here.

## YAML quoting for regex-heavy frontmatter

A regex in YAML survives exactly one round of escaping, and the safe default is a **single-quoted one-line scalar**: backslashes stay literal, only `'` needs doubling. Double quotes work too but force JSON escaping (`\` → `\\`, `"` → `\"`), which is where patterns quietly rot.

```yaml
# Preferred: single-quoted, one line per pattern
condition: 'runtime\.SetFinalizer'

condition:
  - '(?i)(?<!`[^`\n]{0,200})(?:^|[\s"“”«>(\[])(?:der|die|das)(?=[\s,.:;!?]|$)'
  - '[ぁ-んァ-ヶ]{2,}'
```

Never use a block scalar (`>` or `|`) for a condition. Folded and literal blocks carry newlines into the pattern, and the resulting regex either fails to compile or matches nothing — two independent authors hit exactly this and only found it by reading the pattern back.

So read it back, every time: `omp ttsr test -r rule.md --json` echoes `defined.regex`, the pattern *after* YAML parsing. A doubled backslash (`\\s` where you meant `\s`) turns the rule into one that matches literal backslashes and never fires, and nothing else reports it.

Frontmatter parsing is lenient by design: a YAML error falls back to line-by-line `key: value` parsing, so a malformed multi-line list can degrade into a rule with *no* conditions, which is then skipped entirely. `omp ttsr list` shows what actually loaded — including whether `astCondition` patterns came through.

## Family 1 — language or register drift (prose)

Invariant is about *how* the text reads, and the offending text is unbounded. Ladder rung 1 where the script differs, rung 3 where it does not.

```yaml
scope: "text, thinking"
condition:
  # rung 1: kana cannot occur in Chinese or English prose
  - '(?<!`[^`\n]{0,200})[ぁ-んァ-ヶ]{2,}'
  - '(?<!`[^`\n]{0,200})[가-힣]{2,}'
  # rung 3: two German function words within one window, outside code spans
  - '(?i)(?<!`[^`\n]{0,200})(?:^|[\s"“”«>(\[])(?:der|die|das|nicht|ist|und|ein|eine|noch|aber|schon|auch|sehr|ich|wir|habe|kein)(?=[\s,.:;!?…)\]"”]|$)[^`\n]{0,120}?[\s"“”«>(\[](?:der|die|das|nicht|ist|und|ein|eine|noch|aber|schon|auch|sehr|ich|wir|habe|kein)(?=[\s,.:;!?…)\]"”]|$)'
```

Transfers to: emoji in prose, marketing register, hedging ("I think maybe we could perhaps"), forbidden ALL-CAPS shouting, second-person scolding. The shape is always *closed-class inventory + boundary anchors + co-occurrence window + code-span guard*.

## Family 2 — forbidden construct in code

The token *is* the violation. Rung 4 is enough; the work goes into `scope`.

```yaml
scope: "tool:edit(*.rs), tool:write(*.rs)"
condition: 'Box::leak'
interruptMode: never
```

One `tool:<name>(<glob>)` entry per tool × extension; a brace glob covers a family: `tool:edit(*.{ts,tsx,mts,cts})`. Add `interruptMode: never` unless the construct must never be written at all — a reminder folded into the tool result costs one block, an abort costs the whole turn.

When the construct has variants regex cannot enumerate cleanly (guard forms, argument order, formatting), climb to rung 2:

```yaml
astCondition:
  - 'if ($X) clearTimeout($X)'
  - 'if ($X !== null) { clearTimeout($X) }'
```

`astCondition` only reaches `edit`/`write` streams where a file extension is available, and only sees the written text. Same metavariable twice means the same code twice, which is exactly how you express "guard tests the thing it clears". Enumerate the variants; there is no `$$$` shortcut for guard shapes.

Two things silently kill AST patterns, and neither raises an error — a pattern that fails to parse simply counts as no match:

**The pattern must be a standalone parseable node.** A bare `except:` clause is not one; the enclosing `try:` has to be there. A rule shipped with

```yaml
astCondition:
  - |
    except:
        pass
```

matches nothing, ever, while its sibling regex quietly does all the work. The same rule written as `"try:\n  $$$BODY\nexcept:\n  pass"` matches. Confirm which one you have with `omp ttsr test --source tool --file bad.py --json` and look at `.triggered[].matched.ast`: an empty array on a snippet that should match structurally means the patterns are dead.

**Indentation is part of the pattern** for layout-sensitive languages, so these are the inverse of regex conditions: a `|` block scalar or a double-quoted string with real `\n` escapes is correct here, while the one-line single-quoted form that keeps regexes safe produces an unparseable Python pattern. Prototype the pattern with `ast_grep` against a real file before pasting it into frontmatter — matching there and matching in TTSR are the same engine.

## Family 3 — missing companion call

"You added the timer but never cleared it." A stream rule cannot prove absence: it sees written text, not the finished file, and cannot know what the rest of the file already contains.

Match the *trigger* construct and let the body carry the obligation:

```yaml
description: "Every setInterval needs a matching clear on the teardown path"
scope: "tool:edit(*.ts), tool:write(*.ts)"
condition: 'setInterval\s*\('
interruptMode: never
```

The rule fires on every intentional `setInterval` too. That is acceptable *only* with `interruptMode: never` and a body that says "if the teardown already clears it, ignore this" — which is why the escape hatch in the body is load-bearing for this family. If the false-fire rate is intolerable, the check belongs in a lint rule or a hook, not in TTSR.

## Family 4 — prose overclaiming

"You said it was fixed without running anything." The signature is a claim verb near a completion word, in the user's language *and* English, since the model switches register freely.

```yaml
scope: "text"
condition:
  - '(?<![还尚][未没]|没有|未)(?:(?:已经?|都)(?:修复|修好|解决|搞定|处理好|验证过)|(?:问题|bug|报错|错误|冲突)(?:都|已经?)?(?:解决|修复|修好|搞定)了|应该(?:可以|没问题|没事|好了|正常|行了)了?)(?![^。！？\n]{0,8}[吗呢？?])'
  - '(?i)(?<!\bnot )(?<!\bnot been )(?<!\bnot yet )\b(?:should (?:now )?(?:work|pass|be (?:fixed|working|fine|ok))|is (?:now )?fixed|all tests (?:now )?pass)\b(?![^.!\n]{0,20}\?)'
interruptMode: always
```

Two conditions rather than one alternation across languages: each stays readable, and `.triggered[].matched.regex` then tells you which register the model slipped into. Keep claim rules `always` — an unverified "已修复" reaching the user is the entire harm.

This family lives or dies on *mood*, not vocabulary. The same words appear in questions ("已修复了吗？"), negations ("还没修复"), future plans ("下一步我会修好"), and third-party reports ("上游在 18.1.2 已修复"), none of which are the failure. Guard the claim with what surrounds it — question particles and marks, negation adverbs, modal futures — and put every one of those forms in the negative corpus before saving. A claim rule that fires on the user's own question is worse than none: it burns the single per-session trigger on a non-event.

## Family 5 — dangerous tool argument

"Stop piping installers into a shell." The target is neither prose nor a source file but one tool's arguments, so `scope` names the tool without a path glob — there is no file to match on.

```yaml
scope: "tool:bash"
condition: '(?i)(?<!\\")(?:curl|wget)\s[^\n]{0,200}?\|\s*(?:sudo\s+)?(?:ba|z|k|)sh\b'
interruptMode: always
```

The distinguishing mechanic: these arguments are matched as the **serialized JSON** of the call, so `{"command":"curl … | sh","i":"install"}` is the text your pattern sees. Two consequences. Quotes inside the command arrive escaped as `\"`, so a pattern written against the shell command as typed can miss. And the payload contains no structure you can trust — a command and a string *containing* a command look identical. The `(?<!\\")` lookbehind above is what separates `curl x | sh` from `echo "curl x | sh" > note.txt`; without it the rule fires on the harmless echo.

Because there is no path, a `globs` entry or a `tool:bash(*.sh)` scope would make the rule unreachable. Scope by tool name alone, and keep `interruptMode: always` — the point of this family is to abort before the call runs, which is the one thing a lint rule cannot do.

Transfers to: `git push --force` on a protected branch, `rm -rf` outside a build directory, `--no-verify`, secrets in a `write` payload, a `bash` call doing work a dedicated tool should do.

## Negative corpus checklist

Before saving, confirm each of these stays quiet — they are the recurring false-positive sources:

- identifiers and paths containing the pattern (`die_on_error`, `pytest`, `las_vegas.ts`)
- the pattern inside backticks, a fenced block, or a quoted upstream error
- the same construct in a sibling file of a different language (`*.test.ts` vs `*.ts`, `*.md` vs `*.rs`)
- legitimate prose in the *allowed* languages that shares tokens with the forbidden one
- for any rule about a claim, intent, or state: the interrogative, negated, future-tense, and third-party forms of the same sentence
- the rule's own body text — when the model quotes the rule back while explaining itself, a body that spells out the forbidden example self-triggers. Keep wrong examples inside backticks or a fenced block, which the code-span guard already excludes.
- for a tool-argument rule: the same command quoted inside another command, and the same text arriving through a different tool
