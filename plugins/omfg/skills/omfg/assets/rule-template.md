---
description: "<one line, imperative, states the invariant — shown in listings, not injected>"
condition:
  - "<pattern for the class of failure; never the sentence from the transcript>"
# astCondition:            # structural alternative for code constructs (edit/write only)
#   - "if ($X) clearTimeout($X)"
scope: "text"              # or "tool:edit(*.ts), tool:write(*.ts)" — one entry per tool × extension
interruptMode: never       # never | prose-only | tool-only | always (default)
---

<Invariant restated in one line, plus the consequence of breaking it. Consequence
beats prohibition: the model is deciding what to do next, not being sentenced.>

## Avoid

```<lang>
<the class of failure, minimal — not the incident>
```

## Use

```<lang>
<the corrected form>
```

## When this is actually fine

<The escape hatch. Name the legitimate case and what to do with it — quote it in
backticks, keep the guard because it does extra work, etc. Without this the model
contorts around a false positive instead of recognizing one.>
