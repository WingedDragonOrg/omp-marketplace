# Annotate

Annotate is an Oh My Pi (`omp`) extension for reviewing agent output and sending precise feedback back to the current session agent. Its command is `/annotate`; OMP's built-in `/git` and `/review` remain available.

## Install

```sh
omp plugin marketplace add WingedDragonOrg/omp-marketplace
omp plugin install annotate@winged-dragon-org
```

Start a new `omp` session after installation because extension modules load when the session starts.

- **Code** — read the working tree or a recent commit in a full-height `/git`-style evidence pane. A margin rail beside the diff marks every line you have already annotated.
- **Assistant** — read one assistant message in the same pane and annotate the whole message or an exact phrase.

The dock beside the evidence follows the review flow: pick evidence in **Sources**, write in **Draft**, check **Queue** before sending. `▸` marks the focused section, `·` keeps a parked selection visible, and each heading counts what it holds.

Press `?` inside the workbench for the keymap, which is generated from the same table that dispatches the keys:
```text
tab / shift+tab     move through sources, evidence, draft, queue
1 / 2               code changes / assistant output
↑ ↓ (j k)           move in the focused pane, or between hunks in hunk view
enter               open the selected source, jump to a queued annotation, or annotate from the evidence pane
a                   annotate the current selection
p                   pick exact text inside the current hunk or message
e                   edit the hovered or selected pending annotation
i                   read every annotation on the current line in a card
x                   discard the draft
d                   delete the selected annotation (queue)
s                   send every valid pending annotation
H                   list the working tree and recent commits together
[ ]                 previous / next changed file
v                   split / inline / hunk view
w                   wrap long lines
f                   give the evidence pane the whole frame
r                   refresh Git and session sources
shift+↑ / shift+↓   extend a Code selection in split and inline views
q / esc             close the workbench (esc leaves the draft editor first)
```

Writing a draft is safe to interrupt: `esc` leaves the editor and keeps what you typed, pointing it at another line keeps the words and re-aims them, and `x` (or the `✕` in the draft heading) throws the draft away. `H` lists the working tree next to recent commits; `enter` opens whichever row you choose.

The header reports what happened while the workbench is open — what a send delivered, what it skipped as stale, why nothing was sent. Confirmations fade after a few seconds; failures stay until the next action. The toolbar's Send button carries the exact count it would deliver, with the number of stale annotations it would skip.

A new annotation is saved as `pending` in the current session branch. Every activation creates a separate annotation, including when its code location matches an existing annotation. Code `a` can cover full diff lines; Code `p` selects grapheme text within the current hunk and can cross lines. Sending combines all valid pending annotations into one user message for the current session agent. The message contains the exact reference, location metadata, and user comment, and asks the agent to re-check the reference before editing.

Clicking a rail mark, pressing `i`, or double-clicking a line that already carries a mark opens the annotation card: it shows every annotation on that line and offers the next moves inline — `a` to annotate the same line again, `e` to edit the selected one, `d` to delete it, `esc` to close. A marked line takes as many annotations as you write, so `a` from the card is the way to add a second note to content you already flagged. `↑ ↓` move between the card's annotations and the wheel scrolls a long one.

Mouse works throughout: the toolbar switches tabs, revision, view, Send and Refresh; a source row opens its source and a queue row jumps to that annotation and opens its card; a single click on a diff line selects it and dragging extends the selection; double-clicking a bare changed line drafts an annotation for it; hovering a rail mark highlights it and shows that annotation in the header.

## Safe stale handling

Every Code annotation records the repository identity, the current `HEAD` or selected commit, the diff fingerprint, file, line range, selected text, and—when `p` is used—the character offsets within that anchored line span. Every Assistant annotation records the session, entry ID, selected range (the whole message by default or a precise character range), and its context. If the repository, selected revision, file, branch, or assistant message changes before sending, the annotation becomes `stale` and is not sent. Re-select the current content to create a replacement annotation.

Failed sends keep annotations as `pending`. Sent annotations remain in the session as review history. Annotation state follows the current session branch and is not written to project files or remote services.

A send is marked `sent` only after the matching user `message_start` is observed. If delivery ends before that acknowledgement, the item stays pending; an idle retry checks the current session branch for the original message before sending again.

When OMP secret obfuscation leaves placeholders in restored history, Annotate does not expose those placeholders as selectable text. Live assistant `message_end` display text is retained for the current process, but secret-protected entries remain browse-only because custom session entries must not persist recovered secret text.

The plugin does not commit, push, start a separate review agent, or modify OMP core.
