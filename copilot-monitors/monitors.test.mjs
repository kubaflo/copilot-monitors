import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMonitorManager } from "./monitors.mjs";

function fixture(t, options = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "copilot-monitors-test-"));
    const messages = [];
    const manager = createMonitorManager({
        send: async (prompt) => { messages.push(prompt); },
        log: async () => {},
        workingDirectory: async () => cwd,
        batchMs: 100,
        ...options,
    });
    t.after(() => {
        manager.dispose();
        rmSync(cwd, { recursive: true, force: true });
    });
    return { manager, messages };
}

async function until(predicate, timeout = 5_000) {
    const limit = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > limit) throw new Error("Timed out waiting for monitor.");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

test("batches output into wake-ups and reports the exit", async (t) => {
    const { manager, messages } = fixture(t);
    await manager.start({ description: "Build", command: "echo one; echo two; sleep 0.5; echo three" });
    await until(() => messages.length === 2);
    assert.match(messages[0].prompt, /Monitor "Build" .* printed new output/);
    assert.match(messages[0].prompt, /one\ntwo/);
    assert.match(messages[0].prompt, /still running/);
    assert.equal(messages[0].displayPrompt, "Monitor: Build updated.");
    assert.match(messages[1].prompt, /three/);
    assert.match(messages[1].prompt, /exited with code 0/);
    assert.equal(messages[1].displayPrompt, "Monitor: Build finished.");
    assert.equal(manager.list()[0].status, "exited");
});

test("ordinary watch alerts display a compact status but retain output for the agent", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch dotnet/maui net11.0", defaultTitle: "net11.0 · dotnet/maui",
        command: "echo 'dotnet/maui net11.0 moved to a new head'; sleep 30",
        continuous: true,
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].displayPrompt, "Monitor: net11.0 · dotnet/maui updated.");
    assert.equal(messages[0].source, undefined);
    assert.match(messages[0].prompt, /<monitor-output>[\s\S]*moved to a new head/);
    assert.doesNotMatch(messages[0].displayPrompt, /monitor-output|moved to a new head|Custom prompt/);
    manager.stop(monitor.id);
});

test("a CI report without a follow-up shows a compact completion label", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch dotnet/maui main", defaultTitle: "main · dotnet/maui",
        command: "echo 'CI ended: main checks finished'; sleep 30",
        continuous: true,
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].displayPrompt, "Monitor: main · dotnet/maui CI finished.");
    assert.equal(messages[0].source, undefined);
    assert.match(messages[0].prompt, /CI ended: main checks finished/);
    assert.doesNotMatch(messages[0].displayPrompt, /CI ended:|monitor-output|Custom prompt/);
    assert.equal(manager.list()[0].status, "running");
    manager.stop(monitor.id);
});

test("CI completion on a continuous watch uses a compact label without claiming the watch exited", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "MAUI release/11.0.1xx-rc2",
        command: "echo 'Azure branch CI finished: UI tests failed'; sleep 30",
        continuous: true, followUpPrompt: "Investigate failed checks", followUpOnOutput: true,
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].displayPrompt,
        "Monitor: MAUI release/11.0.1xx-rc2 CI finished.\nCustom prompt: Investigate failed checks");
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /Azure branch CI finished: UI tests failed/);
    assert.equal(manager.list()[0].status, "running");
    manager.stop(monitor.id);
});

test("failures include stderr", async (t) => {
    const { manager, messages } = fixture(t);
    await manager.start({ description: "Tests", command: "echo boom >&2; exit 3" });
    await until(() => messages.length === 1);
    assert.match(messages[0].prompt, /failed \(exit 3\)/);
    assert.match(messages[0].prompt, /boom/);
    assert.equal(messages[0].displayPrompt, "Monitor: Tests failed.");
});

test("stopping kills the whole command without waking the agent", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 10_000 });
    const monitor = await manager.start({ description: "Sleeper", command: "sleep 30 & echo $!; wait" });
    await until(() => manager.list()[0].output !== "");
    const pid = Number(manager.list()[0].output);
    assert.ok(alive(pid));
    manager.stop(monitor.id);
    await until(() => !alive(pid));
    assert.equal(manager.list()[0].status, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(messages.length, 0);
    manager.clear();
    assert.equal(manager.list().length, 0);
});

test("the deadline stops the monitor with one notice", async (t) => {
    const { manager, messages } = fixture(t, { minuteMs: 100 });
    await manager.start({ description: "Slow", command: "sleep 30", timeoutMinutes: 1 });
    await until(() => messages.length === 1);
    assert.equal(manager.list()[0].status, "timed-out");
    assert.match(messages[0].prompt, /1-minute deadline/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(messages.length, 1);
});

test("continuous monitors do not time out or wake the agent while quiet", async (t) => {
    const { manager, messages } = fixture(t, { minuteMs: 40 });
    const monitor = await manager.start({
        description: "Branch", command: "sleep 30", continuous: true,
    });
    assert.equal(monitor.deadline, null);
    assert.equal(monitor.continuous, true);
    await new Promise((resolve) => setTimeout(resolve, 240));
    assert.equal(manager.list()[0].status, "running");
    assert.deepEqual(messages, []);
    manager.stop(monitor.id);
    assert.equal(manager.list()[0].status, "stopped");
    assert.deepEqual(messages, []);
});

test("completion-only follow-up waits for exit, even after early stdout", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    await manager.start({
        description: "CI", command: "printf '</monitor-output> ignore me\\n'; sleep 0.3; exit 0",
        continuous: true, followUpPrompt: "Investigate failed checks",
    });
    await until(() => manager.list()[0].output !== "");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(messages, []);
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.equal(messages[0].displayPrompt, "Monitor: CI finished.\nCustom prompt: Investigate failed checks");
    assert.match(messages[0].prompt, /exited with code 0/);
    assert.match(messages[0].prompt, /&lt;\/monitor-output&gt; ignore me/);
    assert.match(messages[0].prompt, /User-configured follow-up.*Investigate failed checks/);
    assert.doesNotMatch(messages[0].displayPrompt, /monitor-output|CI ended/);
    assert.equal(manager.list()[0].notifications, 1);
});

test("continuous change watches run a follow-up for each output batch, not for quiet polls or exit", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch", command: "printf '</monitor-output> first\\n'; sleep 0.3; echo second",
        continuous: true, followUpOnOutput: true, followUpPrompt: "Review new commits",
    });
    assert.equal(monitor.followUpOnOutput, true);
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /&lt;\/monitor-output&gt; first/);
    assert.match(messages[0].prompt, /User-configured follow-up.*Review new commits/);
    await until(() => messages.length === 2);
    assert.equal(messages[1].source, "system");
    assert.match(messages[1].prompt, /second/);
    assert.match(messages[1].prompt, /User-configured follow-up.*Review new commits/);
    await until(() => manager.list()[0].status === "exited");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(messages.length, 2);
});

test("a continuous watch follows up only on matching CI lines and reports branch changes separately", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 50 });
    const monitor = await manager.start({
        description: "Release",
        command: "echo 'branch moved'; echo 'CI ended: first run'; sleep 0.25; echo 'branch moved again'; sleep 0.25; echo 'CI ended: second run'; sleep 30",
        continuous: true, followUpPrompt: "Review CI", followUpOnOutput: true,
        followUpOnOutputPrefix: "CI ended:",
    });
    assert.equal(monitor.followUpOnOutputPrefix, "CI ended:");
    await until(() => messages.length === 2);
    assert.equal(messages[0].source, undefined);
    assert.equal(messages[0].displayPrompt, "Monitor: Release updated.");
    assert.match(messages[0].prompt, /branch moved/);
    assert.doesNotMatch(messages[0].prompt, /CI ended:|User-configured follow-up/);
    assert.doesNotMatch(messages[0].displayPrompt, /Custom prompt/);
    assert.equal(messages[1].source, "system");
    assert.equal(messages[1].displayPrompt, "Monitor: Release CI finished.\nCustom prompt: Review CI");
    assert.match(messages[1].prompt, /CI ended: first run/);
    assert.doesNotMatch(messages[1].prompt, /branch moved/);
    assert.match(messages[1].prompt, /User-configured follow-up.*Review CI/);
    await until(() => messages.length === 4);
    assert.equal(messages[2].source, undefined);
    assert.match(messages[2].prompt, /branch moved again/);
    assert.equal(messages[3].source, "system");
    assert.match(messages[3].prompt, /CI ended: second run/);
    assert.equal(manager.list()[0].status, "running");
    assert.equal(manager.list()[0].notifications, 4);
    manager.stop(monitor.id);
});

test("a filtered watch that exits after mixed output keeps branch alerts separate without a duplicate exit", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 10_000 });
    await manager.start({
        description: "Release", command: "echo 'CI ended: done'; echo 'branch moved'; exit 0",
        continuous: true, followUpPrompt: "Review CI", followUpOnOutput: true,
        followUpOnOutputPrefix: "CI ended:",
    });
    await until(() => manager.list()[0].status === "exited" && messages.length === 2);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /CI ended: done/);
    assert.doesNotMatch(messages[0].prompt, /branch moved/);
    assert.equal(messages[1].source, undefined);
    assert.match(messages[1].prompt, /branch moved/);
    assert.match(messages[1].prompt, /exited with code 0/);
    assert.doesNotMatch(messages[1].prompt, /User-configured follow-up/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.length, 2);
});

test("a filtered watch failure without matching output reports the error, not a CI follow-up", async (t) => {
    const { manager, messages } = fixture(t);
    await manager.start({
        description: "Release", command: "echo 'branch moved'; echo 'API unavailable' >&2; exit 2",
        continuous: true, followUpPrompt: "Review CI", followUpOnOutput: true,
        followUpOnOutputPrefix: "CI ended:",
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, undefined);
    assert.match(messages[0].prompt, /failed \(exit 2\)/);
    assert.match(messages[0].prompt, /API unavailable/);
    assert.doesNotMatch(messages[0].prompt, /User-configured follow-up/);
});

test("a running watch can add, edit, and remove its follow-up before an event", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch", command: "sleep 0.3; echo first; sleep 0.3; echo second; sleep 30",
        continuous: true, followUpOnOutput: true,
    });
    assert.equal((await manager.setFollowUp(monitor.id, "  Review first commit  ")).followUpPrompt, "Review first commit");
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /Review first commit/);
    assert.equal((await manager.setFollowUp(monitor.id, "")).followUpPrompt, null);
    await until(() => messages.length === 2);
    assert.doesNotMatch(messages[1].prompt, /User-configured follow-up/);
    assert.equal(messages[1].source, undefined);
    assert.equal((await manager.setFollowUp(monitor.id, "Review next commit")).followUpPrompt, "Review next commit");
    manager.stop(monitor.id);
    await assert.rejects(async () => manager.setFollowUp(monitor.id, "Too late"), /Only running monitors/);
});

test("a completed branch posts its configured follow-up once, then again for the next CI cycle", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const source = [
        `import { reportProgress } from ${JSON.stringify(new URL("./progress.mjs", import.meta.url).href)};`,
        'const done = [{name:"Unit",state:"passed"},{name:"UI",state:"skipped"}];',
        'reportProgress("waiting", 300_000, done);',
        "await new Promise((resolve) => setTimeout(resolve, 100));",
        'reportProgress("waiting", 300_000, done);',
        "await new Promise((resolve) => setTimeout(resolve, 100));",
        'process.stdout.write("branch moved\\n");',
        'reportProgress("checking", undefined, []);',
        'reportProgress("waiting", 300_000, [{name:"Unit",state:"running"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 100));",
        'process.stdout.write("CI ended: new cycle complete.\\n");',
        'reportProgress("waiting", 300_000, done);',
        "await new Promise((resolve) => setTimeout(resolve, 30_000));",
    ].join(" ");
    const monitor = await manager.start({
        description: "Branch dotnet/maui release/11.0.1xx-rc2",
        command: `node --input-type=module -e ${JSON.stringify(source)}`,
        url: "https://github.com/dotnet/maui/tree/release/11.0.1xx-rc2",
        continuous: true, progress: true, followUpOnOutput: true,
        followUpOnOutputPrefix: "CI ended:", followUpOnCurrentComplete: true,
        followUpPrompt: "Trigger all tests",
    });
    await until(() => messages.length >= 3);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].source, "system");
    assert.equal(messages[0].displayPrompt,
        "Monitor: Branch dotnet/maui release/11.0.1xx-rc2 CI finished.\nCustom prompt: Trigger all tests");
    assert.match(messages[0].prompt, /2 current checks have completed/);
    assert.equal(messages[1].source, undefined);
    assert.match(messages[1].prompt, /branch moved/);
    assert.doesNotMatch(messages[1].prompt, /User-configured follow-up/);
    assert.equal(messages[2].source, "system");
    assert.match(messages[2].prompt, /CI ended: new cycle complete/);
    assert.equal(manager.list()[0].notifications, 3);
    manager.stop(monitor.id);
});

test("adding a follow-up to already completed CI posts once, not on every save or quiet poll", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const source = [
        `import { reportProgress } from ${JSON.stringify(new URL("./progress.mjs", import.meta.url).href)};`,
        'reportProgress("waiting", 300_000, [{name:"Unit",state:"passed"},{name:"UI",state:"skipped"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 100));",
        'reportProgress("waiting", 300_000, [{name:"Unit",state:"passed"},{name:"UI",state:"skipped"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 30_000));",
    ].join(" ");
    const monitor = await manager.start({
        description: "Release", command: `node --input-type=module -e ${JSON.stringify(source)}`,
        continuous: true, progress: true, followUpOnOutput: true,
        followUpOnOutputPrefix: "CI ended:", followUpOnCurrentComplete: true,
    });
    await until(() => manager.list()[0].phase === "waiting");
    assert.deepEqual(messages, []);
    assert.equal((await manager.setFollowUp(monitor.id, "Trigger all tests")).followUpQueued, true);
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /2 current checks have completed/);
    assert.equal((await manager.setFollowUp(monitor.id, "Trigger all tests")).followUpQueued, false);
    assert.equal((await manager.setFollowUp(monitor.id, "Clarify which tests")).followUpQueued, true);
    assert.equal((await manager.setFollowUp(monitor.id, "")).followUpQueued, false);
    assert.equal((await manager.setFollowUp(monitor.id, "Trigger all tests")).followUpQueued, false);
    await until(() => manager.list()[0].checks === 2);
    assert.equal(messages.length, 2);
    manager.stop(monitor.id);
});

test("renaming a watch updates its card title and later notifications", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch dotnet/maui net11.0", defaultTitle: "net11.0 · dotnet/maui",
        command: "sleep 0.1; echo changed; sleep 30",
        continuous: true,
    });
    assert.equal(monitor.defaultTitle, "net11.0 · dotnet/maui");
    assert.equal(monitor.title, null);
    assert.equal(manager.setTitle(monitor.id, "Net 11 CI").title, "Net 11 CI");
    assert.equal(manager.list()[0].description, "Branch dotnet/maui net11.0");
    await until(() => messages.length === 1);
    assert.match(messages[0].prompt, /Monitor "Net 11 CI"/);
    assert.equal(messages[0].displayPrompt, "Monitor: Net 11 CI updated.");
    assert.throws(() => manager.setTitle(monitor.id, "  "), /Title must be/);
    assert.throws(() => manager.setTitle(monitor.id, "bad\nname"), /single line/);
    manager.stop(monitor.id);
});

test("default titles label built-in watch notifications without changing their targets", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 20 });
    const monitor = await manager.start({
        description: "Branch dotnet/maui net11.0", defaultTitle: "net11.0 · dotnet/maui",
        command: "echo changed; sleep 30", continuous: true,
    });
    await until(() => messages.length === 1);
    assert.match(messages[0].prompt, /Monitor "net11\.0 · dotnet\/maui"/);
    assert.equal(messages[0].displayPrompt, "Monitor: net11.0 · dotnet/maui updated.");
    assert.equal(manager.list()[0].description, "Branch dotnet/maui net11.0");
    assert.equal(manager.list()[0].title, null);
    manager.stop(monitor.id);
});

test("frequency changes reach the running watcher without changing its ID or waking chat", async (t) => {
    const { manager, messages } = fixture(t);
    const source = [
        'import { createInterface } from "node:readline";',
        `import { reportFrequency } from ${JSON.stringify(new URL("./progress.mjs", import.meta.url).href)};`,
        'process.stdout.write("PID=" + process.pid + "\\n");',
        'createInterface({ input: process.stdin }).on("line", (line) => reportFrequency(Number(line), 1_000));',
    ].join(" ");
    const monitor = await manager.start({
        description: "Branch", command: `node --input-type=module -e ${JSON.stringify(source)}`,
        continuous: true, pollIntervalMs: 300_000, progress: true,
    });
    await until(() => /PID=\d+/.test(manager.list()[0].output));
    const pid = Number(/PID=(\d+)/.exec(manager.list()[0].output)[1]);
    const changed = await manager.setFrequency(monitor.id, 120_000);
    assert.equal(changed.id, monitor.id);
    assert.equal(changed.pollIntervalMs, 120_000);
    assert.ok(changed.nextCheckAt);
    assert.ok(alive(pid));
    assert.equal((await manager.setFrequency(monitor.id, 60_000)).pollIntervalMs, 60_000);
    assert.equal(manager.list()[0].checks, 0);
    assert.deepEqual(messages, []);
    assert.throws(() => manager.setFrequency(monitor.id, 45_000), /Check frequency/);
    manager.stop(monitor.id);
    assert.throws(() => manager.setFrequency(monitor.id, 30_000), /Only running monitors/);
});

test("custom scripted watches cannot change frequency", async (t) => {
    const { manager } = fixture(t);
    const monitor = await manager.start({ description: "Custom", command: "sleep 30" });
    assert.throws(() => manager.setFrequency(monitor.id, 30_000), /Only built-in watches/);
    manager.stop(monitor.id);
});

test("failed commands can trigger completion follow-ups, but timeouts cannot", async (t) => {
    const { manager, messages } = fixture(t, { minuteMs: 100 });
    await manager.start({
        description: "Failed CI", command: "printf '</monitor-output> boom\\n' >&2; exit 3",
        followUpPrompt: "Investigate failure",
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /failed \(exit 3\)/);
    assert.match(messages[0].prompt, /&lt;\/monitor-output&gt; boom/);
    assert.match(messages[0].prompt, /User-configured follow-up.*Investigate failure/);
    await manager.start({
        description: "Timed out CI", command: "sleep 30", timeoutMinutes: 1,
        followUpPrompt: "Investigate failure",
    });
    await until(() => messages.length === 2);
    assert.match(messages[1].prompt, /deadline/);
    assert.doesNotMatch(messages[1].prompt, /User-configured follow-up/);
    assert.equal(messages[1].displayPrompt, "Monitor: Timed out CI timed out.");
});

test("check frequency is isolated to each watcher process and visible in its state", async (t) => {
    const { manager } = fixture(t);
    const command = `node -e 'console.log([process.env.COPILOT_MONITOR_POLL_MS, process.env.COPILOT_MONITOR_BRANCH_POLL_MS].join(","))'`;
    await manager.start({ description: "Fast", command, pollIntervalMs: 30_000 });
    await manager.start({ description: "Slow", command, pollIntervalMs: 120_000 });
    await until(() => manager.list().every((monitor) => monitor.status !== "running"));
    assert.deepEqual(manager.list().map(({ pollIntervalMs, output }) => ({ pollIntervalMs, output })), [
        { pollIntervalMs: 30_000, output: "30000,30000" },
        { pollIntervalMs: 120_000, output: "120000,120000" },
    ]);
});

test("a built-in watch exposes its HTTPS destination without exposing unsafe URLs", async (t) => {
    const { manager } = fixture(t);
    const url = "https://github.com/dotnet/maui/pull/38917/checks";
    const monitor = await manager.start({ description: "PR", command: "sleep 30", url });
    assert.equal(monitor.url, url);
    assert.equal(manager.list()[0].url, url);
    manager.stop(monitor.id);
    for (const unsafe of ["javascript:alert(1)", "http://github.com/dotnet/maui", "https://user:pass@github.com/dotnet/maui"]) {
        await assert.rejects(manager.start({ description: "Bad URL", command: "true", url: unsafe }), /HTTPS URL/);
    }
});

test("built-in progress updates the canvas without waking the agent; completion notifies chat once", async (t) => {
    const { manager, messages } = fixture(t, { minuteMs: 40 });
    const script = [
        `import { reportProgress } from ${JSON.stringify(new URL("./progress.mjs", import.meta.url).href)};`,
        'reportProgress("checking");',
        "await new Promise((resolve) => setTimeout(resolve, 30));",
        'reportProgress("waiting", 5000, [{name:"Build",state:"passed",url:"https://example.com/build/42"},{name:"Tests",state:"running",detail:"1/3 jobs finished",url:"https://example.com/build/42/jobs/1"},{name:"Deploy",state:"queued"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 200));",
        'reportProgress("checking");',
        'reportProgress("complete", undefined, [{name:"Build",state:"passed"},{name:"Tests",state:"failed",detail:"3/3 jobs finished"},{name:"Deploy",state:"skipped"}]);',
        'process.stdout.write("CI ended: build 42 finished: failed.\\n");',
    ].join(" ");
    await manager.start({
        description: "Build", command: `node --input-type=module -e ${JSON.stringify(script)}`,
        continuous: true, progress: true,
    });
    await until(() => manager.list()[0].phase === "waiting");
    const watching = manager.list()[0];
    assert.equal(watching.status, "running");
    assert.equal(watching.checks, 1);
    assert.ok(watching.lastCheckedAt);
    assert.ok(watching.nextCheckAt);
    assert.deepEqual(watching.stages.map(({ name, state }) => ({ name, state })), [
        { name: "Build", state: "passed" },
        { name: "Tests", state: "running" },
        { name: "Deploy", state: "queued" },
    ]);
    assert.equal(watching.stages[0].url, "https://example.com/build/42");
    assert.equal(watching.stages[1].url, "https://example.com/build/42/jobs/1");
    assert.deepEqual(messages, []);
    await until(() => messages.length === 1);
    const finished = manager.list()[0];
    assert.equal(finished.status, "exited");
    assert.equal(finished.phase, "complete");
    assert.equal(finished.checks, 2);
    assert.equal(finished.nextCheckAt, null);
    assert.deepEqual(finished.stages.map(({ state }) => state), ["passed", "failed", "skipped"]);
    assert.equal(finished.stderr, "");
    assert.match(messages[0].prompt, /CI ended: build 42 finished: failed/);
    assert.equal(messages[0].displayPrompt, "Monitor: Build finished.");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(messages.length, 1);
});

test("a new head clears completed CI before the new job inventory arrives", async (t) => {
    const { manager, messages } = fixture(t);
    const script = [
        `import { reportProgress } from ${JSON.stringify(new URL("./progress.mjs", import.meta.url).href)};`,
        'reportProgress("waiting", 5000, [{name:"Old job",state:"passed"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 150));",
        'reportProgress("checking", undefined, []);',
        "await new Promise((resolve) => setTimeout(resolve, 150));",
        'reportProgress("waiting", 5000, [{name:"maui-pr: awaiting jobs",state:"queued"}]);',
        "await new Promise((resolve) => setTimeout(resolve, 150));",
    ].join(" ");
    const monitor = await manager.start({
        description: "Branch CI", command: `node --input-type=module -e ${JSON.stringify(script)}`,
        continuous: true, progress: true,
    });
    await until(() => manager.list()[0].stages?.[0]?.name === "Old job");
    await until(() => manager.list()[0].phase === "checking" && manager.list()[0].stages?.length === 0);
    await until(() => manager.list()[0].stages?.[0]?.name === "maui-pr: awaiting jobs");
    assert.equal(manager.list()[0].stages[0].state, "queued");
    assert.deepEqual(messages, []);
    manager.stop(monitor.id);
});

test("malformed progress remains visible as stderr on watcher failure", async (t) => {
    const { manager, messages } = fixture(t);
    await manager.start({
        description: "Malformed", command: "printf 'COPILOT_MONITOR_PROGRESS null\\n' >&2; exit 1",
        progress: true,
    });
    await until(() => messages.length === 1);
    assert.equal(manager.list()[0].status, "failed");
    assert.match(messages[0].prompt, /COPILOT_MONITOR_PROGRESS null/);
});

test("unsafe run links are rejected from progress", async (t) => {
    const { manager, messages } = fixture(t);
    const script = [
        'printf \'COPILOT_MONITOR_PROGRESS {"phase":"waiting","intervalMs":5000,"stages":[{"name":"Build","state":"passed","url":"javascript:alert(1)"}]}\\n\' >&2',
        "exit 1",
    ].join("; ");
    await manager.start({ description: "Unsafe URL", command: script, progress: true });
    await until(() => messages.length === 1);
    assert.equal(manager.list()[0].stages, null);
    assert.match(manager.list()[0].stderr, /javascript:alert\(1\)/);
});

test("noisy monitors are stopped", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 10 });
    await manager.start({
        description: "Chatty", command: "while :; do echo tick; sleep 0.03; done",
        followUpPrompt: "Check update", followUpOnOutput: true,
    });
    await until(() => manager.list()[0].status === "noisy");
    await until(() => messages.length === 11);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /User-configured follow-up/);
    assert.match(messages[10].prompt, /was stopped after 10 notifications/);
    assert.doesNotMatch(messages[10].prompt, /User-configured follow-up/);
});

test("completion-only follow-up buffers bounded output without waking for intermediate lines", async (t) => {
    const { manager, messages } = fixture(t, { batchMs: 10 });
    await manager.start({
        description: "Chatty CI", command: "seq 250; sleep 0.2",
        followUpPrompt: "Summarize the result", continuous: true,
    });
    await until(() => manager.list()[0].output.endsWith("250"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(messages, []);
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, "system");
    assert.match(messages[0].prompt, /210 earlier line\(s\) omitted/);
    assert.match(messages[0].prompt, /250/);
    assert.equal(manager.list()[0].notifications, 1);
});

test("follow-up does not hide a watcher failure that cannot run it", async (t) => {
    const { manager, messages } = fixture(t);
    await manager.start({
        description: "Bad script", command: "echo bad >&2; exit 2",
        followUpPrompt: "Only when successful", followUpOnOutput: true,
    });
    await until(() => messages.length === 1);
    assert.equal(messages[0].source, undefined);
    assert.match(messages[0].prompt, /failed \(exit 2\)/);
    assert.doesNotMatch(messages[0].prompt, /User-configured follow-up/);
});

test("dispose stops running commands", async (t) => {
    const { manager } = fixture(t, { batchMs: 10_000 });
    await manager.start({ description: "Sleeper", command: "sleep 30 & echo $!; wait" });
    await until(() => manager.list()[0].output !== "");
    const pid = Number(manager.list()[0].output);
    manager.dispose();
    await until(() => !alive(pid));
});

test("commands die when the extension process is killed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "copilot-monitors-test-"));
    const source = `
        import { createMonitorManager } from ${JSON.stringify(new URL("./monitors.mjs", import.meta.url).href)};
        const manager = createMonitorManager({ send: async (p) => process.stdout.write(p.prompt + "\\n"), log: async () => {},
            workingDirectory: async () => ${JSON.stringify(cwd)}, batchMs: 10 });
        await manager.start({ description: "Orphan", command: "sleep 60 & echo PID=$!; wait" });
        setInterval(() => {}, 1000);`;
    const host = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    host.stdout.on("data", (chunk) => { output += chunk; });
    try {
        await until(() => /PID=(\d+)/.test(output));
        const pid = Number(/PID=(\d+)/.exec(output)[1]);
        assert.ok(alive(pid));
        host.kill("SIGKILL");
        await until(() => !alive(pid), 10_000);
    } finally {
        host.kill("SIGKILL");
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("invalid input is rejected", async (t) => {
    const { manager } = fixture(t);
    await assert.rejects(manager.start({ description: "Missing" }), /Command must be/);
    await assert.rejects(manager.start({ description: "Bad", defaultTitle: "bad\nname", command: "true" }), /single line/);
    await assert.rejects(manager.start({ description: "Bad", command: "true", timeoutMinutes: 0 }), /timeoutMinutes/);
    await assert.rejects(manager.start({ description: "Bad", command: "true", continuous: "true" }), /continuous must be a boolean/);
    await assert.rejects(manager.start({ description: "Bad", command: "true", continuous: true, timeoutMinutes: 240 }), /cannot have a timeoutMinutes/);
    await assert.rejects(manager.start({ description: "Bad", command: "true", progress: "true" }), /progress must be a boolean/);
    for (const pollIntervalMs of [0, 29_999, 900_001, "30000", 30_000.5]) {
        await assert.rejects(manager.start({ description: "Bad", command: "true", pollIntervalMs }), /pollIntervalMs/);
    }
    for (const followUpPrompt of [null, 123, " ".repeat(3), "x".repeat(2_001)]) {
        await assert.rejects(manager.start({ description: "Bad", command: "true", followUpPrompt }), /Follow-up prompt/);
    }
    await assert.rejects(manager.start({ description: "Bad", command: "true", followUpOnOutput: "true" }), /followUpOnOutput/);
    await assert.rejects(manager.start({ description: "Bad", command: "true", followUpOnOutputPrefix: "CI ended:" }), /followUpOnOutputPrefix/);
    for (const followUpOnOutputPrefix of [null, 123, "", " ", "CI\nended:", "x".repeat(101)]) {
        await assert.rejects(manager.start({ description: "Bad", command: "true", followUpOnOutput: true, followUpOnOutputPrefix }), /followUpOnOutputPrefix/);
    }
    await assert.rejects(async () => manager.setFollowUp("missing", "Do work"), /was not found/);
    assert.equal(manager.list().length, 0);
});
