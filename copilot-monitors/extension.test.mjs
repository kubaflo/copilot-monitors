import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

test("HTTP Save and canvas set_follow_up share dispatch, deduplication and delivery errors", async (t) => {
    let config;
    let fail = false;
    const messages = [];
    const handlers = new Map();
    const session = {
        openCanvases: [],
        send: async (message) => {
            if (fail) throw new Error("Agent delivery failed");
            messages.push(message);
        },
        log: async () => {},
        rpc: {
            metadata: { snapshot: async () => ({ workingDirectory: process.cwd(), isRemote: false }) },
            canvas: { listOpen: async () => ({ canvases: [] }), open: async () => {} },
        },
        on: (name, handler) => handlers.set(name, handler),
    };
    globalThis.monitorTestSdk = {
        createCanvas: (canvas) => canvas,
        joinSession: async (options) => { config = options; return session; },
    };
    const sdkUrl = `data:text/javascript,${encodeURIComponent(
        "export const { createCanvas, joinSession } = globalThis.monitorTestSdk;",
    )}`;
    register(`data:text/javascript,${encodeURIComponent(`
        export async function resolve(specifier, context, next) {
            if (specifier === "@github/copilot-sdk/extension") {
                return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true };
            }
            return next(specifier, context);
        }
    `)}`, import.meta.url);
    await import("./extension.mjs");
    const canvas = config.canvases[0];
    const panel = await canvas.open({ instanceId: "follow-up-regression" });
    t.after(async () => {
        handlers.get("session.shutdown")();
        await canvas.onClose({ instanceId: "follow-up-regression" });
        delete globalThis.monitorTestSdk;
    });
    const stages = [{ name: "UI", state: "failed" }, { name: "Device", state: "canceled" }];
    const report = `COPILOT_MONITOR_PROGRESS ${JSON.stringify({ phase: "waiting", intervalMs: 300_000, stages })}`;
    const source = `process.stderr.write(${JSON.stringify(report + "\n")}); setInterval(() => {}, 1000);`;
    const start = config.tools.find((tool) => tool.name === "copilot_monitor_start").handler;
    await start({
        description: "Completed custom watch", command: `node -e ${JSON.stringify(source)}`,
        continuous: true, progress: true, followUpOnOutput: true,
        followUpOnOutputPrefix: "Azure branch CI finished:", followUpPrompt: "Inspect CI",
    });
    let monitor;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await fetch(new URL("api/monitors", panel.url)).then((response) => response.json());
        monitor = state.monitors[0];
        if (monitor?.phase === "waiting") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(monitor.phase, "waiting");
    assert.equal(messages.length, 0);
    const save = async (prompt) => {
        const response = await fetch(new URL(`api/monitors/${monitor.id}/follow-up`, panel.url), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ followUpPrompt: prompt }),
        });
        return { status: response.status, body: await response.json() };
    };
    const action = canvas.actions.find((entry) => entry.name === "set_follow_up").handler;
    const saved = await save("Inspect CI");
    assert.equal(saved.status, 200);
    assert.equal(saved.body.monitor.followUpQueued, true);
    assert.equal(messages.length, 1);
    assert.match(messages[0].prompt, /1 failed, 1 canceled/);
    assert.equal((await action({ input: { id: monitor.id, followUpPrompt: "Inspect CI" } })).followUpQueued, false);
    assert.equal(messages.length, 1);
    assert.equal((await action({ input: { id: monitor.id, followUpPrompt: "Explain CI" } })).followUpQueued, true);
    assert.equal(messages.length, 2);
    fail = true;
    const failed = await save("Retry CI");
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /Agent delivery failed/);
    await assert.rejects(action({ input: { id: monitor.id, followUpPrompt: "Retry CI" } }), /Agent delivery failed/);
    fail = false;
    assert.equal((await save("Retry CI")).body.monitor.followUpQueued, true);
    assert.equal(messages.length, 3);
    assert.equal((await save("")).body.monitor.followUpQueued, false);
    assert.equal(messages.length, 3);
});
