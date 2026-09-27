// Built-in watchers for links pasted into the Monitors canvas.
// Usage: node watch.mjs azdo <org> <project> <buildId> | pr <owner/repo|.> <number>
//        | run <owner/repo> <runId> | branch <owner/repo> <branch>
// One-shot watches print once on completion; branch watches print on head changes and CI completion.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BRANCH_INTERVAL_MS, CI_INTERVAL_MS } from "./intervals.mjs";
import { reportFrequency, reportProgress } from "./progress.mjs";

const exec = promisify(execFile);
const POLL_MS = Number(process.env.COPILOT_MONITOR_POLL_MS) || CI_INTERVAL_MS;
const BRANCH_POLL_MS = Number(process.env.COPILOT_MONITOR_BRANCH_POLL_MS) || BRANCH_INTERVAL_MS;
const MAX_ERRORS = 5;
const AZDO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const TOKEN_MAX_AGE_MS = 30 * 60_000;

export function createFrequencyControl(initialMs, {
    now = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    report = reportFrequency,
} = {}) {
    let intervalMs = initialMs;
    let waiting = null;
    return {
        get intervalMs() { return intervalMs; },
        wait() {
            if (waiting) throw new Error("Watcher is already waiting.");
            return new Promise((resolve) => {
                const current = { started: now(), timer: null, done: null };
                current.done = () => {
                    if (waiting !== current) return;
                    waiting = null;
                    resolve();
                };
                current.timer = schedule(current.done, intervalMs);
                waiting = current;
            });
        },
        update(value) {
            if (!Number.isInteger(value) || value < 30_000 || value > 600_000) {
                throw new Error("Polling interval must be between 30 and 600 seconds.");
            }
            intervalMs = value;
            let remainingMs = null;
            if (waiting) {
                cancel(waiting.timer);
                remainingMs = Math.max(0, intervalMs - (now() - waiting.started));
                waiting.timer = schedule(waiting.done, remainingMs);
            }
            report(intervalMs, remainingMs);
        },
    };
}

function names(list, limit = 10) {
    return list.length > limit ? `${list.slice(0, limit).join(", ")} and ${list.length - limit} more` : list.join(", ");
}

function stageState(state, result) {
    const activity = String(state ?? "").toLowerCase();
    if (["inprogress", "in_progress"].includes(activity)) return "running";
    if (["pending", "queued", "waiting", "requested"].includes(activity)) return "queued";
    const outcome = String(result ?? "").toLowerCase();
    if (outcome === "pending") return "queued";
    if (["succeeded", "success", "pass"].includes(outcome)) return "passed";
    if (["failed", "failure", "fail", "timed_out", "action_required"].includes(outcome)) return "failed";
    if (["canceled", "cancelled", "cancel"].includes(outcome)) return "canceled";
    if (["skipped", "skipping"].includes(outcome)) return "skipped";
    if (["succeededwithissues", "neutral"].includes(outcome)) return "warning";
    return "unknown";
}

export function azureStages(timeline, runUrl) {
    if (!Array.isArray(timeline?.records)) throw new Error("Azure DevOps timeline has no records.");
    const records = timeline.records;
    const stages = records.filter((record) => record.type === "Stage");
    const jobs = records.filter((record) => record.type === "Job");
    const parents = new Map(records.map((record) => [record.id, record]));
    const counts = new Map();
    for (const job of jobs) {
        let parent = parents.get(job.parentId);
        const visited = new Set();
        while (parent && parent.type !== "Stage" && !visited.has(parent.id)) {
            visited.add(parent.id);
            parent = parents.get(parent.parentId);
        }
        if (parent?.type !== "Stage") continue;
        const count = counts.get(parent.id) ?? { total: 0, finished: 0, running: 0 };
        count.total += 1;
        if (job.state === "completed") count.finished += 1;
        if (job.state === "inProgress") count.running += 1;
        counts.set(parent.id, count);
    }
    return (stages.length ? stages : jobs)
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
        .map((record) => {
            const count = counts.get(record.id);
            return {
                name: record.name,
                state: stageState(record.state, record.result),
                ...(count?.total ? { detail: `${count.finished}/${count.total} jobs finished${count.running ? `, ${count.running} running` : ""}` } : {}),
                ...(runUrl ? { url: record.type === "Job" && record.id
                    ? `${runUrl}&view=logs&jobId=${encodeURIComponent(record.id)}`
                    : runUrl } : {}),
            };
        });
}

export function actionStages(run) {
    return (run.jobs ?? []).map((job) => {
        const steps = job.steps ?? [];
        const finished = steps.filter((step) => step.status === "completed").length;
        return {
            name: job.name,
            state: stageState(job.status, job.conclusion),
            ...(steps.length ? { detail: `${finished}/${steps.length} steps finished` } : {}),
            ...(job.url || run.url ? { url: job.url || run.url } : {}),
        };
    });
}

export function checkStages(checks) {
    return checks.map((check) => {
        const pipeline = /^([A-Za-z0-9_.-]+)(?: \(|$)/.exec(check.name)?.[1];
        const azure = /^https:\/\/(?:dev\.azure\.com\/|[A-Za-z0-9.-]+\.visualstudio\.com\/)/.test(check.link ?? "");
        return {
            name: check.name,
            state: stageState(check.state, check.bucket),
            group: check.workflow || (azure && pipeline ? pipeline : "Other checks"),
            ...(check.link ? { url: check.link } : {}),
        };
    }).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

export function checksMessage(label, checks) {
    if (!checks.length || checks.some((check) => check.bucket === "pending")) return null;
    const count = (bucket) => checks.filter((check) => check.bucket === bucket).length;
    const failed = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map((check) => check.name);
    const other = checks.length - count("pass") - failed.length;
    return `CI ended: ${label} checks finished: ${count("pass")} passed, ${failed.length} failed or canceled${other ? `, ${other} skipped` : ""}.`
        + (failed.length ? ` Failed: ${names(failed)}.` : "");
}

export function runMessage(run) {
    if (run.status !== "completed") return null;
    const failed = (run.jobs ?? []).filter((job) => job.conclusion === "failure" || job.conclusion === "cancelled").map((job) => job.name);
    const title = run.displayTitle && run.displayTitle !== run.workflowName ? `${run.workflowName}: ${run.displayTitle}` : run.workflowName;
    return `CI ended: GitHub Actions run "${title}" finished: ${run.conclusion}.`
        + (failed.length ? ` Failed jobs: ${names(failed)}.` : "") + ` ${run.url}`;
}

export function buildMessage(build, timeline, url) {
    if (build.status !== "completed") return null;
    const failed = (timeline?.records ?? []).filter((record) => record.type === "Job" && record.result === "failed").map((record) => record.name);
    return `CI ended: Azure DevOps build ${build.id} (${build.definition?.name ?? "pipeline"}) finished: ${build.result}.`
        + (failed.length ? ` Failed jobs: ${names(failed)}.` : "") + ` ${url}`;
}

export function branchMessage(repo, branch, previous, head, comparison) {
    const commits = comparison.commits ?? [];
    const count = comparison.ahead_by ?? commits.length;
    const titles = commits.slice(-5).map((commit) => commit.commit.message.split("\n")[0]);
    const changes = titles.length ? `: ${titles.join("; ")}` : "";
    return `${repo} ${branch} moved ${previous.slice(0, 10)} -> ${head.slice(0, 10)} `
        + `(${comparison.status}, ${count} new commit${count === 1 ? "" : "s"})${changes}. `
        + `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
}

export function branchChecksMessage(repo, branch, head, checks) {
    if (!checks.length || checks.some((check) => check.status !== "completed")) return null;
    const states = checks.map((check) => stageState(check.status, check.conclusion));
    const count = (state) => states.filter((value) => value === state).length;
    const failed = checks.filter((check) => ["failed", "canceled"].includes(stageState(check.status, check.conclusion)))
        .map((check) => check.name);
    return `CI ended: ${repo} ${branch} (${head.slice(0, 10)}) checks finished: ${count("passed")} passed, `
        + `${failed.length} failed or canceled`
        + (count("warning") ? `, ${count("warning")} warning` : "")
        + (count("skipped") ? `, ${count("skipped")} skipped` : "")
        + (count("unknown") ? `, ${count("unknown")} unknown` : "")
        + `.${failed.length ? ` Failed: ${names(failed)}.` : ""} `
        + `https://github.com/${repo}/commit/${head}/checks`;
}

async function gh(args) {
    try {
        return JSON.parse((await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 })).stdout);
    } catch (error) {
        // `gh pr checks` can exit non-zero while still printing valid JSON.
        if (args[0] === "pr" && args[1] === "checks" && error.stdout) {
            try {
                return JSON.parse(error.stdout);
            } catch {}
        }
        const failure = new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(error.stderr || error.message).trim()}`);
        failure.permanent = /could not resolve|not found|HTTP 404/i.test(failure.message);
        throw failure;
    }
}

export async function branchCheckRuns(repo, head,
    readPages = (endpoint) => gh(["api", "--paginate", "--slurp", endpoint]),
    retry = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    let received = 0;
    let expected = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        const pages = await readPages(`repos/${repo}/commits/${head}/check-runs?per_page=100`);
        if (!Array.isArray(pages) || !pages.length || !pages.every((page) =>
            Array.isArray(page?.check_runs) && Number.isInteger(page.total_count))) {
            throw new Error(`GitHub returned invalid check runs for ${repo} ${head}.`);
        }
        const checks = new Map(pages.flatMap((page) => page.check_runs).map((check) => [check.id, check]));
        received = checks.size;
        expected = Math.max(...pages.map((page) => page.total_count));
        if (received >= expected) return [...checks.values()];
        if (attempt < 2) await retry(500);
    }
    const error = new Error(`GitHub returned incomplete check runs for ${repo} ${head} (${received}/${expected}); checks are still updating.`);
    error.transient = true;
    throw error;
}

function branchStages(checks) {
    return checkStages(checks.map((check) => ({
        name: check.name,
        state: check.status,
        bucket: check.conclusion,
        link: check.details_url || check.html_url,
        workflow: check.app?.slug === "azure-pipelines" ? "" : check.app?.name,
    })));
}

export async function watchBranch(repo, branch, {
    getCommit = () => gh(["api", `repos/${repo}/commits/${encodeURIComponent(branch)}`]),
    getChecks = (head) => branchCheckRuns(repo, head),
    compare = (previous, head) => gh(["api", `repos/${repo}/compare/${previous}...${head}`]),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit = (line) => process.stdout.write(`${line}\n`),
    report = reportProgress,
    intervalMs = BRANCH_POLL_MS,
    getIntervalMs = () => intervalMs,
    retryWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[A-Za-z0-9_.-]+$/.test(branch)) {
        throw new Error("Branch watcher requires a valid owner/repository and branch name.");
    }
    const readHead = async () => {
        const commit = await getCommit();
        if (!/^[0-9a-f]{40}$/.test(commit?.sha ?? "")) {
            throw new Error(`GitHub returned an invalid head SHA for ${repo} ${branch}.`);
        }
        return commit.sha;
    };
    report("checking");
    let previous;
    let checks;
    for (let attempt = 0; ;) {
        previous = await readHead();
        try {
            checks = await getChecks(previous);
            break;
        } catch (error) {
            if (!error.transient || ++attempt >= MAX_ERRORS) throw error;
            report("retrying", 5_000);
            await retryWait(5_000);
            report("checking");
        }
    }
    let completedKey = branchChecksMessage(repo, branch, previous, checks)
        ? checks.map((check) => `${check.id}:${check.conclusion}`).sort().join("|") : null;
    report("waiting", getIntervalMs(), branchStages(checks));
    for (let errors = 0; ;) {
        await wait(getIntervalMs());
        report("checking");
        try {
            const head = await readHead();
            checks = await getChecks(head);
            if (head !== previous) {
                let line;
                try {
                    line = branchMessage(repo, branch, previous, head, await compare(previous, head));
                } catch (error) {
                    line = `${repo} ${branch} moved ${previous.slice(0, 10)} -> ${head.slice(0, 10)}; `
                        + `commit comparison unavailable: ${error.message}. https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
                }
                emit(line);
                previous = head;
                completedKey = null;
            }
            const ciMessage = branchChecksMessage(repo, branch, head, checks);
            if (ciMessage) {
                const key = checks.map((check) => `${check.id}:${check.conclusion}`).sort().join("|");
                if (key !== completedKey) emit(ciMessage);
                completedKey = key;
            } else {
                completedKey = null;
            }
            errors = 0;
            report("waiting", getIntervalMs(), branchStages(checks));
        } catch (error) {
            if (error.permanent || ++errors >= MAX_ERRORS) throw error;
            report("retrying", getIntervalMs());
        }
    }
}

let token;
async function azdoToken() {
    if (!token || Date.now() - token.at > TOKEN_MAX_AGE_MS) {
        try {
            const { stdout } = await exec("az", ["account", "get-access-token", "--resource", AZDO_RESOURCE, "--query", "accessToken", "-o", "tsv"]);
            token = { value: stdout.trim(), at: Date.now() };
        } catch {
            token = { value: "", at: Date.now() };
        }
    }
    return token.value;
}

async function azdo(url) {
    let status;
    for (const signedIn of [false, true]) {
        const bearer = signedIn ? await azdoToken() : "";
        if (signedIn && !bearer) break;
        const response = await fetch(url, {
            headers: { Accept: "application/json", ...(bearer && { Authorization: `Bearer ${bearer}` }) },
            redirect: "manual",
            signal: AbortSignal.timeout(30_000),
        });
        status = response.status;
        // Private projects answer anonymous calls with a sign-in page instead of JSON.
        if (response.ok && response.headers.get("content-type")?.includes("json")) return response.json();
    }
    const failure = new Error(`Azure DevOps returned HTTP ${status} for ${url}.`
        + ([203, 302, 401, 403].includes(status) ? " For a private project, sign in with `az login`." : ""));
    failure.permanent = status === 404;
    throw failure;
}

async function poll(check, control) {
    for (let errors = 0; ;) {
        reportProgress("checking");
        try {
            const { message, stages } = await check();
            reportProgress(message ? "complete" : "waiting", message ? undefined : control?.intervalMs ?? POLL_MS, stages);
            if (message) return message;
            errors = 0;
        } catch (error) {
            if (error.permanent || ++errors >= MAX_ERRORS) throw error;
            reportProgress("retrying", control?.intervalMs ?? POLL_MS);
        }
        if (control) await control.wait();
        else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

export async function watch([kind, ...args], control) {
    if (kind === "branch") return watchBranch(...args, control && {
        wait: () => control.wait(),
        getIntervalMs: () => control.intervalMs,
    });
    if (kind === "azdo") {
        const [org, project, id] = args;
        const api = `https://dev.azure.com/${org}/${project}/_apis/build/builds/${id}`;
        const url = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${id}`;
        return poll(async () => {
            const build = await azdo(`${api}?api-version=7.1`);
            try {
                const timeline = await azdo(`${api}/timeline?api-version=7.1`);
                return { message: buildMessage(build, timeline, url), stages: azureStages(timeline, url) };
            } catch (error) {
                if (build.status !== "completed") throw error;
                return { message: `${buildMessage(build, null, url)} Stage details unavailable: ${error.message}` };
            }
        }, control);
    }
    if (kind === "pr") {
        const [repo, number] = args;
        const scope = repo === "." ? [] : ["-R", repo];
        const label = repo === "." ? `PR #${number}` : `${repo}#${number}`;
        return poll(async () => {
            const checks = await gh(["pr", "checks", number, ...scope, "--json", "name,bucket,state,workflow,link"]).catch((error) => {
                // Checks can take a few minutes to appear after a push.
                if (/no checks reported/i.test(error.message)) return [];
                throw error;
            }, control);
            return { message: checksMessage(label, checks), stages: checkStages(checks) };
        });
    }
    if (kind === "run") {
        const [repo, id] = args;
        return poll(async () => {
            const run = await gh(["run", "view", id, "-R", repo, "--json", "status,conclusion,workflowName,displayTitle,url,jobs"]);
            return { message: runMessage(run), stages: actionStages(run) };
        }, control);
    }
    throw new Error(`Unknown watcher "${kind}".`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const control = createFrequencyControl(process.argv[2] === "branch" ? BRANCH_POLL_MS : POLL_MS);
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
        try {
            control.update(Number(line));
        } catch (error) {
            process.stderr.write(`${error.message}\n`);
        }
    });
    const closeInput = () => {
        input.close();
        process.stdin.pause();
    };
    watch(process.argv.slice(2), control).then(
        (message) => {
            closeInput();
            process.stdout.write(`${message}\n`);
        },
        (error) => {
            closeInput();
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        });
}
