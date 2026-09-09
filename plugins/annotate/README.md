# Annotate

Annotate is an Oh My Pi (`omp`) extension for reviewing agent output and sending precise feedback back to the current session agent. Its command is `/annotate`; OMP's built-in `/git` and `/review` remain available.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install annotate@winged-dragon-org
```

Start a new `omp` session after installation because extension modules load when the session starts.

- **Code** — browse changes in a full-height `/git`-style evidence pane; the right dock lists files or recent commits, keeps the draft target visible, and shows the review queue.
- **Assistant** — read the selected assistant message in a full-height evidence pane; the right dock lists messages, keeps the draft target visible, and shows the review queue.

Controls:
```text
Tab / Shift+Tab     switch focus between the evidence pane and dock
1 / 2               switch Code / Assistant
↑ / ↓, j / k        move in the focused pane or source/queue list
Enter               open the selected file/commit/message
a                   create a new annotation for the selected line/range or whole message
p                   choose precise code text in Code, or assistant text from its dock
e                   edit the hovered code annotation or focused pending queue item
[/]                 previous/next Code file while viewing the diff
h                   choose a recent commit while browsing Code
w                   return to current working-tree changes while browsing Code
Space               focus the review queue from the dock
Ctrl+Space          cycle evidence → sources → draft → queue (when active)
Shift+↑ / Shift+↓   extend a Code selection in split / inline views
v                   cycle split / inline / hunk diff views
d                   delete the focused pending annotation
s                   validate and send all valid pending annotations
r                   refresh Git and session sources
Esc / q             close the workbench (Esc returns to the dock from the editor)
```
The dock follows the review flow: choose evidence in **Sources**, write in **Draft**, then check **Queue** before sending. The focused dock section is marked with `▸`; its heading keeps the current source or queue summary visible (`pending / stale / sent`) whenever the dock has room.

A new annotation is saved as `pending` in the current session branch. Every activation creates a separate annotation, including when its code location matches an existing annotation. Code `a` can cover full diff lines; Code `p` selects grapheme text within the current hunk and can cross lines. Sending combines all valid pending annotations into one user message for the current session agent. The message contains the exact reference, location metadata, and user comment, and asks the agent to re-check the reference before editing.

## Safe stale handling

Every Code annotation records the repository identity, the current `HEAD` or selected commit, the diff fingerprint, file, line range, selected text, and—when `p` is used—the character offsets within that anchored line span. Every Assistant annotation records the session, entry ID, selected range (the whole message by default or a precise character range), and its context. If the repository, selected revision, file, branch, or assistant message changes before sending, the annotation becomes `stale` and is not sent. Re-select the current content to create a replacement annotation.

Failed sends keep annotations as `pending`. Sent annotations remain in the session as review history. Annotation state follows the current session branch and is not written to project files or remote services.

A send is marked `sent` only after the matching user `message_start` is observed. If delivery ends before that acknowledgement, the item stays pending; an idle retry checks the current session branch for the original message before sending again.

When OMP secret obfuscation leaves placeholders in restored history, Annotate does not expose those placeholders as selectable text. Live assistant `message_end` display text is retained for the current process, but secret-protected entries remain browse-only because custom session entries must not persist recovered secret text.

The plugin does not commit, push, start a separate review agent, or modify OMP core.
