import { addAbortListener } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { query, type SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { PROVIDER_ID } from "./convert.js";

type UsageBucket = { utilization: number | null; resets_at: string | null };
type UsageQuota = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

function quotaStatus(usedFraction: number): UsageLimit["status"] {
	return usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok";
}

function extraUsageLimit(extra: UsageQuota["extra_usage"]): UsageLimit | undefined {
	if (extra?.is_enabled !== true) return;
	const { currency, used_credits: usedCents, monthly_limit: limitCents } = extra;
	// shortcut: OMP only has a USD money unit, extend when it supports other currencies.
	if (currency != null && (typeof currency !== "string" || currency.toUpperCase() !== "USD")) return;
	if (typeof usedCents !== "number" || !Number.isSafeInteger(usedCents) || usedCents < 0) return;

	const used = usedCents / 100;
	const row: UsageLimit = {
		id: "extra",
		label: "Claude Extra Usage",
		scope: { provider: PROVIDER_ID, windowId: "extra" },
		amount: { unit: "usd", used },
	};
	if (limitCents === null) return row;
	if (!Number.isSafeInteger(limitCents) || limitCents <= 0) return;

	const limit = limitCents / 100;
	const remainingCents = Math.max(0, limitCents - usedCents);
	const usedFraction = usedCents / limitCents;
	row.amount.limit = limit;
	row.amount.remaining = remainingCents / 100;
	row.amount.usedFraction = usedFraction;
	row.amount.remainingFraction = remainingCents / limitCents;
	row.status = quotaStatus(usedFraction);
	// OMP's TUI shows only a percentage for capped rows; put the amounts in Details.
	row.notes = [`Claude Extra Usage: $${used.toFixed(2)} used of $${limit.toFixed(2)} monthly limit`];
	return row;
}

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
		const usedFraction = row.utilization / 100;
		limits.set(id, {
			id,
			label: scope ? `${windowLabel} (${scope})` : windowLabel,
			scope: { provider: PROVIDER_ID, windowId },
			window: { id: windowId, label: windowLabel, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined },
			amount: { unit: "percent", used: row.utilization, usedFraction },
			status: quotaStatus(usedFraction),
		});
	};
	add("5h", quota.five_hour);
	add("7d", quota.seven_day);
	for (const row of Array.isArray(quota.model_scoped) ? quota.model_scoped : []) {
		if (typeof row?.display_name !== "string") continue;
		const label = stripVTControlCharacters(row.display_name).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
		if (label) add("7d", row, label);
	}
	add("7d", quota.seven_day_opus, "Opus");
	add("7d", quota.seven_day_sonnet, "Sonnet");
	add("7d", quota.seven_day_oauth_apps, "OAuth apps");
	const extra = extraUsageLimit(quota.extra_usage);
	if (extra) limits.set(extra.id, extra);
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
