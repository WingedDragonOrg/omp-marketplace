# Annotate

Annotate is an Oh My Pi (`omp`) extension for reviewing agent output and sending precise feedback back to the current session agent. Its command is `/annotate`; OMP's built-in `/git` and `/review` remain available.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install annotate@winged-dragon-org
```

Start a new `omp` session after installation because extension modules load when the session starts.

## Review workflow

Run `/annotate` in the interactive TUI. The full-screen workbench has two tabs:

- **Code** — browse the staged and unstaged Git diff relative to `HEAD` and annotate a selected diff line.
- **Assistant** — browse visible assistant messages in the current session branch. Select a message and enter a comment for that message.

Controls:

```text
Tab                 switch Code / Assistant
Up / Down           select a source row or annotation
Enter / a           annotate the selected source row
Space               move focus between source and annotation lists
d                   delete the focused pending annotation
s                   validate and send all valid pending annotations
r                   refresh Git and session sources
Esc / q             close the workbench
```

A new annotation is saved as `pending` in the current session branch. Sending combines all valid pending annotations into one user message for the current session agent. The message contains the exact reference, location metadata, and user comment, and asks the agent to re-check the reference before editing.

## Safe stale handling

Every Code annotation records the repository identity, `HEAD`, diff fingerprint, file, line range, and selected text. Every Assistant annotation records the session, entry ID, complete message text, and its context. If the repository, diff, file, branch, or assistant message changes before sending, the annotation becomes `stale` and is not sent. Re-select the current content to create a replacement annotation.

Failed sends keep annotations as `pending`. Sent annotations remain in the session as review history. Annotation state follows the current session branch and is not written to project files or remote services.

A send is marked `sent` only after the matching user `message_start` is observed. If delivery ends before that acknowledgement, the item stays pending; an idle retry checks the current session branch for the original message before sending again.

When OMP secret obfuscation leaves placeholders in restored history, Annotate does not expose those placeholders as selectable text. Live assistant `message_end` display text is retained for the current process, but secret-protected entries remain browse-only because custom session entries must not persist recovered secret text.

The plugin does not commit, push, start a separate review agent, or modify OMP core.
