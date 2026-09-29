const base = new URL(".", location.href);
const form = document.getElementById("ask");
const input = document.getElementById("text");
const frequency = document.getElementById("frequency");
const followUp = document.getElementById("follow-up");
const list = document.getElementById("monitors");
const status = document.getElementById("status");
const activeCount = document.getElementById("active-count");
const clear = document.getElementById("clear");
const toolbar = document.getElementById("watch-toolbar");
const help = document.getElementById("watch-help");
const openStages = new Set();
const openGroups = new Set();
const openFollowUps = new Set();
const followUpDrafts = new Map();
const openSettings = new Set();
const settingsDrafts = new Map();
const collapsedWatches = new Set();
let lastAsk = "";
let lastMonitors = "";

async function request(path, data) {
    const response = await fetch(new URL(path, base), data === undefined ? undefined : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}

function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
}

function show(message, failed = false, retry) {
    status.replaceChildren(...(message ? [node("span", "", message)] : []));
    status.classList.toggle("failure", failed);
    if (retry) {
        const button = node("button", "", "Try again");
        button.type = "button";
        button.addEventListener("click", () => watch(retry.text, retry));
        status.append(" ", button);
    }
}

function showAsk(ask) {
    const key = ask ? `${ask.at}:${ask.state}` : "";
    if (key === lastAsk) return;
    if (!ask) {
        // The agent started the monitor, so its card below replaces the waiting message.
        if (lastAsk) show("");
        lastAsk = key;
        return;
    }
    lastAsk = key;
    if (ask.state === "waiting") {
        show("Setting up your watch...");
    } else if (ask.state === "failed") {
        show(`Setup failed: ${ask.error || "unknown error"}`, true, ask);
    } else {
        show("No watch started. See chat for details.", true, ask);
    }
}

function time(value) {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function frequencyLabel(ms) {
    return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1_000} sec`;
}

function link(text, url, className = "link") {
    const anchor = node("a", className, text);
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    return anchor;
}

function shortName(description) {
    const pr = /^(.+)#(\d+) checks$/.exec(description);
    if (pr) return `${pr[1]} #${pr[2]}`;
    const branch = /^Branch (.+) (.+)$/.exec(description);
    if (branch) return `${branch[1]} / ${branch[2]}`;
    return description;
}

function completed(stage) {
    return ["passed", "failed", "canceled", "skipped", "warning"].includes(stage.state);
}

function watchActivity(monitor) {
    const activity = node("div", "watch-activity");
    const heading = node("div", "watch-activity-head");
    const branch = monitor.description.startsWith("Branch ");
    const label = monitor.phase === "checking" ? "Checking now"
        : monitor.phase === "retrying" ? "Retrying check"
        : branch ? "Waiting for CI or new commits"
        : monitor.progress ? "Waiting for checks" : "Listening for changes";
    heading.append(node("span", "", label));
    if (monitor.progress) {
        heading.append(node("span", "", monitor.lastCheckedAt ? `Last checked ${time(monitor.lastCheckedAt)}` : "First check pending"));
    }
    const track = node("div", "watch-activity-track");
    track.setAttribute("aria-hidden", "true");
    activity.append(heading, track);
    return activity;
}

function stagesView(stages, monitorId) {
    const rows = node("div", "stage-list");
    rows.dataset.monitorId = monitorId;
    let previousGroup = null;
    for (const stage of stages) {
        if (stage.group && stage.group !== previousGroup) {
            rows.append(node("h5", "stage-group", stage.group));
        }
        previousGroup = stage.group ?? null;
        const row = node("div", "stage-row");
        const label = node("div", "stage-label");
        if (stage.url) {
            label.append(link(stage.name, stage.url, "stage-name"));
        } else {
            label.append(node("span", "stage-name", stage.name));
        }
        if (stage.detail) label.append(node("span", "stage-detail", stage.detail));
        const state = node("span", `stage-state ${stage.state}`, stage.state);
        row.append(label, state);
        rows.append(row);
    }
    return rows;
}

function checksView(stages, monitorId) {
    const section = node("section", "checks");
    if (!stages.length) {
        section.append(node("span", "empty", "Awaiting checks"));
        return section;
    }
    const counts = {};
    for (const stage of stages) counts[stage.state] = (counts[stage.state] ?? 0) + 1;
    const finished = stages.filter(completed).length;
    const summary = node("div", "checks-summary");
    summary.append(node("span", "check-count", `${finished}/${stages.length} complete`));
    if (counts.failed) summary.append(node("span", "failed-count", `${counts.failed} failed`));
    section.append(summary);
    const progress = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    progress.setAttribute("class", "checks-progress");
    progress.setAttribute("viewBox", `0 0 ${stages.length} 8`);
    progress.setAttribute("preserveAspectRatio", "none");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", String(stages.length));
    progress.setAttribute("aria-valuenow", String(finished));
    progress.setAttribute("aria-label", `${finished} of ${stages.length} checks finished`);
    let offset = 0;
    for (const state of ["passed", "failed", "canceled", "warning", "skipped", "running"]) {
        const count = counts[state] ?? 0;
        if (!count) continue;
        const segment = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        segment.setAttribute("class", `segment-${state}`);
        segment.setAttribute("x", String(offset));
        segment.setAttribute("width", String(count));
        segment.setAttribute("height", "8");
        progress.append(segment);
        offset += count;
    }
    section.append(progress);

    const groups = new Map();
    for (const stage of stages) {
        if (!stage.group) continue;
        if (!groups.has(stage.group)) groups.set(stage.group, []);
        groups.get(stage.group).push(stage);
    }
    const ranked = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (ranked.length) {
        const preview = node("div", "group-preview");
        const groupRow = ([name, checks]) => {
            const counts = {};
            for (const check of checks) counts[check.state] = (counts[check.state] ?? 0) + 1;
            const state = ["failed", "canceled", "warning", "running", "queued", "unknown"]
                .find((value) => checks.some((check) => check.state === value))
                ?? (checks.every((check) => check.state === "passed") ? "passed" : "idle");
            const group = node("div", `group-row ${state}`);
            const indicator = node("span", "group-dot");
            indicator.setAttribute("aria-hidden", "true");
            const target = checks.find((check) => check.name === name && check.url) ?? checks.find((check) => check.url);
            const stats = node("span", "group-stats");
            for (const [label, count] of [
                ["passed", counts.passed],
                ["failed", counts.failed],
                ["canceled", counts.canceled],
                ["warning", counts.warning],
                ["skipped", counts.skipped],
                ["running", counts.running],
                ["queued", counts.queued],
                ["unknown", counts.unknown],
            ]) {
                if (count) stats.append(node("span", `group-stat ${label}`, `${count} ${label}`));
            }
            group.append(indicator, target ? link(name, target.url, "group-name") : node("span", "group-name", name), stats);
            return group;
        };
        preview.append(...ranked.slice(0, 3).map(groupRow));
        if (ranked.length > 3) {
            const remaining = node("details", "more-groups");
            remaining.open = openGroups.has(monitorId);
            const label = node("summary", "", remaining.open ? "Show fewer groups" : `+${ranked.length - 3} more groups`);
            remaining.addEventListener("toggle", () => {
                if (remaining.open) openGroups.add(monitorId);
                else openGroups.delete(monitorId);
                label.textContent = remaining.open ? "Show fewer groups" : `+${ranked.length - 3} more groups`;
            });
            remaining.append(label, ...ranked.slice(3).map(groupRow));
            preview.append(remaining);
        }
        section.append(preview);
    }
    const details = node("details", "checks-details");
    details.open = openStages.has(monitorId);
    details.addEventListener("toggle", () => details.open ? openStages.add(monitorId) : openStages.delete(monitorId));
    details.append(node("summary", "", `All ${stages.length} checks`));
    details.append(stagesView(stages, monitorId));
    section.append(details);
    return section;
}

function followUpView(monitor) {
    const details = node("details", `follow-up-settings${monitor.followUpPrompt ? " configured" : ""}`);
    details.dataset.monitorId = monitor.id;
    details.open = openFollowUps.has(monitor.id);
    details.addEventListener("toggle", () => details.open ? openFollowUps.add(monitor.id) : openFollowUps.delete(monitor.id));
    details.append(node("summary", "", monitor.followUpPrompt ? "Follow-up prompt" : "Add follow-up prompt"));

    const editor = node("form", "edit-follow-up");
    const label = node("label", "visually-hidden", "Follow-up prompt when this watch fires");
    label.htmlFor = `follow-up-${monitor.id}`;
    const textarea = node("textarea");
    textarea.id = label.htmlFor;
    textarea.maxLength = 2_000;
    textarea.rows = 1;
    textarea.placeholder = "What should the agent do when this watch fires?";
    textarea.value = followUpDrafts.get(monitor.id) ?? monitor.followUpPrompt ?? "";
    textarea.addEventListener("input", () => followUpDrafts.set(monitor.id, textarea.value));

    const actions = node("div", "follow-up-actions");
    const save = node("button", "", "Save");
    save.type = "submit";
    actions.append(save);
    let remove;
    if (monitor.followUpPrompt) {
        remove = node("button", "follow-up-remove", "Remove");
        remove.type = "button";
        actions.append(remove);
    }
    let saving = false;
    const submit = async (prompt) => {
        if (saving) return;
        saving = true;
        save.disabled = true;
        if (remove) remove.disabled = true;
        try {
            const { monitor: updated } = await request(`api/monitors/${monitor.id}/follow-up`, { followUpPrompt: prompt });
            if (updated?.followUpPrompt !== (prompt || null)) {
                throw new Error("The follow-up prompt was not updated.");
            }
            followUpDrafts.delete(monitor.id);
            textarea.value = updated.followUpPrompt ?? "";
            show(prompt ? "Follow-up prompt saved. The agent will respond when this watch fires." : "Follow-up prompt removed.");
            await refresh();
        } catch (error) {
            show(error.message, true);
        } finally {
            saving = false;
            save.disabled = false;
            if (remove) remove.disabled = false;
        }
    };
    editor.addEventListener("submit", (event) => {
        event.preventDefault();
        return submit(textarea.value.trim());
    });
    if (remove) remove.addEventListener("click", () => submit(""));
    editor.append(label, textarea, actions);
    details.append(editor);
    return details;
}

function settingsView(monitor) {
    const details = node("details", "watch-settings");
    details.dataset.monitorId = monitor.id;
    details.open = openSettings.has(monitor.id);
    details.addEventListener("toggle", () => details.open ? openSettings.add(monitor.id) : openSettings.delete(monitor.id));
    const canChangeFrequency = monitor.status === "running" && monitor.pollIntervalMs !== null;
    const label = canChangeFrequency ? "Edit title and frequency" : "Rename watch";
    const summary = node("summary");
    summary.title = label;
    summary.setAttribute("aria-label", `${label}: ${monitor.title ?? monitor.defaultTitle ?? shortName(monitor.description)}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 20 20");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.6");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("aria-hidden", "true");
    const lines = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lines.setAttribute("d", "M2.5 6H5m4 0h8.5M2.5 14H11m4 0h2.5");
    const upper = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    upper.setAttribute("cx", "7");
    upper.setAttribute("cy", "6");
    upper.setAttribute("r", "2");
    const lower = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    lower.setAttribute("cx", "13");
    lower.setAttribute("cy", "14");
    lower.setAttribute("r", "2");
    icon.append(lines, upper, lower);
    summary.append(icon);
    details.append(summary);

    const editor = node("form", `edit-settings${canChangeFrequency ? "" : " title-only"}`);
    const titleField = node("div", "settings-field");
    const titleLabel = node("label", "", "Title");
    const titleInput = node("input");
    titleInput.id = `settings-title-${monitor.id}`;
    titleLabel.htmlFor = titleInput.id;
    titleInput.maxLength = 100;
    titleInput.required = true;
    titleInput.value = settingsDrafts.get(monitor.id)?.title ?? monitor.title ?? monitor.defaultTitle ?? shortName(monitor.description);
    titleInput.addEventListener("input", () => {
        settingsDrafts.set(monitor.id, { ...settingsDrafts.get(monitor.id), title: titleInput.value });
    });
    titleField.append(titleLabel, titleInput);
    editor.append(titleField);

    let intervalSelect;
    if (canChangeFrequency) {
        const intervalField = node("div", "settings-field settings-frequency");
        const intervalLabel = node("label", "", "Check every");
        intervalSelect = node("select");
        intervalSelect.id = `settings-frequency-${monitor.id}`;
        intervalLabel.htmlFor = intervalSelect.id;
        for (const original of frequency.options) {
            if (!original.value) continue;
            const option = node("option", "", original.textContent);
            option.value = original.value;
            intervalSelect.append(option);
        }
        intervalSelect.value = String(settingsDrafts.get(monitor.id)?.intervalSeconds ?? monitor.pollIntervalMs / 1_000);
        intervalSelect.addEventListener("change", () => {
            settingsDrafts.set(monitor.id, { ...settingsDrafts.get(monitor.id), intervalSeconds: Number(intervalSelect.value) });
        });
        intervalField.append(intervalLabel, intervalSelect);
        editor.append(intervalField);
    }

    const save = node("button", "", "Save");
    save.type = "submit";
    editor.append(save);
    editor.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
            const changes = {};
            const title = titleInput.value.trim();
            if (title !== (monitor.title ?? monitor.defaultTitle ?? shortName(monitor.description))) changes.title = title;
            if (intervalSelect && Number(intervalSelect.value) !== monitor.pollIntervalMs / 1_000) {
                changes.intervalSeconds = Number(intervalSelect.value);
            }
            if (Object.keys(changes).length) {
                await request(`api/monitors/${monitor.id}/settings`, changes);
            }
            settingsDrafts.delete(monitor.id);
            openSettings.delete(monitor.id);
            details.open = false;
            show("");
            await refresh();
        } catch (error) {
            show(error.message, true);
            save.disabled = false;
        }
    });
    details.append(editor);
    return details;
}

function card(monitor) {
    const showIndicator = ["running", "failed", "noisy", "timed-out"].includes(monitor.status);
    const collapsed = collapsedWatches.has(monitor.id);
    const article = node("article", `monitor-card${showIndicator ? "" : " no-indicator"}${collapsed ? " collapsed" : ""}`);
    const stages = Array.isArray(monitor.stages) ? monitor.stages : null;
    const idle = monitor.status === "running" && monitor.phase === "waiting"
        && Boolean(stages?.length) && stages.every(completed);
    const header = node("div", "monitor-head");
    const title = node("div", "monitor-title");
    const displayName = monitor.title ?? monitor.defaultTitle ?? shortName(monitor.description);
    const destination = monitor.url ?? stages?.find((stage) => stage.url)?.url;
    const name = node("h3");
    const nameLink = link(displayName, destination ?? `#watch-body-${monitor.id}`, "watch-title-link");
    if (!destination) {
        nameLink.target = "_self";
        nameLink.rel = "";
    }
    name.append(nameLink);
    name.title = displayName;
    if (showIndicator) {
        const dot = node("span", `indicator ${idle ? "idle" : monitor.status}`);
        dot.setAttribute("aria-hidden", "true");
        title.append(dot);
    }
    title.append(name);
    header.append(title);
    const actions = node("div", "monitor-actions");
    if (monitor.url) actions.append(link("Open", monitor.url));
    if (monitor.status === "running") {
        const stop = node("button", "stop", "Stop");
        stop.type = "button";
        stop.addEventListener("click", async () => {
            stop.disabled = true;
            try {
                await request(`api/monitors/${monitor.id}/stop`, {});
                await refresh();
            } catch (error) {
                show(error.message, true);
                stop.disabled = false;
            }
        });
        actions.append(stop);
    }
    actions.append(settingsView(monitor));
    const body = node("div", "monitor-body");
    body.id = `watch-body-${monitor.id}`;
    body.hidden = collapsed;
    const toggle = node("button", "watch-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-controls", body.id);
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("stroke", "currentColor");
    chevron.setAttribute("stroke-width", "1.6");
    chevron.setAttribute("stroke-linecap", "round");
    chevron.setAttribute("stroke-linejoin", "round");
    chevron.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m3 6 5 5 5-5");
    chevron.append(path);
    toggle.append(chevron);
    const setCollapsed = (value) => {
        body.hidden = value;
        article.classList.toggle("collapsed", value);
        toggle.setAttribute("aria-expanded", String(!value));
        const label = `${value ? "Expand" : "Collapse"} ${displayName}`;
        toggle.setAttribute("aria-label", label);
        toggle.title = label;
        if (value) collapsedWatches.add(monitor.id);
        else collapsedWatches.delete(monitor.id);
    };
    toggle.addEventListener("click", () => setCollapsed(!body.hidden));
    if (!destination) nameLink.addEventListener("click", (event) => {
        event.preventDefault();
        setCollapsed(!body.hidden);
    });
    setCollapsed(collapsed);
    actions.append(toggle);
    header.append(actions);
    article.append(header, body);
    const state = monitor.status === "running"
        ? idle ? "Idle" : monitor.phase === "retrying" ? "Retrying" : monitor.phase === "checking" ? "Checking now" : "Watching"
        : monitor.status === "exited" ? "Finished" : monitor.status;
    const cadence = monitor.pollIntervalMs ? `Every ${frequencyLabel(monitor.pollIntervalMs)}` : null;
    const next = monitor.status === "running" && monitor.nextCheckAt
        ? `${idle ? "Checking again" : "Next"} ~${time(monitor.nextCheckAt)}` : null;
    const deadline = monitor.status === "running" && monitor.deadline ? `Deadline ${time(monitor.deadline)}` : null;
    const updates = monitor.notifications ? `${monitor.notifications} alert${monitor.notifications === 1 ? "" : "s"}` : null;
    body.append(node("div", "status-line", [state, cadence, next, deadline, updates].filter(Boolean).join(" · ")));
    if (stages?.length) body.append(checksView(stages, monitor.id));
    else if (monitor.status === "running") body.append(watchActivity(monitor));
    if (monitor.status === "running") body.append(followUpView(monitor));
    if (monitor.status === "failed" && monitor.stderr) {
        const error = node("div", "error-summary", monitor.stderr.split("\n").filter(Boolean).at(-1));
        error.title = monitor.stderr;
        body.append(error);
    }
    return article;
}

async function refresh() {
    try {
        const { monitors, ask } = await request("api/monitors");
        const visible = monitors.filter((monitor) => !["exited", "stopped"].includes(monitor.status));
        showAsk(ask);
        activeCount.textContent = `${visible.filter((monitor) => monitor.status === "running").length} active`;
        toolbar.hidden = visible.length === 0;
        clear.hidden = !visible.some((monitor) => monitor.status !== "running");
        const snapshot = JSON.stringify(visible);
        if (snapshot !== lastMonitors) {
            const scrolls = new Map([...list.querySelectorAll(".stage-list")].map((rows) => [rows.dataset.monitorId, rows.scrollTop]));
            const focused = document.activeElement;
            const editing = focused?.closest(".follow-up-settings, .watch-settings");
            const editor = editing && ["INPUT", "SELECT", "TEXTAREA"].includes(focused.tagName)
                ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd }
                : null;
            list.replaceChildren(...(visible.length
                ? visible.slice().reverse().sort((a, b) => Number(b.status === "running") - Number(a.status === "running")).map(card)
                : []));
            for (const rows of list.querySelectorAll(".stage-list")) {
                rows.scrollTop = scrolls.get(rows.dataset.monitorId) ?? 0;
            }
            if (editor) {
                const field = list.querySelector(`#${editor.id}`);
                if (field) {
                    field.focus({ preventScroll: true });
                    if (editor.start !== undefined && editor.end !== undefined) {
                        field.setSelectionRange(editor.start, editor.end);
                    }
                }
            }
            lastMonitors = snapshot;
        }
    } catch (error) {
        show(error.message, true);
    }
}

async function watch(text, options = {}) {
    const button = form.querySelector("button");
    button.disabled = true;
    try {
        const intervalSeconds = options.intervalSeconds ?? (frequency.value ? Number(frequency.value) : undefined);
        const followUpPrompt = options.followUpPrompt ?? followUp.value.trim();
        const result = await request("api/watch", { text, intervalSeconds, followUpPrompt });
        input.value = "";
        followUp.value = "";
        form.querySelector(".create-follow-up").open = false;
        if (result.monitor) {
            lastAsk = "";
            show(result.existing ? `Already watching ${result.monitor.title ?? result.monitor.defaultTitle ?? shortName(result.monitor.description)}` : "");
        } else {
            showAsk(result.ask);
        }
        await refresh();
    } catch (error) {
        show(error.message, true);
    } finally {
        button.disabled = false;
    }
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    watch(input.value);
});

document.addEventListener("pointerdown", (event) => {
    if (help.open && !help.contains(event.target)) help.open = false;
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && help.open) {
        help.open = false;
        help.querySelector("summary").focus();
    }
});

clear.addEventListener("click", async () => {
    try {
        await request("api/clear", {});
        await refresh();
    } catch (error) {
        show(error.message, true);
    }
});

refresh();
setInterval(refresh, 2_000);
