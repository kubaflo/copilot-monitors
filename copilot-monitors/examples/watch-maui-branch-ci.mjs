import { pathToFileURL } from "node:url";
import { githubApi } from "../watch.mjs";
import { reportProgress } from "../progress.mjs";

const repo = "dotnet/maui";
const intervalMs = 300_000;
const pipelines = new Map([
    [302, "maui-pr"],
    [313, "maui-pr-uitests"],
    [314, "maui-pr-devicetests"],
]);
const allowedBranches = new Set(["inflight/current", "release/11.0.1xx-rc2"]);

export function selectBuilds(builds, branch, sha) {
    return [...pipelines].map(([definitionId, name]) => {
        const matches = builds.filter((build) =>
            build.definition?.id === definitionId
            && build.sourceBranch === `refs/heads/${branch}`
            && build.sourceVersion === sha);
        matches.sort((a, b) => Date.parse(b.queueTime) - Date.parse(a.queueTime) || b.id - a.id);
        return { name, build: matches[0] };
    });
}

function buildState(build) {
    if (!build) return "queued";
    if (build.status !== "completed") {
        return ["inProgress", "cancelling"].includes(build.status) ? "running" : "queued";
    }
    return {
        succeeded: "passed",
        succeededWithIssues: "warning",
        failed: "failed",
        canceled: "canceled",
    }[build.result] ?? "unknown";
}

function jobState(job) {
    if (job.state === "pending") return "queued";
    if (job.state === "inProgress") return "running";
    if (job.state !== "completed") return "unknown";
    return {
        succeeded: "passed",
        succeededWithIssues: "warning",
        failed: "failed",
        canceled: "canceled",
        skipped: "skipped",
        abandoned: "canceled",
    }[job.result] ?? "unknown";
}

async function jobStages(name, build, branch, sha) {
    const placeholder = (detail, state = "queued") => ({
        stages: [{
            name: `${name}: awaiting jobs`,
            state,
            group: `${name} - pending job inventory`,
            detail,
            ...(build ? { url: `https://dev.azure.com/dnceng-public/public/_build/results?buildId=${build.id}` } : {}),
        }],
        jobCount: 0,
    });
    if (!build) return placeholder("Awaiting a build for this exact branch head; not a job.");
    const response = await fetch(`https://dev.azure.com/dnceng-public/public/_apis/build/builds/${build.id}/timeline?api-version=7.1`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
        throw new Error(`Azure timeline lookup for build ${build.id} failed: HTTP ${response.status}, expected JSON.`);
    }
    const timeline = await response.json();
    if (!Array.isArray(timeline.records)) throw new Error(`Azure returned no timeline records for build ${build.id}.`);
    const records = new Map(timeline.records.map((record) => [record.id, record]));
    const jobs = timeline.records.filter((record) => record.type === "Job");
    if (!jobs.length) {
        if (build.status === "completed") throw new Error(`Completed build ${build.id} has no timeline jobs.`);
        return placeholder(`Build ${build.id}: ${build.status}; no timeline jobs yet; not a job.`, buildState(build));
    }
    const stages = jobs.map((job) => {
        let parent = records.get(job.parentId);
        const visited = new Set([job.id]);
        while (parent && parent.type !== "Stage" && !visited.has(parent.id)) {
            visited.add(parent.id);
            parent = records.get(parent.parentId);
        }
        const stageName = parent?.type === "Stage" ? parent.name : null;
        const detail = [
            `Build ${build.id}; ${job.state}: ${job.result ?? "result pending"}`,
            `${branch}@${sha.slice(0, 10)}`,
            job.attempt ? `attempt ${job.attempt}` : null,
            job.workerName,
            job.currentOperation,
        ].filter(Boolean).join("; ");
        return {
            name: (stageName ? `${stageName} / ${job.name}` : job.name).slice(0, 500),
            state: jobState(job),
            group: `${name} - Azure jobs`,
            detail: detail.slice(0, 500),
            url: `https://dev.azure.com/dnceng-public/public/_build/results?buildId=${build.id}&view=logs&j=${encodeURIComponent(job.id)}`,
        };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));
    return { stages, jobCount: jobs.length };
}

export async function snapshot(branch) {
    if (!allowedBranches.has(branch)) throw new Error(`Unsupported branch: ${branch}`);
    const commit = await githubApi(`repos/${repo}/commits/${encodeURIComponent(branch)}`);
    if (!/^[0-9a-f]{40}$/.test(commit?.sha ?? "")) throw new Error("GitHub returned an invalid head SHA.");
    const url = new URL("https://dev.azure.com/dnceng-public/public/_apis/build/builds");
    url.search = new URLSearchParams({
        "api-version": "7.1",
        branchName: `refs/heads/${branch}`,
        definitions: [...pipelines.keys()].join(","),
        queryOrder: "queueTimeDescending",
        "$top": "100",
    });
    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
        throw new Error(`Azure branch-build lookup failed: HTTP ${response.status}, expected JSON.`);
    }
    const data = await response.json();
    if (!Array.isArray(data.value)) throw new Error("Azure returned no build collection.");
    const selected = selectBuilds(data.value, branch, commit.sha);
    const builds = selected.map(({ name, build }) => ({
        name,
        state: buildState(build),
        ...(build ? {
            id: build.id,
            sourceBranch: build.sourceBranch,
            sourceVersion: build.sourceVersion,
            url: `https://dev.azure.com/dnceng-public/public/_build/results?buildId=${build.id}`,
        } : {}),
    }));
    const timelines = await Promise.all(selected.map(({ name, build }) => jobStages(name, build, branch, commit.sha)));
    const complete = selected.every(({ build }) =>
        build?.status === "completed" && buildState(build) !== "unknown");
    return {
        sha: commit.sha,
        builds,
        stages: timelines.flatMap((timeline) => timeline.stages),
        jobCount: timelines.reduce((count, timeline) => count + timeline.jobCount, 0),
        complete,
        key: JSON.stringify(selected.map(({ name, build }) => [name, build?.id, build?.status, build?.result])),
    };
}

async function watch(branch) {
    let previous;
    let completedKey;
    let lastError;
    let errors = 0;
    for (;;) {
        reportProgress("checking");
        try {
            const current = await snapshot(branch);
            if (lastError) console.log(`Watching ${repo} ${branch}: branch CI access recovered.`);
            if (previous && current.sha !== previous) {
                console.log(`${repo} ${branch} moved ${previous.slice(0, 10)} -> ${current.sha.slice(0, 10)}. https://github.com/${repo}/tree/${branch}`);
                completedKey = null;
            }
            if (previous && current.complete && current.key !== completedKey) {
                const results = current.builds.map((build) => `${build.name}: ${build.state} (${build.url})`);
                console.log(`Azure branch CI finished: ${repo} ${branch} (${current.sha.slice(0, 10)}). ${results.join("; ")}. PR builds are excluded.`);
            }
            previous = current.sha;
            completedKey = current.complete ? current.key : null;
            errors = 0;
            lastError = null;
            reportProgress("waiting", intervalMs, current.stages);
        } catch (error) {
            if (error.message !== lastError) console.log(`Branch watch error for ${repo} ${branch}: ${error.message}`);
            lastError = error.message;
            if (++errors >= 5) throw error;
            reportProgress("retrying", intervalMs);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [branch, mode, ...rest] = process.argv.slice(2);
    if (!allowedBranches.has(branch) || (mode !== undefined && mode !== "--once") || rest.length) {
        throw new Error("Usage: node watch-maui-branch-ci.mjs <inflight/current|release/11.0.1xx-rc2> [--once]");
    }
    if (mode === "--once") {
        console.log(JSON.stringify(await snapshot(branch), null, 2));
    } else {
        await watch(branch);
    }
}
