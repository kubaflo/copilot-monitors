import { fileURLToPath } from "node:url";
import { BRANCH_INTERVAL_MS, CI_INTERVAL_MS } from "./intervals.mjs";

const WATCHER = fileURLToPath(new URL("./watch.mjs", import.meta.url));
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENCODED_SEGMENT = /^[A-Za-z0-9_.~%-]+$/;
const NUMBER = /^\d{1,12}$/;
const MAUI_SLASH_BRANCHES = new Set(["release/11.0.1xx-rc2", "inflight/current", "inflight/candidate"]);

function quote(value, platform) {
    if (/^[A-Za-z0-9_./:%+=-]+$/.test(value)) return value;
    return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function watcherCommand(args = [], platform = process.platform) {
    return ["node", WATCHER, ...args].map((value) => quote(value, platform)).join(" ");
}

function preset(description, defaultTitle, args, platform, intervalSeconds, url) {
    return {
        description,
        defaultTitle,
        command: watcherCommand(args, platform),
        ...(url ? { url } : {}),
        continuous: true,
        progress: true,
        followUpOnOutput: args[0] === "branch" || args[0] === "pr",
        ...(args[0] === "pr" && { followUpOnOutputPrefix: "CI ended:" }),
        pollIntervalMs: intervalSeconds === undefined
            ? args[0] === "branch" ? BRANCH_INTERVAL_MS : CI_INTERVAL_MS
            : intervalSeconds * 1_000,
    };
}

function titleOrFallback(title, fallback) {
    return title.length <= 100 ? title : fallback;
}

function parse(text) {
    try {
        const url = new URL(text);
        return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    } catch {
        return null;
    }
}

// Returns a ready-made monitor for a pasted link, or null when the agent should write the watcher.
export function presetFor(text, platform = process.platform, intervalSeconds) {
    const value = text.trim();
    const pr = /^#(\d{1,12})$/.exec(value);
    if (pr) return preset(`PR #${pr[1]} checks`, `PR #${pr[1]}`, ["pr", ".", pr[1]], platform, intervalSeconds);

    const url = parse(value);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);

    if (host === "github.com" && parts.length >= 4 && NAME.test(parts[0]) && NAME.test(parts[1])) {
        const repo = `${parts[0]}/${parts[1]}`;
        if (parts[2] === "tree" && parts.length >= 4) {
            let branch;
            try {
                branch = decodeURIComponent(parts.slice(3).join("/"));
            } catch {
                return null;
            }
            if ((parts.length === 4 && NAME.test(branch))
                || (repo === "dotnet/maui" && MAUI_SLASH_BRANCHES.has(branch))) {
                return preset(`Branch ${repo} ${branch}`, titleOrFallback(`${branch} · ${repo}`, branch),
                    ["branch", repo, branch], platform, intervalSeconds,
                    `https://github.com/${repo}/tree/${branch}`);
            }
        }
        if (parts[2] === "pull" && NUMBER.test(parts[3])) {
            return preset(`${repo}#${parts[3]} checks`, titleOrFallback(`${repo} · PR #${parts[3]}`, `PR #${parts[3]}`),
                ["pr", repo, parts[3]], platform, intervalSeconds,
                `https://github.com/${repo}/pull/${parts[3]}/checks`);
        }
        if (parts[2] === "actions" && parts[3] === "runs" && NUMBER.test(parts[4] ?? "")) {
            return preset(`GitHub Actions run ${parts[4]}`, titleOrFallback(`${repo} · Actions #${parts[4]}`, `Actions #${parts[4]}`),
                ["run", repo, parts[4]], platform, intervalSeconds,
                `https://github.com/${repo}/actions/runs/${parts[4]}`);
        }
        return null;
    }

    const buildId = url.searchParams.get("buildId");
    if (!NUMBER.test(buildId ?? "")) return null;
    let org;
    let rest;
    if (host === "dev.azure.com") {
        [org, ...rest] = parts;
    } else if (host.endsWith(".visualstudio.com")) {
        org = host.slice(0, -".visualstudio.com".length);
        rest = parts;
    } else {
        return null;
    }
    const [project, build] = rest;
    if (!NAME.test(org ?? "") || !ENCODED_SEGMENT.test(project ?? "") || build !== "_build") return null;
    return preset(`Azure DevOps build ${buildId}`,
        titleOrFallback(`${org}/${project} · Build #${buildId}`, `Azure build #${buildId}`),
        ["azdo", org, project, buildId], platform, intervalSeconds,
        `https://dev.azure.com/${org}/${project}/_build/results?buildId=${buildId}`);
}
