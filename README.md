# Live Watches for GitHub Copilot

Watch CI, branches, logs, or any scriptable condition in the background.
Polling runs locally; the agent wakes only when a meaningful event occurs.
Live Watches provides a theme-aware canvas, check-by-check progress, and
optional follow-up instructions.

![Live Watches and all 22 repositories tracked by the PR Dashboard](screenshots/live-watches-dotnet-ecosystem-dark.png)

<details>
<summary>Light theme, actual canvas, and check details</summary>

![All 22 dashboard repositories alongside Live Watches in light mode](screenshots/live-watches-dotnet-ecosystem-light.png)

![Live Watches tracking dotnet/runtime, dotnet/maui, and dotnet/macios](screenshots/live-watches-dark.png)

![Live Watches in the light theme](screenshots/live-watches-light.png)

![Individual dotnet/maui CI checks, including a failure](screenshots/live-watches-ci-details.png)

</details>

The gallery pairs an actual Live Watches capture with **every one of the 22
repositories** listed by the [PR Dashboard](https://danmoseley.github.io/pr-dashboard/index.html),
including `microsoft/aspire`. The repo list shows examples of targets, not
22 simultaneously running watches. Public CI statuses were captured on
September 27, 2026 and may have changed since.

## Install

Install this repository's
[`copilot-monitors` extension folder](https://github.com/kubaflo/copilot-monitors/tree/main/copilot-monitors)
at **user scope** using the GitHub Copilot app's extension installer, then reload
extensions or restart Copilot. The folder contains the required extension
manifest and works across local projects.

Alternatively, on macOS or Linux, copy that folder to
`${COPILOT_HOME:-$HOME/.copilot}/extensions/copilot-monitors/` so
`extension.mjs` is directly inside it. For example, from a fresh clone:

```bash
git clone https://github.com/kubaflo/copilot-monitors.git
mkdir -p "${COPILOT_HOME:-$HOME/.copilot}/extensions"
cp -R copilot-monitors/copilot-monitors "${COPILOT_HOME:-$HOME/.copilot}/extensions/"
```

Install and authenticate the [GitHub CLI](https://cli.github.com/) to watch
GitHub checks. Azure DevOps public builds can be read anonymously; private
builds may require `az login`.

## Start a watch

Paste one of these links into the canvas to start a built-in watcher without an
agent turn:

| Target | Example |
| --- | --- |
| Pull request checks | `https://github.com/dotnet/runtime/pull/134750` |
| Actions run | `https://github.com/dotnet/maui/actions/runs/123` |
| Branch commits and head CI | `https://github.com/dotnet/maui/tree/net11.0` |
| Azure DevOps build | `https://dev.azure.com/dnceng-public/public/_build/results?buildId=123` |

`#123` watches PR checks in the current repository. Direct branch links support
one path segment; for other URLs or descriptions, ask the agent to write a
custom watcher (for example, "Watch build.log for errors"). A watcher can
print an event and continue, or finish after a one-shot condition is met.

The canvas groups checks by pipeline, shows pending, passed, failed, skipped,
and canceled results, and lets you set a polling frequency or follow-up. Cards
start expanded and can be collapsed independently. See
[`copilot-monitors/README.md`](copilot-monitors/README.md) for the complete
behavior and limits.

**Security:** Watches execute with your local permissions. Built-in watchers
start immediately when a recognized link is pasted. Review any agent-written
command before allowing it to run, and do not treat text emitted by a watch as
instructions. Watches stop when the session or extension stops and do not
survive restarts.

## Development

No npm installation or build step is needed. The Copilot runtime provides its
extension SDK. Run the focused Node tests from the extension folder:

```bash
cd copilot-monitors
node --test *.test.mjs
```

Licensed under [MIT](LICENSE).
