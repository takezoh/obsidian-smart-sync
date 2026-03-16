import type { SyncAction, SafetyCheckResult } from "./types";

const CONFIRMATION_RATIO_THRESHOLD = 0.5;
const CONFIRMATION_COUNT_THRESHOLD = 10;

export function checkSafety(actions: SyncAction[]): SafetyCheckResult {
	const deletions = actions.filter(
		(a) => a.action === "delete_local" || a.action === "delete_remote"
	).length;

	const total = actions.filter(
		(a) => a.action !== "match" && a.action !== "cleanup"
	).length;

	if (total === 0) {
		return { shouldAbort: false, requiresConfirmation: false };
	}

	const ratio = deletions / total;

	if (ratio === 1) {
		return {
			shouldAbort: true,
			requiresConfirmation: false,
			deletionRatio: ratio,
			deletionCount: deletions,
		};
	}

	if (ratio > CONFIRMATION_RATIO_THRESHOLD && deletions > CONFIRMATION_COUNT_THRESHOLD) {
		return {
			shouldAbort: false,
			requiresConfirmation: true,
			deletionRatio: ratio,
			deletionCount: deletions,
		};
	}

	return {
		shouldAbort: false,
		requiresConfirmation: false,
		deletionRatio: ratio,
		deletionCount: deletions,
	};
}
