import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBuilds, snapshot, watch } from "./watch-maui-branch-ci.mjs";

test("MAUI Azure builds must match the branch and head, choosing the newest matching attempt", () => {
    const sha = "a".repeat(40);
    const build = (id, definitionId, branch = "inflight/current", version = sha, queueTime = "2026-09-28T10:00:00Z") => ({
        id, definition: { id: definitionId }, sourceBranch: `refs/heads/${branch}`, sourceVersion: version, queueTime,
    });
    const selected = selectBuilds([
        build(1, 302),
        build(2, 302, "inflight/current", sha, "2026-09-28T11:00:00Z"),
        { ...build(3, 302), sourceBranch: "refs/pull/42/merge" },
        build(4, 313, "inflight/current", "b".repeat(40)),
        build(5, 313),
        build(6, 314),
    ], "inflight/current", sha);
    assert.deepEqual(selected.map(({ name, build: match }) => [name, match?.id]), [
        ["maui-pr", 2],
        ["maui-pr-uitests", 5],
        ["maui-pr-devicetests", 6],
    ]);
    assert.deepEqual(selectBuilds([build(3, 302, "release/11.0.1xx-rc2")], "inflight/current", sha)
        .map(({ build: match }) => match?.id), [undefined, undefined, undefined]);
});

test("unsupported branches are rejected before querying GitHub or Azure", async () => {
    await assert.rejects(snapshot("release/unknown"), /Unsupported branch/);
});

test("the five MAUI branch names accept the same Azure-only watcher", async () => {
    const end = new Error("test complete");
    for (const branch of ["main", "net11.0", "release/11.0.1xx-rc2", "inflight/current", "inflight/candidate"]) {
        await assert.rejects(watch(branch, {
            readSnapshot: async (selectedBranch) => {
                assert.equal(selectedBranch, branch);
                return { sha: "a".repeat(40), builds: [], complete: false, key: "none", stages: [] };
            },
            wait: async () => { throw end; },
            emit: () => {},
            report: () => {},
        }), end);
    }
});

test("selected MAUI pipeline ends trigger each fix-push-rerun cycle before other pipelines finish", async () => {
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const third = "c".repeat(40);
    const names = ["maui-pr", "maui-pr-uitests", "maui-pr-devicetests"];
    const observation = (sha, core, ui = "queued", device = "queued", coreId = 1) => {
        const builds = [core, ui, device].map((state, index) => ({
            id: index === 0 ? coreId : index + 1,
            name: names[index], state, url: `https://example.com/build/${index + 1}`,
        }));
        return { sha, builds, complete: builds.every((build) => !["running", "queued"].includes(build.state)),
            key: JSON.stringify(builds.map((build) => [build.id, build.state])), stages: [] };
    };
    const snapshots = [
        observation(first, "failed", "passed", "passed"),
        observation(second, "queued"),
        observation(second, "failed"),
        observation(second, "failed", "passed"),
        observation(third, "queued"),
        observation(third, "passed"),
        observation(third, "passed", "passed"),
        observation(third, "running", "queued", "queued", 8),
        observation(third, "passed", "queued", "queued", 8),
    ];
    let index = 0;
    const lines = [];
    const end = new Error("test complete");
    await assert.rejects(watch("release/11.0.1xx-rc2", {
        notifyPipelines: ["maui-pr"],
        readSnapshot: async () => snapshots[index],
        wait: async () => { if (index === snapshots.length - 1) throw end; index++; },
        emit: (line) => lines.push(line),
        report: () => {},
    }), end);
    assert.equal(lines.filter((line) => line.startsWith("Azure branch CI finished: maui-pr |")).length, 3);
    assert.equal(lines.filter((line) => line.includes(" moved ")).length, 2);
    assert.ok(lines.some((line) => line.includes(`${second.slice(0, 10)}): failed`)));
    assert.ok(lines.some((line) => line.includes(`${third.slice(0, 10)}): passed`)));
    assert.equal(lines.length, 5);
});

test("default MAUI watch waits for all pipelines", async () => {
    const sha = "a".repeat(40);
    const build = (name, state) => ({ name, id: 1, state, url: "https://example.com/build/1" });
    const snapshots = [
        { sha, builds: [], complete: false, key: "queued", stages: [] },
        { sha, builds: [build("maui-pr", "passed")], complete: false, key: "partial", stages: [] },
        { sha, builds: [build("maui-pr", "passed"), build("maui-pr-uitests", "passed"),
            build("maui-pr-devicetests", "failed")], complete: true, key: "done", stages: [] },
    ];
    let index = 0;
    const lines = [];
    const end = new Error("test complete");
    await assert.rejects(watch("inflight/current", {
        readSnapshot: async () => snapshots[index],
        wait: async () => { if (index === snapshots.length - 1) throw end; index++; },
        emit: (line) => lines.push(line),
        report: () => {},
    }), end);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Azure branch CI finished: dotnet\/maui inflight\/current/);
});
