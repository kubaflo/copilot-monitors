import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMonitorManager } from "./monitors.mjs";
import { PROGRESS_PREFIX } from "./progress.mjs";

async function until(predicate) {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for fixture progress.");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const terminal = [
    { name: "Unit", group: "maui-pr - Azure jobs", state: "passed", url: "https://example.com/build/1" },
    { name: "UI", group: "maui-pr-uitests - Azure jobs", state: "failed", detail: "38 failed jobs" },
    { name: "Device", group: "maui-pr-devicetests - Azure jobs", state: "canceled" },
];

async function watchFixture(t, options = {}, stages = terminal) {
    const directory = await mkdtemp(join(tmpdir(), "completed-follow-up-"));
    const progressFile = join(directory, "progress.json");
    const outputFile = join(directory, "output.txt");
    const messages = [];
    const logs = [];
    let failSend = false;
    let sendGate;
    let releaseSend;
    const manager = createMonitorManager({
        workingDirectory: async () => directory,
        send: async (notification) => {
            if (sendGate) await sendGate;
            if (failSend) throw new Error("Delivery unavailable");
            messages.push(notification);
        },
        log: async (message) => logs.push(message),
        batchMs: 20,
    });
    await writeFile(progressFile, JSON.stringify({ phase: "waiting", intervalMs: 300_000, stages }));
    await writeFile(outputFile, "");
    const source = `
        const fs = require("node:fs");
        let previous = "";
        setInterval(() => {
            const progress = fs.readFileSync(${JSON.stringify(progressFile)}, "utf8");
            process.stderr.write(${JSON.stringify(PROGRESS_PREFIX)} + progress + "\\n");
            const output = fs.readFileSync(${JSON.stringify(outputFile)}, "utf8");
            if (output !== previous) { previous = output; process.stdout.write(output); }
        }, 40);
    `.replaceAll("\n", " ");
    const input = {
        description: "inflight/candidate - Azure branch CI",
        command: `node -e ${JSON.stringify(source)}`,
        continuous: true, progress: true, followUpOnOutput: true,
        followUpOnOutputPrefix: "Azure branch CI finished:",
        ...options,
    };
    const monitor = await manager.start(input);
    t.after(async () => {
        releaseSend?.();
        manager.dispose();
        await rm(directory, { recursive: true, force: true });
    });
    await until(() => manager.list()[0].checks > 0);
    return {
        manager, monitor, messages, logs, input,
        failSend(value) { failSend = value; },
        holdSend() { sendGate = new Promise((resolve) => { releaseSend = resolve; }); },
        releaseSend() { releaseSend(); sendGate = null; },
        async progress(stages, phase = "waiting") {
            const checks = manager.list()[0].checks;
            await writeFile(progressFile, JSON.stringify({ phase, intervalMs: 300_000, stages }));
            await until(() => manager.list()[0].checks > checks && manager.list()[0].phase === phase);
        },
        async output(line) {
            await writeFile(outputFile, `${line}\n`);
            await until(() => manager.list()[0].output.includes(line));
            await new Promise((resolve) => setTimeout(resolve, 60));
        },
    };
}

test("explicit Save of the unchanged startup prompt dispatches custom completed CI exactly once", async (t) => {
    const screenshot = [
        ...Array.from({ length: 152 }, (_, index) => ({ name: `UI ${index}`, state: "passed", group: "maui-pr-uitests - Azure jobs" })),
        ...Array.from({ length: 38 }, (_, index) => ({ name: `Failed UI ${index}`, state: "failed", group: "maui-pr-uitests - Azure jobs" })),
        ...Array.from({ length: 3 }, (_, index) => ({ name: `Canceled UI ${index}`, state: "canceled", group: "maui-pr-uitests - Azure jobs" })),
        ...Array.from({ length: 31 }, (_, index) => ({ name: `Unit ${index}`, state: "passed", group: "maui-pr - Azure jobs" })),
        { name: "Unit", state: "failed", group: "maui-pr - Azure jobs" },
        ...Array.from({ length: 3 }, (_, index) => ({ name: `Device ${index}`, state: "passed", group: "maui-pr-devicetests - Azure jobs" })),
        ...Array.from({ length: 5 }, (_, index) => ({ name: `Failed device ${index}`, state: "failed", group: "maui-pr-devicetests - Azure jobs" })),
    ];
    const f = await watchFixture(t, { followUpPrompt: "Inspect failed CI" }, screenshot);
    assert.equal(f.messages.length, 0);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect failed CI")).followUpQueued, true);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].source, "system");
    assert.match(f.messages[0].displayPrompt, /CI finished.*\nCustom prompt: Inspect failed CI/);
    assert.match(f.messages[0].prompt, /233 current checks have completed/);
    assert.match(f.messages[0].prompt, /Results: 186 passed, 44 failed, 3 canceled/);
    assert.match(f.messages[0].prompt, /still running/);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect failed CI")).followUpQueued, false);
    await f.progress(screenshot);
    await f.output("Azure branch CI finished: redundant completion");
    assert.equal(f.messages.length, 1);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Explain cancellations")).followUpQueued, true);
    assert.equal(f.messages.length, 2);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "")).followUpQueued, false);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect failed CI")).followUpQueued, false);
});

test("custom Save requires a complete known inventory and a healthy polling phase", async (t) => {
    const f = await watchFixture(t);
    for (const stages of [
        [], [{ name: "Pending", state: "queued" }], [{ name: "Pending", state: "running" }],
        [{ name: "Unknown", state: "unknown" }],
        [{ name: "Missing", state: "failed", group: "maui-pr - pending job inventory" }],
    ]) {
        await f.progress(stages);
        assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
    }
    await f.progress(terminal, "retrying");
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
    await f.progress(terminal);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, true);
    f.manager.stop(f.monitor.id);
    await assert.rejects(f.manager.setFollowUp(f.monitor.id, "Inspect CI"), /Only running/);
});

test("new cycles are eligible and future live completion still respects pipeline prefixes", async (t) => {
    const f = await watchFixture(t, { followUpOnOutputPrefix: "Azure branch CI finished: maui-pr |" });
    await f.manager.setFollowUp(f.monitor.id, "Inspect CI");
    await f.progress([{ name: "Unit", state: "running" }]);
    await f.output("Azure branch CI finished: maui-pr-uitests | failed");
    assert.equal(f.messages.at(-1).source, undefined);
    await f.output("Azure branch CI finished: maui-pr | failed");
    assert.equal(f.messages.at(-1).source, "system");
    const before = f.messages.length;
    await f.output("branch changed");
    await f.output("Azure branch CI finished: maui-pr | failed");
    assert.equal(f.messages.length, before + 1);
    await f.progress(terminal);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, true);
    await f.progress(terminal.map((stage) => ({ ...stage, url: "https://example.com/build/2" })));
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, true);
});

test("failed dispatch is explicit, preserves the prompt, and can be retried once", async (t) => {
    const f = await watchFixture(t);
    f.failSend(true);
    await assert.rejects(f.manager.setFollowUp(f.monitor.id, "Inspect CI"), /Delivery unavailable/);
    assert.equal(f.manager.list()[0].followUpPrompt, "Inspect CI");
    assert.equal(f.manager.list()[0].notifications, 0);
    assert.equal(f.messages.length, 0);
    await until(() => f.logs.length === 1);
    f.failSend(false);
    const results = await Promise.all([
        f.manager.setFollowUp(f.monitor.id, "Inspect CI"),
        f.manager.setFollowUp(f.monitor.id, "Inspect CI"),
    ]);
    assert.ok(results.every((result) => result.followUpQueued));
    assert.equal(f.messages.length, 1);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
});

test("built-in completed initial checks still dispatch automatically and Save does not duplicate", async (t) => {
    const f = await watchFixture(t, {
        followUpOnCurrentComplete: true, followUpOnOutputPrefix: "CI ended:", followUpPrompt: "Inspect CI",
    });
    await until(() => f.messages.length === 1);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
    await f.progress([{ name: "Unit", state: "running" }]);
    await f.progress(terminal);
    await f.output("CI ended: next cycle failed");
    assert.equal(f.messages.length, 2);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
});

test("Save racing a live terminal event shares the same pending delivery in either order", async (t) => {
    for (const saveFirst of [true, false]) {
        const f = await watchFixture(t, { followUpPrompt: "Inspect CI" });
        f.holdSend();
        let saved;
        if (saveFirst) {
            saved = f.manager.setFollowUp(f.monitor.id, "Inspect CI");
            await f.output("Azure branch CI finished: all builds failed");
        } else {
            await f.output("Azure branch CI finished: all builds failed");
            saved = f.manager.setFollowUp(f.monitor.id, "Inspect CI");
        }
        assert.equal(f.messages.length, 0);
        f.releaseSend();
        assert.equal((await saved).followUpQueued, true);
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(f.messages.length, 1);
        f.manager.stop(f.monitor.id);
    }
});

test("terminal CI progress does not make a failed watcher eligible", async (t) => {
    const progress = `${PROGRESS_PREFIX}${JSON.stringify({ phase: "waiting", intervalMs: 300_000, stages: terminal })}`;
    const f = await watchFixture(t, { command: `printf '%s\\n' '${progress}' >&2; exit 2` });
    await until(() => f.manager.list()[0].status === "failed");
    await assert.rejects(f.manager.setFollowUp(f.monitor.id, "Inspect CI"), /Only running/);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].source, undefined);
});

test("duplicate live terminal events do not consume the notification noise budget", async (t) => {
    const f = await watchFixture(t, { followUpPrompt: "Inspect CI" });
    const line = "Azure branch CI finished: all jobs failed";
    await f.output(line);
    assert.equal(f.messages.length, 1);
    for (let repeat = 2; repeat <= 13; repeat += 1) {
        await f.output(Array(repeat).fill(line).join("\n"));
    }
    assert.equal(f.manager.list()[0].status, "running");
    assert.equal(f.manager.list()[0].notifications, 1);
    assert.equal(f.messages.length, 1);
    assert.equal((await f.manager.setFollowUp(f.monitor.id, "Inspect CI")).followUpQueued, false);
});
