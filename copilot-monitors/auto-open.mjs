const CANVAS_ID = "copilot-monitors";
const DEFAULT_INSTANCE_ID = "monitor-dashboard";

export function isWatchRequest(prompt) {
    const text = prompt.trimStart();
    if (/^Monitor\s+"[^"]+"\s+\[[0-9a-f]{8}\]\s+/i.test(text)) return false;
    return /^(?:\/monitor\b|monitor\b|watch\s*:|watch\s+https?:\/\/)/i.test(text);
}

export async function openWatchCanvas(session, { onlyWhenClosed = false } = {}) {
    const existing = session.openCanvases.find(({ canvasId }) => canvasId === CANVAS_ID);
    if (existing && onlyWhenClosed) return;
    return session.rpc.canvas.open({
        canvasId: CANVAS_ID,
        instanceId: existing?.instanceId ?? DEFAULT_INSTANCE_ID,
    });
}
