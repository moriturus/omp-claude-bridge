import test from "node:test";
import assert from "node:assert/strict";
import { toUsageReport } from "../src/usage.ts";

test("shows each reported quota window once, including zero utilization and valid resets", () => {
	const report = toUsageReport({
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 0, resets_at: "2026-11-24T12:00:00Z" },
			seven_day: { utilization: null, resets_at: null },
			seven_day_opus: { utilization: 80, resets_at: null },
			seven_day_sonnet: { utilization: 26, resets_at: "invalid" },
			model_scoped: [{ display_name: "Opus", utilization: 75, resets_at: null }],
		},
	});
	assert.deepEqual(report.limits.map(({ label, amount, window }) => [label, amount.used, window.resetsAt]), [
		["5 Hour", 0, Date.UTC(2026, 10, 24, 12)],
		["7 Day (Opus)", 75, undefined],
		["7 Day (Sonnet)", 26, undefined],
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
