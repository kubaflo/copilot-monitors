# Live Watches

Lets the agent watch things in the background and get woken up only when they
change. It is installed for your user, so it works in every local project.
Quiet polling uses no model calls; only setup, meaningful events, and optional
agent follow-ups may use tokens. The benefit grows with the number of idle
check-ins a watch replaces rather than following a fixed savings percentage.

## Use it

In the **Live Watches** canvas, paste one of these and it's watched right away,
without an agent turn:

- `https://github.com/owner/repo/pull/123` or `#123` (for this repo) —
  waits for PR checks
- `https://github.com/owner/repo/actions/runs/123` — waits for a GitHub
  Actions run
- `https://github.com/owner/repo/tree/main` — tracks new commits and CI
  checks on the latest commit, including checks already in progress; the
  branch name must be one URL segment
- `https://dev.azure.com/org/project/_build/results?buildId=123` (or
  `https://org.visualstudio.com/project/_build/results?buildId=123`) —
  waits for an Azure DevOps build

Paste a plain URL, not a Markdown link. Other URLs and descriptions need the
agent to set up a custom watch.

CI watches send a message to chat when they finish, with the result and failed
jobs. Branch watches also report completed CI checks attached to their current
head, as well as new commits; already-completed checks at startup do not send
an alert. Changes to an already-completed check inventory do not repeat that
alert; a new in-progress CI cycle on the same head can report its completion.
These use
`watch.mjs` with `gh` or the Azure DevOps REST API (anonymously, falling back
to `az login` for private projects). Polling runs locally without invoking AI.
If GitHub CLI authentication is blocked by organization SSO, branch watches
fall back to GitHub's anonymous public API. That API has a lower rate limit;
use a longer check interval (up to 15 minutes) for repositories with many checks.
One-shot watches poll every minute; branch watches poll every five minutes.
The canvas shows the latest check, the next scheduled check, an overall
completion bar, and every CI stage or check with its current state. Pipeline
groups distinguish passed, failed, and pending checks. The bar uses semantic
colors for successful, failed, canceled, warning, skipped, and running checks;
queued checks remain unfilled.
The title dot shows an active watch (blue) or a watcher error (red); finished
watches have no dot. CI failures appear in the check counts instead.
Azure DevOps stages show completed/running job counts; GitHub Actions shows
each job and its step count; PR links show all checks, grouped by workflow.
Progress updates do not wake the agent. Built-in link watches run until they
complete or you stop them, without a deadline.
Choose a check frequency for new watches or leave it on Auto. You can attach
a follow-up prompt to run only when the watch finishes or a new commit arrives.
When a follow-up runs, only the agent's answer is shown in chat; the raw watch
notification is hidden from the conversation. Watches without a follow-up
still notify chat with their result. Raw command output is not rendered in the
canvas, though watcher errors remain visible.
Built-in watches use a short title with the repository/branch or run number;
renaming one overrides only its display title, not what it watches.
Use the settings icon in a watch header to rename it and, for built-in watches,
change its interval without restarting the watch or losing its CI progress.
Each watch starts expanded. Use the header chevron to collapse or expand its
details; the choice is kept while the live canvas refreshes.
Custom agent-written watches can be renamed, but their scripted frequency
cannot be changed from the canvas.
The appearance always follows the GitHub Copilot app's theme, including
theme changes while the panel is open. The canvas uses the app's semantic
control, button, surface, status, and font tokens, with the same 6px control
and 8px card radii as the bundled app canvases. Messages beginning with
`monitor` or `Watch:` open the canvas automatically, as does starting a
monitor with the agent tool.

Anything else goes to the agent, in the canvas or in chat, for example:

- "Tell me when CI on PR #34512 finishes, then fix any failures."
- "Watch `build.log` and tell me about errors."

The agent writes a small shell command and starts it with
`copilot_monitor_start`. Each new line the command prints is sent to the same
session (batched for 2 seconds), and so is its exit. The agent can keep working
or stay idle until then, and several monitors can run at once. If the agent
fails or finishes without starting a monitor, the canvas says so and offers
**Try again**. Stop a monitor from the canvas or ask the agent.
For a continuous watch that reports different kinds of changes, set
`followUpOnOutput: true` and `followUpOnOutputPrefix: "CI ended:"` to run its
follow-up only for lines beginning with `CI ended:`. Other stdout lines still
produce ordinary alerts, even if both kinds arrive in one batch. Without a
prefix, every output batch runs the follow-up.
For ongoing conditions, the agent can set `continuous: true` to keep watching
until stopped or until this session ends, without periodically waking the agent
to restart. That option cannot be combined with `timeoutMinutes`.

## MAUI branch Azure jobs example

The optional `examples/watch-maui-branch-ci.mjs` script watches
`dotnet/maui` `inflight/current` or `release/11.0.1xx-rc2` at a five-minute
cadence. Unlike the general GitHub branch watch, it displays **Azure timeline
jobs** from the three MAUI pipelines. Each build must match the exact branch
and head commit. Job rows link to Azure logs; unrelated PR builds and parent
checks do not inflate the counts. Missing builds show pending inventory rather
than fabricated jobs.

To inspect one live snapshot without starting a watch, run:

```bash
node "${COPILOT_HOME:-$HOME/.copilot}/extensions/copilot-monitors/examples/watch-maui-branch-ci.mjs" release/11.0.1xx-rc2 --once
```

To watch continuously, omit `--once` and pass the command to
`copilot_monitor_start` with `continuous: true` and `progress: true`. For a
follow-up only after the three Azure builds finish, set
`followUpOnOutput: true` and
`followUpOnOutputPrefix: "Azure branch CI finished:"`; branch-head changes
and access errors remain ordinary alerts. The example requires public
`dnceng-public/public` builds and GitHub CLI authentication.

## Limits

- Agent-written monitors have a deadline: 30 minutes by default, up to 240.
  The agent gets one notice on expiry. Built-in link watches have no deadline
  and end when the watched CI finishes, on failure, when stopped, or when the
  session's Copilot process stops. Branch watches run until stopped.
- A monitor that sends more than 10 messages within 5 minutes is stopped, so
  noisy commands cannot burn tokens.
- Up to 30 monitors can run in one session at once.
- Commands run with your local permissions in the session's working directory.
  Review agent-written commands before allowing them to run. Pasting a
  supported link in the canvas starts its built-in watcher immediately.
- Monitors live only while the session's Copilot process runs. They are not
  restored after a restart, and their commands are killed if the extension exits.

Run the tests with `node --test *.test.mjs examples/*.test.mjs` in this directory.
