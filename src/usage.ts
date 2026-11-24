import { addAbortListener } from "node:events";
import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./convert.js";

type UsageBucket = { utilization: number | null; resets_at: string | null };

export function toUsageReport(response: SDKControlGetUsageResponse): UsageReport | null {
	const { rate_limits: quota } = response;
	if (!response.rate_limits_available || !quota) return null;

	const limits = new Map<string, UsageLimit>();
	const add = (windowId: "5h" | "7d", row: UsageBucket | null | undefined, scope?: string) => {
		if (!Number.isFinite(row?.utilization) || row.utilization < 0) return;
		const id = scope ? `${windowId}:${scope.toLowerCase()}` : windowId;
		if (limits.has(id)) return;
		const windowLabel = windowId === "5h" ? "5 Hour" : "7 Day";
		const resetsAt = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
		limits.set(id, {
			id,
			label: scope ? `${windowLabel} (${scope})` : windowLabel,
			scope: { provider: PROVIDER_ID, windowId },
			window: { id: windowId, label: windowLabel, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined },
			amount: { unit: "percent", used: row.utilization },
		});
	};
	add("5h", quota.five_hour);
	add("7d", quota.seven_day);
	for (const row of Array.isArray(quota.model_scoped) ? quota.model_scoped : []) {
		if (typeof row?.display_name === "string" && row.display_name.trim()) add("7d", row, row.display_name.trim());
	}
	add("7d", quota.seven_day_opus, "Opus");
	add("7d", quota.seven_day_sonnet, "Sonnet");
	add("7d", quota.seven_day_oauth_apps, "OAuth apps");
	return limits.size ? { provider: PROVIDER_ID, fetchedAt: Date.now(), limits: [...limits.values()] } : null;
}

export function claudeUsageProvider(pathToClaudeCodeExecutable?: string): UsageProvider {
	return {
		id: PROVIDER_ID,
		usesRequestKey: true,
		retainLastGoodOnFailure: false,
		async fetchUsage({ signal }) {
			const timeout = AbortSignal.timeout(15_000);
			const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
			stop.throwIfAborted();
			const abortController = new AbortController();
			using listener = addAbortListener(stop, () => abortController.abort(stop.reason));
			// An empty stream initializes the SDK control channel without sending a model prompt.
			const run = query({
				prompt: (async function* () {})(),
				options: { abortController, pathToClaudeCodeExecutable, persistSession: false, settingSources: [], tools: [], strictMcpConfig: true },
			});
			try {
				// shortcut: SDK usage API is experimental, switch to the stable method once published.
				if (typeof run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return null;
				return toUsageReport(await run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
			} finally {
				run.close();
			}
		},
	};
}
