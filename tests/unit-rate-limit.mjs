import test from "node:test";
import assert from "node:assert/strict";

import { rateLimitNotice, RATE_LIMIT_WARN_THRESHOLD } from "../src/rate-limit.ts";

test("allowed_warning below the threshold stays silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.01 }), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: (RATE_LIMIT_WARN_THRESHOLD - 1) / 100 }), null);
});

test("allowed_warning at/above the threshold warns with rounded utilization + type", () => {
	assert.deepEqual(
		rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.874 }),
		{ message: "Claude rate limit warning: 87% used (seven_day)", level: "warning" },
	);
	assert.ok(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: RATE_LIMIT_WARN_THRESHOLD / 100 }));
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 1 })?.message, "Claude rate limit warning: 100% used (five_hour)");
});

test("rejected always surfaces, regardless of utilization", () => {
	const notice = rateLimitNotice({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1_783_432_800 });
	assert.equal(notice?.level, "warning");
	assert.match(notice.message, /^Claude rate limited \(seven_day\) — resets at /);
});

test("rejected without fields falls back to 'unknown'", () => {
	assert.equal(
		rateLimitNotice({ status: "rejected" })?.message,
		"Claude rate limited (unknown) — resets at unknown",
	);
});

test("allowed / undefined / empty statuses stay silent", () => {
	assert.equal(rateLimitNotice({ status: "allowed", utilization: 0.99 }), null);
	assert.equal(rateLimitNotice(undefined), null);
	assert.equal(rateLimitNotice({}), null);
});

test("missing utilization defaults to 0 (silent)", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day" }), null);
});

test("a custom threshold is respected", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", utilization: 0.5 }, 60), null);
	assert.equal(rateLimitNotice({ status: "allowed_warning", utilization: 0.999 }, 100), null);
	assert.ok(rateLimitNotice({ status: "allowed_warning", utilization: 0.6 }, 60));
});

test("wire utilization fractions use the percentage threshold", () => {
	assert.equal(rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.799 }), null);
	assert.equal(
		rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8 })?.message,
		"Claude rate limit warning: 80% used (seven_day)",
	);
	assert.equal(
		rateLimitNotice({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.91 })?.message,
		"Claude rate limit warning: 91% used (seven_day)",
	);
});

test("wire resetsAt Unix seconds is interpreted as seconds", () => {
	const notice = rateLimitNotice({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 });
	assert.equal(notice?.message, `Claude rate limited (five_hour) — resets at ${new Date(1_800_000_000_000).toLocaleTimeString()}`);
});
