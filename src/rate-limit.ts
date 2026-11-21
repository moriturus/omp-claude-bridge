export const RATE_LIMIT_WARN_THRESHOLD = 80;

export interface RateLimitInfo {
	status?: string;
	rateLimitType?: string;
	utilization?: number;
	resetsAt?: number;
}

export interface RateLimitNotice {
	message: string;
	level: "warning";
}

// The SDK emits `allowed_warning` rate-limit events even at trivial utilization
// (e.g. 1% of the seven_day window), so those are suppressed below the threshold;
// `rejected` (hard limit) always surfaces. Returns null when nothing should show.
export function rateLimitNotice(
	info: RateLimitInfo | undefined,
	threshold: number = RATE_LIMIT_WARN_THRESHOLD,
): RateLimitNotice | null {
	if (info?.status === "rejected") {
		const resetsAt = info.resetsAt === undefined ? "unknown" : new Date(info.resetsAt * 1_000).toLocaleTimeString();
		return { message: `Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, level: "warning" };
	}
	if (info?.status === "allowed_warning") {
		const percentage = (info.utilization ?? 0) * 100;
		if (percentage >= threshold) {
			return { message: `Claude rate limit warning: ${Math.round(percentage)}% used (${info.rateLimitType ?? ""})`, level: "warning" };
		}
	}
	return null;
}
