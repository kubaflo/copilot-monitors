import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBuilds, snapshot } from "./watch-maui-branch-ci.mjs";

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
