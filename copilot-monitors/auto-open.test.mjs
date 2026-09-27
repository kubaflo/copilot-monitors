import assert from "node:assert/strict";
import { test } from "node:test";
import { isWatchRequest, openWatchCanvas } from "./auto-open.mjs";

test("explicit monitor requests open Live Watches", () => {
    for (const prompt of [
        "monitor",
        "Monitor https://github.com/dotnet/maui/pull/38919/checks",
        "/monitor #38919",
        "Watch: https://github.com/dotnet/maui/commits/main",
        "watch https://github.com/dotnet/maui/commits/main",
    ]) {
        assert.equal(isWatchRequest(prompt), true, prompt);
    }
});

test("questions and monitor notifications do not open Live Watches", () => {
    for (const prompt of [
        "What about net11?",
        "How does the monitor tool work?",
        "monitoring plans",
        'Monitor "CI" [deadbeef] exited with code 0.',
        'Monitor "CI" [deadbeef] printed new output.',
    ]) {
        assert.equal(isWatchRequest(prompt), false, prompt);
    }
});

test("opens a new canvas and focuses an existing instance without duplicating it", async () => {
    const opened = [];
    const session = {
        openCanvases: [],
        rpc: { canvas: { open: async (params) => { opened.push(params); } } },
    };
    await openWatchCanvas(session);
    assert.deepEqual(opened, [{ canvasId: "copilot-monitors", instanceId: "monitor-dashboard" }]);

    session.openCanvases = [{ canvasId: "copilot-monitors", instanceId: "existing-panel" }];
    await openWatchCanvas(session, { onlyWhenClosed: true });
    assert.equal(opened.length, 1);
    await openWatchCanvas(session);
    assert.deepEqual(opened[1], { canvasId: "copilot-monitors", instanceId: "existing-panel" });
});

test("reports canvas opening failures to callers", async () => {
    const failure = new Error("Canvas unavailable");
    const session = {
        openCanvases: [],
        rpc: { canvas: { open: async () => { throw failure; } } },
    };
    await assert.rejects(openWatchCanvas(session), failure);
});
