import assert from "node:assert/strict";
import { test } from "node:test";
import { presetFor } from "./presets.mjs";
import { actionStages, azureStages, branchCheckRuns, branchChecksMessage, branchMessage, buildMessage, checkStages, checksMessage, createFrequencyControl, githubApi, parseJsonPages, publicGitHubApi, runMessage, watchBranch, watchPullRequest } from "./watch.mjs";

test("pasted links become built-in watchers", () => {
    const cases = [
        ["https://dev.azure.com/dnceng-public/public/_build/results?buildId=1612602&view=results", "Azure DevOps build 1612602", "dnceng-public/public · Build #1612602", "azdo dnceng-public public 1612602", "https://dev.azure.com/dnceng-public/public/_build/results?buildId=1612602"],
        ["https://dnceng.visualstudio.com/internal/_build/results?buildId=42", "Azure DevOps build 42", "dnceng/internal · Build #42", "azdo dnceng internal 42", "https://dev.azure.com/dnceng/internal/_build/results?buildId=42"],
        ["https://github.com/dotnet/maui/pull/38893/checks", "dotnet/maui#38893 checks", "dotnet/maui · PR #38893", "pr dotnet/maui 38893", "https://github.com/dotnet/maui/pull/38893/checks"],
        ["https://github.com/dotnet/maui/actions/runs/361784/job/1", "GitHub Actions run 361784", "dotnet/maui · Actions #361784", "run dotnet/maui 361784", "https://github.com/dotnet/maui/actions/runs/361784"],
        ["  #123 ", "PR #123 checks", "PR #123", "pr . 123", undefined],
    ];
    for (const [text, description, defaultTitle, args, url] of cases) {
        const preset = presetFor(text, "darwin");
        assert.equal(preset.description, description);
        assert.equal(preset.defaultTitle, defaultTitle);
        assert.equal(preset.url, url);
        assert.match(preset.command, new RegExp(`^node \\S+/watch\\.mjs ${args}$`));
        assert.equal(preset.continuous, true);
        assert.equal(preset.progress, true);
        assert.equal(preset.followUpOnOutput, args.startsWith("pr "));
        assert.equal(preset.followUpOnOutputPrefix, args.startsWith("pr ") ? "CI ended:" : undefined);
        assert.equal(preset.timeoutMinutes, undefined);
        assert.equal(preset.pollIntervalMs, 60_000);
    }
});

test("branch links create continuous watchers without a deadline", () => {
    const preset = presetFor("https://github.com/dotnet/maui/tree/net11.0", "darwin");
    assert.equal(preset.description, "Branch dotnet/maui net11.0");
    assert.equal(preset.defaultTitle, "net11.0 · dotnet/maui");
    assert.match(preset.command, /^node \S+\/watch\.mjs branch dotnet\/maui net11\.0$/);
    assert.equal(preset.continuous, true);
    assert.equal(preset.progress, true);
    assert.equal(preset.followUpOnOutput, true);
    assert.equal(preset.timeoutMinutes, undefined);
    assert.equal(preset.pollIntervalMs, 300_000);
    assert.equal(preset.url, "https://github.com/dotnet/maui/tree/net11.0");
});

test("each built-in watcher can use a per-watch check frequency without changing its command", () => {
    for (const url of [
        "https://dev.azure.com/dnceng-public/public/_build/results?buildId=42",
        "https://github.com/dotnet/maui/pull/42",
        "https://github.com/dotnet/maui/actions/runs/42",
        "https://github.com/dotnet/maui/tree/net11.0",
    ]) {
        const normal = presetFor(url, "darwin");
        for (const seconds of [30, 60, 120, 300, 600, 900]) {
            const configured = presetFor(url, "darwin", seconds);
            assert.equal(configured.pollIntervalMs, seconds * 1_000);
            assert.equal(configured.command, normal.command);
        }
    }
});

test("changing frequency reschedules a pending check without losing the watcher", async () => {
    let now = 1_000;
    const timers = [];
    const updates = [];
    const control = createFrequencyControl(300_000, {
        now: () => now,
        schedule: (done, delay) => {
            const timer = { done, delay, canceled: false };
            timers.push(timer);
            return timer;
        },
        cancel: (timer) => { timer.canceled = true; },
        report: (interval, remaining) => updates.push([interval, remaining]),
    });
    const waiting = control.wait();
    assert.equal(timers[0].delay, 300_000);
    now += 60_000;
    control.update(120_000);
    assert.equal(control.intervalMs, 120_000);
    assert.equal(timers[0].canceled, true);
    assert.equal(timers[1].delay, 60_000);
    assert.deepEqual(updates, [[120_000, 60_000]]);
    timers[1].done();
    await waiting;
    control.update(30_000);
    assert.deepEqual(updates[1], [30_000, null]);
    control.update(900_000);
    assert.deepEqual(updates[2], [900_000, null]);
    assert.throws(() => control.update(29_999), /Polling interval/);
    assert.throws(() => control.update(900_001), /Polling interval/);
});

test("other text and unsafe links go to the agent", () => {
    for (const text of [
        "tell me when #123 finishes",
        "https://example.com/?buildId=1",
        "https://dev.azure.com/org;rm/p/_build/results?buildId=1",
        "https://dev.azure.com/org/p'x/_build/results?buildId=1",
        "https://github.com/dotnet/maui/issues/1",
        "https://github.com/dotnet/maui/pull/1$(id)",
        "https://github.com/dotnet/maui/tree/net11.0/src",
        "file:///etc/passwd",
    ]) {
        assert.equal(presetFor(text, "darwin"), null, text);
    }
});

test("branch polling only emits when the head changes", async () => {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const heads = [oldSha, oldSha, oldSha, newSha, newSha];
    const lines = [];
    const phases = [];
    const end = new Error("test complete");
    end.permanent = true;
    await assert.rejects(watchBranch("dotnet/maui", "net11.0", {
        getCommit: async () => {
            if (!heads.length) throw end;
            return { sha: heads.shift() };
        },
        getChecks: async () => [],
        compare: async (previous, head) => {
            assert.equal(previous, oldSha);
            assert.equal(head, newSha);
            return { status: "ahead", ahead_by: 1, commits: [{ commit: { message: "Fix CollectionView\n\nDetails" } }] };
        },
        wait: async () => {},
        emit: (line) => { lines.push(line); },
        report: (phase) => { phases.push(phase); },
    }), end);
    assert.deepEqual(lines, [
        "dotnet/maui net11.0 moved aaaaaaaaaa -> bbbbbbbbbb (ahead, 1 new commit): "
        + "Fix CollectionView. https://github.com/dotnet/maui/tree/net11.0",
    ]);
    assert.deepEqual(phases, ["checking", "waiting", "checking", "waiting", "checking", "waiting", "checking", "waiting", "checking", "waiting", "checking"]);
});

test("branch comparison errors remain visible in its change notification", async () => {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const lines = [];
    const end = new Error("test complete");
    end.permanent = true;
    const heads = [oldSha, newSha];
    await assert.rejects(watchBranch("dotnet/maui", "net11.0", {
        getCommit: async () => {
            if (!heads.length) throw end;
            return { sha: heads.shift() };
        },
        getChecks: async () => [],
        compare: async () => { throw new Error("compare unavailable"); },
        wait: async () => {},
        emit: (line) => { lines.push(line); },
        report: () => {},
    }), end);
    assert.match(lines[0], /moved aaaaaaaaaa -> bbbbbbbbbb; commit comparison unavailable: compare unavailable/);
});

test("branch check runs load every page, not just the first 100 checks", async () => {
    const head = "a".repeat(40);
    const checks = await branchCheckRuns("dotnet/maui", head, async (endpoint) => {
        assert.equal(endpoint, `repos/dotnet/maui/commits/${head}/check-runs?per_page=100`);
        return [
            { total_count: 3, check_runs: [{ id: 1 }, { id: 2 }] },
            { total_count: 3, check_runs: [{ id: 3 }] },
        ];
    });
    assert.deepEqual(checks.map((check) => check.id), [1, 2, 3]);
    let attempts = 0;
    const refreshed = await branchCheckRuns("dotnet/maui", head, async () =>
        ++attempts === 1
            ? [{ total_count: 3, check_runs: [{ id: 1 }, { id: 2 }] }]
            : [{ total_count: 3, check_runs: [{ id: 1 }, { id: 2 }, { id: 3 }] }],
    async () => {});
    assert.equal(attempts, 2);
    assert.equal(refreshed.length, 3);
    await assert.rejects(branchCheckRuns("dotnet/maui", head, async () =>
        [{ total_count: 3, check_runs: [{ id: 1 }, { id: 2 }] }], async () => {}),
    (error) => error.transient && /incomplete check runs/.test(error.message));
});

test("SSO-blocked branch requests fall back only to the public GitHub API", async () => {
    const endpoint = `repos/microsoft/aspire/commits/${"a".repeat(40)}/check-runs?per_page=100`;
    const pages = [{ total_count: 1, check_runs: [{ id: 1 }] }];
    let usedPublic = 0;
    assert.deepEqual(await githubApi(endpoint, true, async (args) => {
        assert.deepEqual(args.slice(0, 3), ["api", "--paginate", "--jq"]);
        assert.match(args[3], /total_count.*check_runs.*app.*@json/);
        assert.equal(args[4], endpoint);
        throw new Error("Resource protected by organization SAML enforcement.");
    }, async (path, paginated) => {
        assert.equal(path, endpoint);
        assert.equal(paginated, true);
        usedPublic++;
        return pages;
    }), pages);
    assert.equal(usedPublic, 1);
    await assert.rejects(githubApi(endpoint, false, async () => {
        throw new Error("HTTP 500");
    }, async () => { usedPublic++; }), /HTTP 500/);
    assert.equal(usedPublic, 1);
});

test("compact GitHub check pages preserve every result and reject empty output", () => {
    const pages = [{ total_count: 2, check_runs: [{ id: 1 }] }, { total_count: 2, check_runs: [{ id: 2 }] }];
    assert.deepEqual(parseJsonPages(pages.map((page) => JSON.stringify(page)).join("\n") + "\n"), pages);
    assert.throws(() => parseJsonPages(""), /no check-run pages/);
    assert.throws(() => parseJsonPages("{}\ninvalid"), /JSON/);
});

test("public GitHub API fallback paginates only on api.github.com", async () => {
    const endpoint = `repos/microsoft/aspire/commits/${"a".repeat(40)}/check-runs?per_page=100`;
    const next = `https://api.github.com/repositories/42/commits/${"a".repeat(40)}/check-runs?per_page=100&page=2`;
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push(url.href);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Accept, "application/vnd.github+json");
        return {
            ok: true,
            headers: { get: (name) => name === "link" && calls.length === 1 ? `<${next}>; rel="next"` : null },
            json: async () => ({ total_count: 2, check_runs: [{ id: calls.length }] }),
        };
    };
    const pages = await publicGitHubApi(endpoint, true, fetcher);
    assert.deepEqual(calls, [`https://api.github.com/${endpoint}`, next]);
    assert.deepEqual(pages.map((page) => page.check_runs[0].id), [1, 2]);
    await assert.rejects(publicGitHubApi(endpoint, true, async () => ({
        ok: true,
        headers: { get: () => '<https://example.com/checks>; rel="next"' },
        json: async () => ({ check_runs: [] }),
    })), /leave api.github.com/);
    await assert.rejects(publicGitHubApi("https://example.com/", false, fetcher), /only supports/);
});

test("branch watcher retries a changing initial CI snapshot instead of exiting", async () => {
    const head = "a".repeat(40);
    const transient = new Error("CI checks are still updating");
    transient.transient = true;
    const end = new Error("test complete");
    end.permanent = true;
    let calls = 0;
    const phases = [];
    await assert.rejects(watchBranch("dotnet/maui", "net11.0", {
        getCommit: async () => {
            if (calls > 1) throw end;
            return { sha: head };
        },
        getChecks: async () => {
            if (calls++ === 0) throw transient;
            return [{ id: 1, name: "Build", status: "in_progress" }];
        },
        retryWait: async () => {},
        wait: async () => {},
        report: (phase) => phases.push(phase),
    }), end);
    assert.equal(calls, 2);
    assert.deepEqual(phases, ["checking", "retrying", "checking", "waiting", "checking"]);
});

test("branch watcher shows CI already running on its head and alerts once when it ends", async () => {
    const head = "a".repeat(40);
    const link = "https://dev.azure.com/dnceng-public/public/_build/results?buildId=42";
    const running = { id: 1, name: "maui-pr (Build)", status: "in_progress", conclusion: null,
        details_url: link, app: { slug: "azure-pipelines" } };
    const completed = { ...running, status: "completed", conclusion: "success" };
    const snapshots = [[running], [completed], [completed]];
    const lines = [];
    const stages = [];
    const end = new Error("test complete");
    end.permanent = true;
    await assert.rejects(watchBranch("dotnet/maui", "net11.0", {
        getCommit: async () => {
            if (!snapshots.length) throw end;
            return { sha: head };
        },
        getChecks: async (sha) => {
            assert.equal(sha, head);
            return snapshots.shift();
        },
        wait: async () => {},
        emit: (line) => lines.push(line),
        report: (phase, ms, checks) => {
            if (phase === "waiting") stages.push(checks);
        },
    }), end);
    assert.deepEqual(stages.map((checks) => checks[0].state), ["running", "passed", "passed"]);
    assert.equal(stages[0][0].group, "maui-pr");
    assert.equal(stages[0][0].url, link);
    assert.deepEqual(lines, [branchChecksMessage("dotnet/maui", "net11.0", head, [completed])]);
});

test("branch watcher does not repeat completion alerts when finished check inventory changes", async () => {
    const head = "a".repeat(40);
    const running = { id: 1, name: "Build", status: "in_progress", conclusion: null };
    const passed = { ...running, status: "completed", conclusion: "success" };
    const skipped = { id: 2, name: "Skipped", status: "completed", conclusion: "skipped" };
    const late = { id: 3, name: "Late", status: "completed", conclusion: "success" };
    const snapshots = [[running, skipped], [passed, skipped], [passed], [], [passed, late]];
    const lines = [];
    const lengths = [];
    const end = new Error("test complete");
    end.permanent = true;
    await assert.rejects(watchBranch("dotnet/maui", "main", {
        getCommit: async () => {
            if (!snapshots.length) throw end;
            return { sha: head };
        },
        getChecks: async () => snapshots.shift(),
        wait: async () => {},
        emit: (line) => lines.push(line),
        report: (phase, ms, checks) => {
            if (phase === "waiting") lengths.push(checks.length);
        },
    }), end);
    assert.deepEqual(lengths, [2, 2, 1, 0, 2]);
    assert.deepEqual(lines, [branchChecksMessage("dotnet/maui", "main", head, [passed, skipped])]);
});

test("branch watcher alerts on a same-head rerun after observing active checks", async () => {
    const head = "a".repeat(40);
    const passed = { id: 1, name: "Build", status: "completed", conclusion: "success" };
    const rerun = { id: 2, name: "Build", status: "in_progress", conclusion: null };
    const completed = { ...rerun, status: "completed", conclusion: "failure" };
    const snapshots = [[passed], [rerun], [completed], [completed]];
    const lines = [];
    const end = new Error("test complete");
    end.permanent = true;
    await assert.rejects(watchBranch("dotnet/maui", "main", {
        getCommit: async () => {
            if (!snapshots.length) throw end;
            return { sha: head };
        },
        getChecks: async () => snapshots.shift(),
        wait: async () => {},
        emit: (line) => lines.push(line),
        report: () => {},
    }), end);
    assert.deepEqual(lines, [branchChecksMessage("dotnet/maui", "main", head, [completed])]);
});

test("PR watcher follows successive pushes and a selected pipeline without waiting for other checks", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const third = "c".repeat(40);
    const check = (name, bucket, id) => ({
        name, bucket, state: bucket === "pending" ? "IN_PROGRESS" : "COMPLETED",
        workflow: "", link: `https://example.com/check/${id}`,
    });
    const snapshots = [
        { sha: first, checks: [check("maui-pr", "fail", 1), check("maui-pr-uitests", "pending", 2)] },
        { sha: first, checks: [check("maui-pr", "fail", 1), check("maui-pr-uitests", "pending", 2)] },
        { sha: second, checks: [check("maui-pr", "pending", 3), check("maui-pr-uitests", "pending", 4)] },
        { sha: second, checks: [check("maui-pr", "pass", 3), check("maui-pr-uitests", "pending", 4)] },
        { sha: second, checks: [check("maui-pr", "pass", 3), check("maui-pr-uitests", "pass", 4)] },
        { sha: third, checks: [check("maui-pr", "pending", 5), check("maui-pr-uitests", "pending", 6)] },
        { sha: third, checks: [check("maui-pr", "fail", 5), check("maui-pr-uitests", "pending", 6)] },
        { sha: third, checks: [check("maui-pr", "pending", 7), check("maui-pr-uitests", "pending", 6)] },
        { sha: third, checks: [check("maui-pr", "pass", 7), check("maui-pr-uitests", "pending", 6)] },
        { sha: third, checks: [check("maui-pr", "pass", 7), check("maui-pr-uitests", "pass", 6)], state: "MERGED" },
    ];
    let index = 0;
    const lines = [];
    const phases = [];
    const url = "https://github.com/dotnet/maui/pull/42";
    const result = await watchPullRequest("dotnet/maui", "42", {
        pipeline: "maui-pr",
        getPullRequest: async () => ({
            headRefOid: snapshots[index].sha, state: snapshots[index].state ?? "OPEN", url,
        }),
        getChecks: async () => {
            assert.notEqual(snapshots[index].state, "MERGED");
            return snapshots[index].checks;
        },
        wait: async () => { index++; },
        emit: (line) => lines.push(line),
        report: (phase) => phases.push(phase),
    });
    assert.match(result, /dotnet\/maui#42 merged; watch ended/);
    assert.equal(index, snapshots.length - 1);
    assert.deepEqual(lines.map((line) => line.startsWith("CI ended:") ? "CI" : "HEAD"),
        ["CI", "HEAD", "CI", "HEAD", "CI", "CI"]);
    assert.ok(lines.filter((line) => line.startsWith("CI ended:"))
        .every((line) => line.startsWith("CI ended: maui-pr | dotnet/maui#42")));
    assert.match(lines[0], /1 failed or canceled/);
    assert.match(lines[2], /1 passed/);
    assert.match(lines[4], /1 failed or canceled/);
    assert.match(lines[5], /1 passed/);
    assert.equal(phases.at(-1), "complete");
});

test("default PR watch waits for all checks and re-arms after a new push", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const checks = (core, ui) => [
        { name: "maui-pr", bucket: core, state: core === "pending" ? "IN_PROGRESS" : "COMPLETED", workflow: "", link: "https://example.com/core" },
        { name: "maui-pr-uitests", bucket: ui, state: ui === "pending" ? "IN_PROGRESS" : "COMPLETED", workflow: "", link: "https://example.com/ui" },
    ];
    const snapshots = [
        { sha: first, checks: checks("pending", "pending") },
        { sha: first, checks: checks("pass", "pending") },
        { sha: first, checks: checks("pass", "fail") },
        { sha: first, checks: checks("pass", "fail") },
        { sha: second, checks: checks("pending", "pending") },
        { sha: second, checks: checks("pass", "pending") },
        { sha: second, checks: checks("pass", "pass") },
    ];
    let index = 0;
    const lines = [];
    const end = new Error("test complete");
    await assert.rejects(watchPullRequest("dotnet/maui", "42", {
        getPullRequest: async () => ({
            headRefOid: snapshots[index].sha, state: "OPEN", url: "https://github.com/dotnet/maui/pull/42",
        }),
        getChecks: async () => snapshots[index].checks,
        wait: async () => { if (index === snapshots.length - 1) throw end; index++; },
        emit: (line) => lines.push(line),
        report: () => {},
    }), end);
    assert.equal(lines.filter((line) => line.startsWith("CI ended:")).length, 2);
    assert.equal(lines.filter((line) => line.includes("head moved")).length, 1);
    assert.match(lines[0], /1 failed or canceled/);
    assert.match(lines[2], /2 passed, 0 failed or canceled/);
});

test("branch watcher does not alert for old CI, but tracks the next head's CI", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const complete = { id: 1, name: "Build", status: "completed", conclusion: "success" };
    const newRun = { id: 2, name: "Build", status: "completed", conclusion: "failure" };
    const snapshots = [
        { sha: first, checks: [complete] },
        { sha: first, checks: [complete] },
        { sha: second, checks: [newRun] },
        { sha: second, checks: [newRun] },
    ];
    const lines = [];
    const end = new Error("test complete");
    end.permanent = true;
    let snapshot;
    await assert.rejects(watchBranch("dotnet/maui", "net11.0", {
        getCommit: async () => {
            if (!snapshots.length) throw end;
            snapshot = snapshots.shift();
            return { sha: snapshot.sha };
        },
        getChecks: async () => snapshot.checks,
        compare: async () => ({ status: "ahead", ahead_by: 1, commits: [] }),
        wait: async () => {},
        emit: (line) => lines.push(line),
        report: () => {},
    }), end);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /net11\.0 moved aaaaaaaaaa -> bbbbbbbbbb/);
    assert.equal(lines[1], branchChecksMessage("dotnet/maui", "net11.0", second, [newRun]));
});

test("branch CI summaries distinguish failures, cancellations, warnings, and skips", () => {
    const head = "a".repeat(40);
    const checks = [
        { name: "Build", status: "completed", conclusion: "success" },
        { name: "Unit", status: "completed", conclusion: "failure" },
        { name: "Device", status: "completed", conclusion: "cancelled" },
        { name: "Lint", status: "completed", conclusion: "neutral" },
        { name: "Docs", status: "completed", conclusion: "skipped" },
    ];
    assert.equal(branchChecksMessage("dotnet/maui", "net11.0", head, checks.slice(0, 1).map((check) =>
        ({ ...check, status: "in_progress" }))), null);
    assert.match(branchChecksMessage("dotnet/maui", "net11.0", head, checks),
        /1 passed, 2 failed or canceled, 1 warning, 1 skipped\. Failed: Unit, Device\./);
});

test("Azure timeline shows every stage in pipeline order with its job progress", () => {
    const runUrl = "https://dev.azure.com/dnceng-public/public/_build/results?buildId=42";
    const timeline = { records: [
        { id: "test", type: "Stage", name: "Tests", order: 2, state: "inProgress" },
        { id: "build", type: "Stage", name: "Build", order: 1, state: "completed", result: "succeeded" },
        { id: "deploy", type: "Stage", name: "Deploy", order: 3, state: "pending" },
        { id: "p1", type: "Phase", parentId: "test" },
        { id: "p2", type: "Phase", parentId: "build" },
        { id: "j1", type: "Job", name: "Android", parentId: "p1", state: "completed", result: "failed" },
        { id: "j2", type: "Job", name: "iOS", parentId: "p1", state: "inProgress" },
        { id: "j3", type: "Job", name: "Windows", parentId: "p1", state: "pending" },
        { id: "j4", type: "Job", name: "Compile", parentId: "p2", state: "completed", result: "succeeded" },
        { id: "task", type: "Task", name: "Ignored task", parentId: "j1", state: "completed" },
    ] };
    assert.deepEqual(azureStages(timeline, runUrl), [
        { name: "Build", state: "passed", detail: "1/1 jobs finished", url: runUrl },
        { name: "Tests", state: "running", detail: "1/3 jobs finished, 1 running", url: runUrl },
        { name: "Deploy", state: "queued", url: runUrl },
    ]);
    assert.deepEqual(azureStages({ records: [{ id: "j1", type: "Job", name: "Compile", state: "completed", result: "succeeded" }] }, runUrl), [
        { name: "Compile", state: "passed", url: `${runUrl}&view=logs&jobId=j1` },
    ]);
    assert.throws(() => azureStages({}), /no records/);
});

test("Actions jobs and PR checks all appear with their live states", () => {
    const runUrl = "https://github.com/dotnet/maui/actions/runs/42";
    assert.deepEqual(actionStages({ url: runUrl, jobs: [
        { name: "compile", url: `${runUrl}/job/1`, status: "completed", conclusion: "success", steps: [{ status: "completed" }] },
        { name: "test", status: "in_progress", steps: [{ status: "completed" }, { status: "in_progress" }] },
        { name: "publish", status: "queued" },
    ] }), [
        { name: "compile", state: "passed", detail: "1/1 steps finished", url: `${runUrl}/job/1` },
        { name: "test", state: "running", detail: "1/2 steps finished", url: runUrl },
        { name: "publish", state: "queued", url: runUrl },
    ]);
    assert.deepEqual(checkStages([
        { name: "UI tests", workflow: "Validate", state: "IN_PROGRESS", bucket: "pending", link: `${runUrl}/job/2` },
        { name: "Build", workflow: "Compile", state: "SUCCESS", bucket: "pass", link: `${runUrl}/job/1` },
        { name: "Security", workflow: "", state: "FAILURE", bucket: "fail" },
        { name: "Integration", workflow: "Validate", state: "EXPECTED", bucket: "pending" },
    ]), [
        { name: "Build", state: "passed", group: "Compile", url: `${runUrl}/job/1` },
        { name: "Security", state: "failed", group: "Other checks" },
        { name: "Integration", state: "queued", group: "Validate" },
        { name: "UI tests", state: "running", group: "Validate", url: `${runUrl}/job/2` },
    ]);
});

test("Azure PR checks group their pipeline jobs while retaining every run link", () => {
    const run = "https://dev.azure.com/dnceng-public/public/_build/results?buildId=42";
    assert.deepEqual(checkStages([
        { name: "maui-pr-uitests (Windows)", link: `${run}&view=logs&jobId=1`, bucket: "pending", state: "IN_PROGRESS" },
        { name: "maui-pr", link: run, bucket: "pending", state: "PENDING" },
        { name: "maui-pr-uitests", link: run, bucket: "pending", state: "PENDING" },
        { name: "maui-pr (Pack)", link: `${run}&view=logs&jobId=2`, bucket: "pass", state: "SUCCESS" },
    ]), [
        { name: "maui-pr", state: "queued", group: "maui-pr", url: run },
        { name: "maui-pr (Pack)", state: "passed", group: "maui-pr", url: `${run}&view=logs&jobId=2` },
        { name: "maui-pr-uitests", state: "queued", group: "maui-pr-uitests", url: run },
        { name: "maui-pr-uitests (Windows)", state: "running", group: "maui-pr-uitests", url: `${run}&view=logs&jobId=1` },
    ]);
});

test("watcher messages wait for completion and name failures", () => {
    assert.equal(checksMessage("PR #1", []), null);
    assert.equal(checksMessage("PR #1", [{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }]), null);
    assert.equal(
        checksMessage("PR #1", [{ name: "a", bucket: "pass" }, { name: "b", bucket: "fail" }, { name: "c", bucket: "skipping" }]),
        "CI ended: PR #1 checks finished: 1 passed, 1 failed or canceled, 1 skipped. Failed: b.");

    assert.equal(runMessage({ status: "in_progress" }), null);
    assert.equal(
        runMessage({ status: "completed", conclusion: "failure", workflowName: "CI", displayTitle: "CI", url: "u", jobs: [{ name: "build", conclusion: "failure" }] }),
        'CI ended: GitHub Actions run "CI" finished: failure. Failed jobs: build. u');

    assert.equal(buildMessage({ status: "inProgress" }, null, "u"), null);
    assert.equal(
        buildMessage({ id: 7, status: "completed", result: "failed", definition: { name: "maui-pr" } },
            { records: [{ type: "Job", result: "failed", name: "Unit" }, { type: "Task", result: "failed", name: "step" }] }, "u"),
        "CI ended: Azure DevOps build 7 (maui-pr) finished: failed. Failed jobs: Unit. u");
});
