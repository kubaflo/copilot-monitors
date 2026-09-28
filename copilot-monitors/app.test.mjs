import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.dataset = {};
        this.classList = {
            toggle: (name, force) => {
                const classes = new Set((this.className ?? "").split(" ").filter(Boolean));
                const enabled = force ?? !classes.has(name);
                if (enabled) classes.add(name);
                else classes.delete(name);
                this.className = [...classes].join(" ");
                return enabled;
            },
        };
        this.listeners = {};
    }

    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return []; }
}

const elements = new Map();
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element("div"));
        return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_namespace, tag) { return new Element(tag); },
    addEventListener() {},
};
elements.set("frequency", Object.assign(new Element("select"), {
    options: [
        { value: "", textContent: "Auto" },
        { value: "30", textContent: "30 sec" },
        { value: "60", textContent: "1 min" },
        { value: "120", textContent: "2 min" },
        { value: "300", textContent: "5 min" },
        { value: "600", textContent: "10 min" },
        { value: "900", textContent: "15 min" },
    ],
}));
const context = {
    document,
    location: { href: "http://127.0.0.1/" },
    URL,
    fetch: async () => ({ ok: true, json: async () => ({ monitors: [], ask: null }) }),
    setInterval() {},
};
vm.runInNewContext(readFileSync(new URL("./app.js", import.meta.url), "utf8")
    + "\nglobalThis.renderChecks = checksView; globalThis.renderCard = card; globalThis.refreshWatches = refresh;", context);

function groupRow(checks) {
    return context.renderChecks(checks, "test-monitor").children[2].children[0];
}

function watchSettings(card) {
    return card.children[0].children[1].children.find((child) => child.className === "watch-settings");
}

function watchBody(card) {
    return card.children[1];
}

function watchToggle(card) {
    return card.children[0].children[1].children.find((child) => child.className === "watch-toggle");
}

function watchTitle(card) {
    return card.children[0].children[0].children.at(-1).children[0];
}

function stage(group, state, name = group) {
    return { group, name, state, url: `https://github.com/dotnet/maui/actions/runs/${name}` };
}

test("empty watch list hides its heading and duplicate prompt", async () => {
    await context.refreshWatches();
    assert.equal(elements.get("watch-toolbar").hidden, true);
    assert.equal(elements.get("monitors").children.length, 0);
});

test("watch settings show the custom title and current built-in interval", () => {
    const monitor = { id: "abc12345", description: "Branch dotnet/maui net11.0",
        defaultTitle: "net11.0 · dotnet/maui", title: "Net 11 CI",
        status: "running", pollIntervalMs: 300_000, output: "", stderr: "" };
    const card = context.renderCard(monitor);
    assert.equal(watchTitle(card).textContent, "Net 11 CI");
    const settings = watchSettings(card);
    assert.equal(settings.children[0].tagName, "SUMMARY");
    assert.equal(settings.children[0].children[0].tagName, "SVG");
    assert.equal(settings.children[0]["aria-label"], "Edit title and frequency: Net 11 CI");
    const editor = settings.children[1];
    assert.equal(editor.children[0].children[1].value, "Net 11 CI");
    assert.equal(editor.children[1].children[1].value, "300");
    assert.equal(editor.children[1].children[1].children.length, 6);
    const custom = context.renderCard({ ...monitor, pollIntervalMs: null });
    const rename = watchSettings(custom);
    assert.equal(rename.children[0]["aria-label"], "Rename watch: Net 11 CI");
    assert.equal(rename.children[1].children.length, 2);
    const defaultCard = context.renderCard({ ...monitor, title: null });
    assert.equal(watchTitle(defaultCard).textContent, "net11.0 · dotnet/maui");
    const defaultSettings = watchSettings(defaultCard);
    assert.equal(defaultSettings.children[1].children[0].children[1].value, "net11.0 · dotnet/maui");
});

test("watch titles link to the watch URL, then a check URL, then their own details", () => {
    const monitor = {
        id: "abc12345", description: "MAUI net11.0", title: "MAUI net11.0",
        status: "running", pollIntervalMs: null, output: "", stderr: "",
        stages: [stage("maui-pr - Azure jobs", "running", "job-42")],
    };
    const branchUrl = "https://github.com/dotnet/maui/tree/net11.0";
    const configured = context.renderCard({ ...monitor, url: branchUrl });
    const configuredTitle = watchTitle(configured);
    assert.equal(configuredTitle.tagName, "A");
    assert.equal(configuredTitle.textContent, "MAUI net11.0");
    assert.equal(configuredTitle.href, branchUrl);
    assert.equal(configuredTitle.target, "_blank");
    assert.equal(configuredTitle.rel, "noopener noreferrer");

    const checkTitle = watchTitle(context.renderCard(monitor));
    assert.equal(checkTitle.href, monitor.stages[0].url);
    assert.equal(checkTitle.target, "_blank");

    const withoutUrl = context.renderCard({ ...monitor, stages: [] });
    const detailsLink = watchTitle(withoutUrl);
    assert.equal(detailsLink.tagName, "A");
    assert.equal(detailsLink.href, "#watch-body-abc12345");
    assert.equal(detailsLink.target, "_self");
    let prevented = false;
    detailsLink.listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(watchBody(withoutUrl).hidden, true);
    assert.equal(watchToggle(withoutUrl)["aria-expanded"], "false");
    detailsLink.listeners.click({ preventDefault() {} });
    assert.equal(watchBody(withoutUrl).hidden, false);
});

test("editing frequency does not silently rename the watch", async () => {
    const monitor = { id: "abc12345", description: "Branch dotnet/maui net11.0",
        defaultTitle: "net11.0 · dotnet/maui", title: null,
        status: "running", pollIntervalMs: 300_000, output: "", stderr: "" };
    const settings = watchSettings(context.renderCard(monitor));
    const editor = settings.children[1];
    editor.children[1].children[1].value = "120";
    const originalFetch = context.fetch;
    let changes;
    context.fetch = async (url, options) => {
        if (url.pathname.endsWith("/settings")) changes = JSON.parse(options.body);
        return { ok: true, json: async () => ({ monitors: [], ask: null }) };
    };
    try {
        await editor.listeners.submit({ preventDefault() {} });
        assert.deepEqual(changes, { intervalSeconds: 120 });
    } finally {
        context.fetch = originalFetch;
    }
});

test("watch cards start expanded and collapse independently across rerenders", () => {
    const monitor = { id: "collapsible-1", description: "Branch dotnet/maui net11.0",
        defaultTitle: "net11.0 · dotnet/maui", status: "running",
        pollIntervalMs: 300_000, output: "", stderr: "", stages: [stage("Build", "running")] };
    const first = context.renderCard(monitor);
    assert.equal(watchBody(first).hidden, false);
    assert.equal(watchToggle(first)["aria-expanded"], "true");
    assert.equal(watchToggle(first)["aria-controls"], "watch-body-collapsible-1");
    assert.equal(watchToggle(first)["aria-label"], "Collapse net11.0 · dotnet/maui");

    watchToggle(first).listeners.click();
    assert.equal(watchBody(first).hidden, true);
    assert.equal(first.className, "monitor-card collapsed");
    assert.equal(watchToggle(first)["aria-expanded"], "false");
    assert.equal(watchToggle(first)["aria-label"], "Expand net11.0 · dotnet/maui");
    assert.equal(watchBody(context.renderCard({ ...monitor, checks: 2 })).hidden, true);
    assert.equal(watchBody(context.renderCard({ ...monitor, id: "collapsible-2" })).hidden, false);

    const rerendered = context.renderCard(monitor);
    watchToggle(rerendered).listeners.click();
    assert.equal(watchBody(rerendered).hidden, false);
    assert.equal(rerendered.className, "monitor-card");
    assert.equal(watchBody(context.renderCard(monitor)).hidden, false);
});

test("watch dot shows watcher health, not the CI result", () => {
    const monitor = {
        id: "abc12345", description: "dotnet/macios#26752 checks",
        status: "running", pollIntervalMs: 60_000, output: "", stderr: "",
        stages: [stage("API diff", "failed")],
    };
    const running = context.renderCard(monitor);
    assert.equal(running.children[0].children[0].children[0].className, "indicator running");
    assert.equal(watchBody(running).children.find((child) => child.className === "checks").children[0].children[1].textContent, "1 failed");

    const finished = context.renderCard({ ...monitor, status: "exited", exitCode: 0 });
    assert.equal(finished.className, "monitor-card no-indicator");
    assert.equal(finished.children[0].children[0].children.length, 1);
    assert.equal(watchBody(finished).children.find((child) => child.className === "checks").children[0].children[1].textContent, "1 failed");

    const failed = context.renderCard({ ...monitor, status: "failed", stderr: "Watcher failed" });
    assert.equal(failed.children[0].children[0].children[0].className, "indicator failed");
});

test("continuous watch with completed CI shows an idle dot and keeps polling", () => {
    const monitor = {
        id: "a71b7166", description: "MAUI release/11.0.1xx-rc2",
        status: "running", phase: "waiting", pollIntervalMs: null,
        nextCheckAt: "2026-09-28T17:15:00Z", output: "", stderr: "",
        stages: [
            ...Array.from({ length: 182 }, (_, index) => stage("maui-pr", "passed", `passed-${index}`)),
            ...Array.from({ length: 5 }, (_, index) => stage("maui-pr-uitests", "failed", `failed-${index}`)),
            ...Array.from({ length: 3 }, (_, index) => stage("maui-pr-devicetests", "canceled", `canceled-${index}`)),
        ],
    };
    const card = context.renderCard(monitor);
    assert.equal(card.children[0].children[0].children[0].className, "indicator idle");
    assert.match(watchBody(card).children.find((child) => child.className === "status-line").textContent,
        /^Idle · Checking again ~/);
    assert.equal(card.children[0].children[1].children.find((child) => child.className === "stop").textContent, "Stop");
    const checks = watchBody(card).children.find((child) => child.className === "checks");
    assert.equal(checks.children[0].children[0].textContent, "190/190 complete");
    assert.equal(checks.children[0].children[1].textContent, "5 failed");
    assert.equal(context.renderCard({ ...monitor, status: "failed" }).children[0].children[0].children[0].className, "indicator failed");
});

test("unknown or pending inventory and active checks do not look idle", () => {
    const monitor = {
        id: "a71b7166", description: "MAUI release/11.0.1xx-rc2",
        status: "running", phase: "waiting", pollIntervalMs: 300_000, output: "", stderr: "",
        stages: [stage("maui-pr", "passed")],
    };
    for (const stages of [
        [], [stage("maui-pr", "queued")], [stage("maui-pr", "running")], [stage("maui-pr", "unknown")],
    ]) {
        const card = context.renderCard({ ...monitor, stages });
        assert.equal(card.children[0].children[0].children[0].className, "indicator running");
        assert.match(watchBody(card).children.find((child) => child.className === "status-line").textContent, /^Watching/);
    }
    for (const [phase, label] of [["checking", "Checking now"], ["retrying", "Retrying"]]) {
        const card = context.renderCard({ ...monitor, phase });
        assert.equal(card.children[0].children[0].children[0].className, "indicator running");
        assert.match(watchBody(card).children.find((child) => child.className === "status-line").textContent,
            new RegExp(`^${label}`));
    }
});

test("cards show a follow-up prompt without rendering the raw activity log", () => {
    const monitor = {
        id: "abc12345", description: "dotnet/maui#38782 checks",
        status: "running", pollIntervalMs: 60_000, followUpPrompt: "Tell me if tests are flaky",
        output: "CI ended: 53 failed", stderr: "", stages: [stage("maui-pr", "failed")],
    };
    const running = watchBody(context.renderCard(monitor));
    const followUp = running.children.find((child) => child.className?.includes("follow-up-settings"));
    assert.equal(followUp.children[0].textContent, "Follow-up prompt");
    assert.equal(followUp.children[1].children[1].value, "Tell me if tests are flaky");
    assert.ok(!running.children.some((child) => child.className === "log-details"));
    const failed = watchBody(context.renderCard({ ...monitor, status: "failed", stderr: "Watcher crashed" }));
    assert.equal(failed.children.find((child) => child.className === "error-summary").textContent, "Watcher crashed");
    assert.ok(!failed.children.some((child) => child.className === "log-details"));
});

test("saving an unchanged follow-up leaves Remove usable and removal updates the card", async () => {
    const monitor = {
        id: "d0000001", description: "Branch dotnet/maui net11.0", status: "running",
        pollIntervalMs: 300_000, followUpPrompt: "Tell me when CI ends", output: "", stderr: "",
    };
    const originalFetch = context.fetch;
    const updates = [];
    context.fetch = async (url, options) => {
        if (url.pathname.endsWith("/follow-up")) {
            const { followUpPrompt } = JSON.parse(options.body);
            updates.push(followUpPrompt);
            monitor.followUpPrompt = followUpPrompt || null;
            return { ok: true, json: async () => ({ monitor: { ...monitor } }) };
        }
        return { ok: true, json: async () => ({ monitors: [{ ...monitor }], ask: null }) };
    };
    try {
        await context.refreshWatches();
        const firstCard = elements.get("monitors").children[0];
        const editor = watchBody(firstCard).children.find((child) => child.className?.includes("follow-up-settings"));
        editor.open = true;
        editor.listeners.toggle();
        const form = editor.children[1];
        const textarea = form.children[1];
        const [save, remove] = form.children[2].children;
        assert.equal(form.children[0].className, "visually-hidden");
        assert.equal(textarea.rows, 1);
        assert.equal(textarea.maxLength, 2_000);
        await form.listeners.submit({ preventDefault() {} });
        assert.equal(elements.get("monitors").children[0], firstCard);
        assert.equal(save.disabled, false);
        assert.equal(remove.disabled, false);

        await remove.listeners.click();
        assert.deepEqual(updates, ["Tell me when CI ends", ""]);
        const updated = watchBody(elements.get("monitors").children[0])
            .children.find((child) => child.className?.includes("follow-up-settings"));
        assert.equal(updated.open, true);
        assert.equal(updated.children[0].textContent, "Add follow-up prompt");
        assert.equal(updated.children[1].children[1].value, "");
        assert.equal(updated.children[1].children[2].children.length, 1);
    } finally {
        context.fetch = originalFetch;
    }
});

test("a failed follow-up removal keeps Remove usable and shows the error", async () => {
    const monitor = {
        id: "d0000002", description: "Branch dotnet/maui net11.0", status: "running",
        pollIntervalMs: 300_000, followUpPrompt: "Tell me when CI ends", output: "", stderr: "",
    };
    const originalFetch = context.fetch;
    context.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "Watch is temporarily unavailable" }) });
    try {
        const editor = watchBody(context.renderCard(monitor))
            .children.find((child) => child.className?.includes("follow-up-settings"));
        const [save, remove] = editor.children[1].children[2].children;
        await remove.listeners.click();
        assert.equal(save.disabled, false);
        assert.equal(remove.disabled, false);
        assert.equal(elements.get("status").className, "failure");
        assert.equal(elements.get("status").children[0].textContent, "Watch is temporarily unavailable");
    } finally {
        context.fetch = originalFetch;
    }
});

test("pipeline counts distinguish passed checks from finished and failed checks", () => {
    const checks = [
        ...Array.from({ length: 5 }, (_, index) => stage("maui-pr-devicetests", "passed", `pass-${index}`)),
        ...Array.from({ length: 4 }, (_, index) => stage("maui-pr-devicetests", "failed", `fail-${index}`)),
    ];
    const row = groupRow(checks);
    assert.equal(row.className, "group-row failed");
    assert.equal(row.children[1].href, checks[0].url);
    assert.deepEqual(row.children[2].children.map((item) => item.textContent), ["5 passed", "4 failed"]);
    assert.ok(!row.children[2].children.some((item) => item.textContent.includes("9/9")));
});

test("pipeline counts show running, queued, unknown, canceled, warning, and skipped separately", () => {
    const checks = [
        stage("mixed", "passed"), stage("mixed", "canceled"),
        stage("mixed", "warning"), stage("mixed", "skipped"),
        stage("mixed", "running"), stage("mixed", "queued"), stage("mixed", "unknown"),
    ];
    const row = groupRow(checks);
    assert.deepEqual(row.children[2].children.map((item) => item.textContent), [
        "1 passed", "1 canceled", "1 warning", "1 skipped", "1 running", "1 queued", "1 unknown",
    ]);
});

test("Azure job group separates three running jobs from five queued jobs and pending inventory", () => {
    const jobs = [
        ...Array.from({ length: 3 }, (_, index) => stage("maui-pr - Azure jobs", "running", `running-${index}`)),
        ...Array.from({ length: 5 }, (_, index) => stage("maui-pr - Azure jobs", "queued", `queued-${index}`)),
        stage("maui-pr - pending job inventory", "queued", "maui-pr: awaiting jobs"),
    ];
    const preview = context.renderChecks(jobs, "net11").children[2];
    assert.equal(preview.children[0].children[1].textContent, "maui-pr - Azure jobs");
    assert.equal(preview.children[0].className, "group-row running");
    assert.deepEqual(preview.children[0].children[2].children.map((item) => item.textContent),
        ["3 running", "5 queued"]);
    assert.equal(preview.children[1].children[1].textContent, "maui-pr - pending job inventory");
    assert.deepEqual(preview.children[1].children[2].children.map((item) => item.textContent), ["1 queued"]);
});

test("CI progress uses proportional result segments without coloring queued checks", () => {
    const checks = [
        stage("mixed", "passed"), stage("mixed", "passed"), stage("mixed", "passed"),
        stage("mixed", "failed"), stage("mixed", "canceled"), stage("mixed", "warning"),
        stage("mixed", "skipped"), stage("mixed", "skipped"),
        stage("mixed", "running"), stage("mixed", "queued"),
    ];
    const progress = context.renderChecks(checks, "test-monitor").children[1];
    assert.equal(progress.tagName, "SVG");
    assert.equal(progress.viewBox, "0 0 10 8");
    assert.equal(progress.role, "progressbar");
    assert.equal(progress["aria-valuenow"], "8");
    assert.equal(progress["aria-valuemax"], "10");
    assert.equal(progress["aria-label"], "8 of 10 checks finished");
    assert.deepEqual(progress.children.map(({ class: state, x, width }) => [state, x, width]), [
        ["segment-passed", "0", "3"],
        ["segment-failed", "3", "1"],
        ["segment-canceled", "4", "1"],
        ["segment-warning", "5", "1"],
        ["segment-skipped", "6", "2"],
        ["segment-running", "8", "1"],
    ]);
});

test("additional pipeline groups retain their run links", () => {
    const checks = Array.from({ length: 4 }, (_, index) => stage(`pipeline-${index}`, "passed"));
    const preview = context.renderChecks(checks, "test-monitor").children[2];
    assert.equal(preview.children[3].tagName, "DETAILS");
    assert.equal(preview.children[3].children[1].children[1].href, checks[3].url);
});
