export interface ErrorInfo {
	status: number | null;
	retryAfter: number | null;
}

export function getErrorInfo(err: unknown): ErrorInfo {
	if (err && typeof err === "object") {
		const status =
			"status" in err ? (err as { status: number }).status : null;
		let retryAfter: number | null = null;
		if ("headers" in err) {
			const headers = (err as { headers: unknown }).headers;
			let ra: string | null | undefined;
			if (headers && typeof headers === "object" && "get" in headers && typeof (headers as { get: unknown }).get === "function") {
				// Fetch API Headers object
				ra = (headers as Headers).get("retry-after");
			} else if (headers && typeof headers === "object") {
				const h = headers as Record<string, string>;
				ra = h["retry-after"] ?? h["Retry-After"];
			}
			if (ra) {
				const parsed = Number(ra);
				if (!isNaN(parsed)) {
					retryAfter = parsed;
				} else {
					// RFC 7231: Retry-After can be an HTTP-date
					const dateMs = Date.parse(ra);
					if (!isNaN(dateMs)) {
						retryAfter = Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
					}
				}
			}
		}
		return { status, retryAfter };
	}
	return { status: null, retryAfter: null };
}

const RATE_LIMIT_REASONS = new Set([
	"rateLimitExceeded",
	"userRateLimitExceeded",
	"dailyLimitExceeded",
]);

/** Check if a 403 error is actually a Google Drive rate limit (not an auth error) */
export function isRateLimitError(err: unknown): boolean {
	if (!err || typeof err !== "object" || !("json" in err)) return false;
	try {
		const json = (err as Record<string, unknown>).json;
		if (!json || typeof json !== "object") return false;
		const errors = (json as Record<string, unknown>).error;
		if (!errors || typeof errors !== "object") return false;
		const errList = (errors as Record<string, unknown>).errors;
		if (!Array.isArray(errList)) return false;
		return errList.some(
			(e: unknown) =>
				e &&
				typeof e === "object" &&
				"reason" in e &&
				typeof (e as { reason: unknown }).reason === "string" &&
				RATE_LIMIT_REASONS.has((e as { reason: string }).reason)
		);
	} catch {
		return false;
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
