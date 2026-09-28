// Built-in watchers for links pasted into the Monitors canvas.
// Usage: node watch.mjs azdo <org> <project> <buildId> | pr <owner/repo|.> <number> [--pipeline <name>]
//        | run <owner/repo> <runId> | branch <owner/repo> <branch>
// Run/build watches print once; PR/branch watches print on each new CI cycle.
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
const CHECK_RUN_FIELDS = "{total_count,check_runs:[.check_runs[] | {id,name,status,conclusion,details_url,html_url,app:{name:.app.name,slug:.app.slug}}]} | @json";

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
            if (!Number.isInteger(value) || value < 30_000 || value > 900_000) {
                throw new Error("Polling interval must be between 30 and 900 seconds.");
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

export function parseJsonPages(output) {
    if (!output.trim()) throw new Error("GitHub returned no check-run pages.");
    return output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function gh(args) {
    try {
        const { stdout } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
        return args.includes("--jq") ? parseJsonPages(stdout) : JSON.parse(stdout);
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

export async function publicGitHubApi(endpoint, paginate = false, fetcher = fetch) {
    if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:commits|compare)\//.test(endpoint)) {
        throw new Error("Public GitHub API fallback only supports repository commits and comparisons.");
    }
    const pages = [];
    let url = new URL(endpoint, "https://api.github.com/");
    for (let page = 0; url && page < 100; page++) {
        const response = await fetcher(url, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "copilot-monitors" },
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            const rateLimited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
            const error = new Error(`GitHub public API returned HTTP ${response.status} for ${endpoint}.`
                + (rateLimited ? " Anonymous rate limit reached; authorize GitHub CLI for this organization's SSO." : ""));
            error.permanent = response.status === 404;
            throw error;
        }
        pages.push(await response.json());
        if (!paginate) return pages[0];
        const next = response.headers.get("link")?.split(",")
            .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part.trim()))
            .find(Boolean)?.[1];
        url = next ? new URL(next) : null;
        if (url && (url.origin !== "https://api.github.com" || url.username || url.password)) {
            throw new Error("GitHub API pagination attempted to leave api.github.com.");
        }
    }
    if (url) throw new Error(`GitHub API returned more than 100 pages for ${endpoint}.`);
    return pages;
}

export async function githubApi(endpoint, paginate = false, runGh = gh, readPublic = publicGitHubApi) {
    try {
        const compactChecks = paginate && /\/check-runs\?per_page=100$/.test(endpoint);
        const args = compactChecks
            ? ["api", "--paginate", "--jq", CHECK_RUN_FIELDS, endpoint]
            : ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint];
        return await runGh(args);
    } catch (error) {
        if (!/SAML enforcement/i.test(error.message)) throw error;
        return readPublic(endpoint, paginate);
    }
}

export async function branchCheckRuns(repo, head,
    readPages = (endpoint) => githubApi(endpoint, true),
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
    getCommit = () => githubApi(`repos/${repo}/commits/${encodeURIComponent(branch)}`),
    getChecks = (head) => branchCheckRuns(repo, head),
    compare = (previous, head) => githubApi(`repos/${repo}/compare/${previous}...${head}`),
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
    let reportedComplete = Boolean(branchChecksMessage(repo, branch, previous, checks));
    report("waiting", getIntervalMs(), branchStages(checks));
    for (let errors = 0; ;) {
        await wait(getIntervalMs());
        report("checking");
        try {
            const head = await readHead();
            if (head !== previous) report("checking", undefined, []);
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
                reportedComplete = false;
            }
            const ciMessage = branchChecksMessage(repo, branch, head, checks);
            if (ciMessage) {
                if (!reportedComplete) emit(ciMessage);
                reportedComplete = true;
            } else if (checks.some((check) => check.status !== "completed")) {
                reportedComplete = false;
            }
            errors = 0;
            report("waiting", getIntervalMs(), branchStages(checks));
        } catch (error) {
            if (error.permanent || ++errors >= MAX_ERRORS) throw error;
            report("retrying", getIntervalMs());
        }
    }
}

export async function watchPullRequest(repo, number, {
    getPullRequest = () => gh(["pr", "view", number, ...(repo === "." ? [] : ["-R", repo]), "--json", "headRefOid,state,url"]),
    getChecks = async () => {
        try {
            return await gh(["pr", "checks", number, ...(repo === "." ? [] : ["-R", repo]),
                "--json", "name,bucket,state,workflow,link"]);
        } catch (error) {
            if (/no checks reported/i.test(error.message)) return [];
            throw error;
        }
    },
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit = (line) => process.stdout.write(`${line}\n`),
    report = reportProgress,
    getIntervalMs = () => POLL_MS,
    pipeline = null,
} = {}) {
    if (repo !== "." && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
        throw new Error("PR watcher requires an owner/repository or '.' for the current repository.");
    }
    if (!/^\d{1,12}$/.test(String(number))) throw new Error("PR watcher requires a pull request number.");
    if (pipeline !== null && (typeof pipeline !== "string" || !pipeline.trim()
        || pipeline.length > 100 || /[\r\n]/.test(pipeline))) {
        throw new Error("Pipeline must be a nonempty single-line name of at most 100 characters.");
    }
    const label = repo === "." ? `PR #${number}` : `${repo}#${number}`;
    const validate = (pr) => {
        if (!/^[0-9a-f]{40}$/.test(pr?.headRefOid ?? "")
            || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) {
            throw new Error(`GitHub returned an invalid PR state or head for ${label}.`);
        }
        let target;
        try {
            target = new URL(pr.url);
        } catch {
            throw new Error(`GitHub returned an invalid PR URL for ${label}.`);
        }
        if (target.protocol !== "https:" || target.username || target.password) {
            throw new Error(`GitHub returned an invalid PR URL for ${label}.`);
        }
        return target.href;
    };
    let head;
    let reportedComplete = false;
    for (let errors = 0; ;) {
        report("checking");
        try {
            const before = await getPullRequest();
            const beforeUrl = validate(before);
            if (before.state !== "OPEN") {
                report("complete");
                return `${label} ${before.state.toLowerCase()}; watch ended. ${beforeUrl}`;
            }
            if (head && before.headRefOid !== head) report("checking", undefined, []);
            const checks = await getChecks();
            const current = await getPullRequest();
            const target = validate(current);
            if (before?.headRefOid !== current.headRefOid) {
                report("checking", undefined, []);
                throw new Error(`PR head changed while reading checks for ${label}; retrying.`);
            }
            if (current.state !== "OPEN") {
                report("complete", undefined, checkStages(checks));
                return `${label} ${current.state.toLowerCase()}; watch ended. ${target}`;
            }
            if (head && head !== current.headRefOid) {
                emit(`${label} head moved ${head.slice(0, 10)} -> ${current.headRefOid.slice(0, 10)}. ${target}`);
                reportedComplete = false;
            }
            head = current.headRefOid;
            const selected = pipeline === null ? checks : checks.filter((check) =>
                check.workflow === pipeline || check.name === pipeline
                || check.name.startsWith(`${pipeline} (`) || check.name.startsWith(`${pipeline} /`));
            const message = checksMessage(`${pipeline === null ? "" : `${pipeline} | `}${label} (${head.slice(0, 10)})`, selected);
            if (message) {
                if (!reportedComplete) emit(message);
                reportedComplete = true;
            } else if (selected.some((check) => check.bucket === "pending")) {
                reportedComplete = false;
            }
            errors = 0;
            report("waiting", getIntervalMs(), checkStages(checks));
        } catch (error) {
            if (error.permanent || ++errors >= MAX_ERRORS) throw error;
            report("retrying", getIntervalMs());
        }
        await wait(getIntervalMs());
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
        const [repo, number, ...options] = args;
        if (options.length && (options.length !== 2 || options[0] !== "--pipeline")) {
            throw new Error("Usage: watch.mjs pr <owner/repo|.> <number> [--pipeline <name>]");
        }
        return watchPullRequest(repo, number, {
            ...(control && { wait: () => control.wait(), getIntervalMs: () => control.intervalMs }),
            pipeline: options.length ? options[1] : null,
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
