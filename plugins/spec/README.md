# spec

Skill-only plugin for turning a feature idea, behaviour change or existing plan
into an implementable spec. Confirmed specs live in `docs/specs/`.

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install spec@winged-dragon-org
```

Skills refresh with `/reload-plugins`; no new session required.

## `spec-design`

- **Routing** — implement clear, authorized work within an existing spec without
  restarting design. Confirm changes to a settled commitment, scope, contract
  or acceptance standard; wait for approval before implementing new design.
- **Facts vs decisions** — investigate repo facts, decide derived details, and
  ask one high-impact product question at a time with a recommendation.
- **Spec location** — update the current spec in place; when revising a
  historical-only spec, retain the read-only original and write the active
  version to `docs/specs/`.
- **Derivation packages** — confirmed stance, derived design, adopted defaults, exclusions
  and the few assumptions worth correcting, shown as one block for a single confirmation.
- **Risk-tiered review** — always self-check; add one independent read-only
  review if requested or if load-bearing assumptions need adversarial review.

## Layout

```
skills/spec-design/SKILL.md          the skill
skills/spec-design/evals/evals.json  skill-creator eval suite
```

Plugin name and skill name are independent: the plugin is the delivery unit (`spec`), the
skill is what the model sees (`spec-design`). Further spec-stage skills go in
`skills/<name>/` here without another catalog entry.

The evals are authoring material for `skill-creator`; omp ignores everything in a skill
directory except `SKILL.md`.
