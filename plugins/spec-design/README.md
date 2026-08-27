# spec-design

Skill-only plugin. `spec-design` turns a feature idea, behaviour change or existing
plan into an implementable spec through a focused design interview, then writes it to
`docs/specs/YYYY-MM-DD-<topic>-design.md`.

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install spec-design@winged-dragon-org
```

Skills refresh with `/reload-plugins`; no new session required.

## What it enforces

- **Hard gate** — no implementation code, scaffolding or plan execution until the user
  confirms the design. Codebase exploration, option comparison and writing the spec are
  not implementation.
- **Facts vs decisions** — anything answerable from the repo is investigated, never asked.
  Only product-level commitments (user promises, data semantics, permissions, irreversible
  migrations, cost) interrupt the user; derived architecture is decided and disclosed.
- **Stances before leaves** — one upstream question that constrains a whole group of
  downstream choices, each with 2–3 options and a recommendation, instead of a
  field-by-field questionnaire.
- **Derivation packages** — confirmed stance, derived design, adopted defaults, exclusions
  and the few assumptions worth correcting, shown as one block for a single confirmation.
- **Risk-tiered review** — every spec gets a deterministic self-check; specs touching
  concurrency, persistence/migration, auth/tenancy/billing, external contracts or
  irreversible operations additionally get exactly one independent read-only review round.

## Layout

```
skills/spec-design/SKILL.md          the skill
skills/spec-design/evals/evals.json  skill-creator eval suite (5 scenarios)
```

The evals are authoring material for `skill-creator`; omp ignores everything in a skill
directory except `SKILL.md`.
