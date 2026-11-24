import test from "node:test";
import assert from "node:assert/strict";
import { toUsageReport } from "../src/usage.ts";

test("reports quota windows and resets with the status used for bar colors", () => {
	const report = toUsageReport({
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 0, resets_at: "2026-11-24T12:00:00Z" },
			seven_day: { utilization: 100, resets_at: null },
			seven_day_opus: { utilization: 80, resets_at: null },
			seven_day_sonnet: { utilization: 26, resets_at: "invalid" },
			seven_day_oauth_apps: { utilization: null, resets_at: null },
			model_scoped: [{ display_name: "Opus", utilization: 90, resets_at: null }],
		},
	});
	assert.deepEqual(report.limits.map(({ label, amount, window, status }) => [label, amount.used, window.resetsAt, status]), [
		["5 Hour", 0, Date.UTC(2026, 10, 24, 12), "ok"],
		["7 Day", 100, undefined, "exhausted"],
		["7 Day (Opus)", 90, undefined, "warning"],
		["7 Day (Sonnet)", 26, undefined, "ok"],
	]);
});

test("does not report subscription usage for an API-key session", () => {
	assert.equal(toUsageReport({ rate_limits_available: false, rate_limits: null }), null);
});

test("model scope labels cannot inject terminal controls or extra lines", () => {
	const report = toUsageReport({
		rate_limits_available: true,
		rate_limits: {
			model_scoped: [{ display_name: "\x1b[31mFable\x1b[0m\nMax", utilization: 30, resets_at: null }],
		},
	});
	assert.equal(report.limits[0].label, "7 Day (Fable Max)");
});

test("shows capped and uncapped USD extra usage only when reported and enabled", () => {
	const report = (extra_usage) => toUsageReport({
		rate_limits_available: true,
		rate_limits: { extra_usage },
	});
	const capped = { is_enabled: true, used_credits: 475, monthly_limit: 500, currency: "USD" };
	const [limit] = report(capped).limits;
	assert.deepEqual(limit.amount, {
		unit: "usd", used: 4.75, limit: 5, remaining: 0.25, usedFraction: 0.95, remainingFraction: 0.05,
	});
	assert.equal(limit.status, "warning");
	assert.deepEqual(report({ ...capped, used_credits: 0, monthly_limit: null }).limits[0].amount, {
		unit: "usd", used: 0,
	});
	assert.equal(report({ ...capped, is_enabled: false }), null);
	assert.equal(report({ ...capped, used_credits: null }), null);
	assert.equal(report({ ...capped, currency: "JPY" }), null);
});
