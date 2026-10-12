import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("individual removal is wired through HTTP, canvas actions and the agent tool", async (t) => {
    const events = new Map();
    let config;
    const session = {
        send: async () => {},
        log: async () => {},
        on: (name, handler) => events.set(name, handler),
        rpc: { metadata: { snapshot: async () => ({ workingDirectory: process.cwd(), isRemote: false }) } },
    };
    globalThis.monitorTestSdk = {
        createCanvas: (canvas) => canvas,
        joinSession: async (input) => { config = input; return session; },
    };
    const hook = registerHooks({
        resolve(specifier, context, next) {
            if (specifier === "@github/copilot-sdk/extension") return {
                url: "data:text/javascript,export const {createCanvas,joinSession}=globalThis.monitorTestSdk;",
                shortCircuit: true,
            };
            return next(specifier, context);
        },
    });
    const originalExitListeners = process.listeners("exit");
    const originalSignals = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => [signal, process.listeners(signal)]));
    let canvas;
    t.after(async () => {
        events.get("session.shutdown")?.();
        if (canvas) await canvas.onClose({ instanceId: "removal-test" });
        for (const [signal, listeners] of [["exit", originalExitListeners], ...originalSignals]) {
            for (const listener of process.listeners(signal)) {
                if (!listeners.includes(listener)) process.removeListener(signal, listener);
            }
        }
        hook.deregister();
        delete globalThis.monitorTestSdk;
    });
    await import("./extension.mjs");
    canvas = config.canvases[0];
    const actions = new Map(canvas.actions.map((action) => [action.name, action.handler]));
    const tools = new Map(config.tools.map((tool) => [tool.name, tool]));
    const { url } = await canvas.open({ instanceId: "removal-test" });
    const post = async (route, body = {}) => {
        const response = await fetch(new URL(route, url), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
    const started = [];
    for (let index = 0; index < 3; index++) {
        const response = await post("api/watch", {
            text: `Watch custom observer ${index}`,
        });
        assert.equal(response.status, 202);
        const result = await tools.get("copilot_monitor_start").handler({
            description: `Observer ${index}`, command: "sleep 30", continuous: true,
        });
        started.push(/Monitor ([0-9a-f]{8}) started/.exec(result)[1]);
    }
    assert.equal((await actions.get("list")()).length, 3);
    assert.deepEqual(await post(`api/monitors/${started[0]}/remove`), {
        status: 200, body: { id: started[0], removed: true },
    });
    assert.deepEqual(await actions.get("remove")({ input: { id: started[1] } }), { id: started[1], removed: true });
    assert.equal(tools.get("copilot_monitor_remove").skipPermission, undefined);
    assert.match(tools.get("copilot_monitor_remove").description, /confirmation.*cannot be recalled/);
    assert.deepEqual(JSON.parse(await tools.get("copilot_monitor_remove").handler({ id: started[2] })),
        { id: started[2], removed: true });
    assert.deepEqual(await actions.get("list")(), []);
    const unknown = await post(`api/monitors/${started[0]}/remove`);
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /was not found/);
    await assert.rejects(actions.get("remove")({ input: { id: started[1] } }), /was not found/);
    await assert.rejects(tools.get("copilot_monitor_remove").handler({ id: started[2] }), /was not found/);
});
