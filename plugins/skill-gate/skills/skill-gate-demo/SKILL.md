---
name: skill-gate-demo
description: Placeholder skill that proves skill-gate works. It is only advertised to the model when SKILL_GATE_DEMO is set in the environment.
when:
  env:
    SKILL_GATE_DEMO: true
---

# skill-gate demo

If you can read this through `skill://skill-gate-demo`, the `when:` block in
this file evaluated to true: `SKILL_GATE_DEMO` is set and non-empty.

Without that variable the skill is still discovered by oh-my-pi, but
`skill-gate` removes it from the `<skills>` block of the system prompt and
blocks `read skill://skill-gate-demo`.
