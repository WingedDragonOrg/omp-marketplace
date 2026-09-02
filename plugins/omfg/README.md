# omfg

Skill-only plugin for TTSR rule work. It ships one skill, `omfg`, which turns a complaint
about recurring assistant behaviour into a Time Traveling Stream Rule that catches the
whole class of failure — plus the corpus that proves it does, and does not fire on the
legitimate output next door.

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install omfg@winged-dragon-org
```

Skills refresh with `/reload-plugins`; no new session required.

## Invocation

The skill sets `disableModelInvocation: true`, so it stays out of the skills list the model
sees and is never pulled in on its own. Rule authoring is a deliberate act with a
session-wide blast radius — an installed rule interrupts every future stream in its scope —
so it is invoked on purpose:

```
/skill:omfg 这条规则老是误报          # interactive, arguments are appended as the task
read skill://omfg                     # load the method into the current turn
```

Drop the frontmatter line if you would rather have the model reach for it by itself.

## What the skill covers

- **Generalization** — the invariant is stated in one sentence that never mentions the
  incident, and the corpus (3+ dissimilar positives, plus the near misses that must stay
  quiet) is written before the first regex. Rules die on their negatives, not positives.
- **The signal ladder** — five rungs from script/character-class signals down to the
  sentence from the transcript, with the reason each rung down costs precision. The bottom
  rung exists to be recognized and refused.
- **`scope` and `interruptMode`** — `scope` is an allowlist; omitting it watches prose *and*
  every tool's arguments. `repeatMode` defaults to `once`, so a false positive spends the
  rule's entire session budget and the real violation later goes uncaught.
- **The body as payload** — the body is injected mid-retry with the offending output already
  discarded, so it is written to be actionable in one pass.
- **Verification** — `omp ttsr test` for one snippet, `scripts/ttsr-probe.sh` for the whole
  corpus as a pass/fail regression gate, `omp ttsr scan` for a false-positive audit over
  real files, `omp ttsr list` to confirm what actually registered. `astCondition` patterns
  that fail to parse are logged and skipped, so `.triggered[].matched.ast` is checked
  explicitly — otherwise a rule ships with dead AST patterns while the regex carries it.
- **Repair** — locating which alternation misfired via `matched.regex`, adding the false
  positive to the corpus before touching the pattern, and the `ttsr.disabledRules` /
  `ttsr.repeatMode` settings that make same-session re-testing possible.

## Layout

```
skills/omfg/SKILL.md                      the skill
skills/omfg/references/patterns.md        condition shapes for five failure families
skills/omfg/examples/reply-language.*     prose rule + 14-case corpus
skills/omfg/examples/python-no-*.*        code rule (regex + AST) + 11-case corpus
skills/omfg/scripts/ttsr-probe.sh         corpus runner, exit 1 on any miss
skills/omfg/assets/rule-template.md       rule skeleton
```

Both example corpora are green, and the probe script is the same one the skill tells the
model to run, so a change to either example is self-testing:

```sh
cd skills/omfg
bash scripts/ttsr-probe.sh examples/reply-language.md examples/reply-language.corpus.json
bash scripts/ttsr-probe.sh examples/python-no-swallowed-exception.md examples/python-no-swallowed-exception.corpus.json
```

## Relation to the built-in `/omfg`

The built-in `/omfg <complaint>` command generates one rule as JSON and validates it by
re-matching its condition against the current conversation. That check proves the candidate
fires on the incident, which is exactly the property a rule needs *least* — it is satisfied
by a condition containing the offending sentence verbatim. The skill's first section covers
why that output always needs a second pass, and what to do with it.
