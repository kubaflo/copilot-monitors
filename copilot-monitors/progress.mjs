export const PROGRESS_PREFIX = "COPILOT_MONITOR_PROGRESS ";
export const FREQUENCY_PREFIX = "COPILOT_MONITOR_FREQUENCY ";

export function reportProgress(phase, intervalMs, stages) {
    process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify({ phase, intervalMs, stages })}\n`);
}

export function reportFrequency(intervalMs, remainingMs) {
    process.stderr.write(`${FREQUENCY_PREFIX}${JSON.stringify({ intervalMs, remainingMs })}\n`);
}
