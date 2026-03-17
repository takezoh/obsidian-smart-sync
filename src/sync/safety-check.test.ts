import { describe, it, expect } from "vitest";
import { checkSafety } from "./safety-check";
import type { SyncAction, SyncActionType } from "./types";

function makeActions(counts: Partial<Record<SyncActionType, number>>): SyncAction[] {
	const actions: SyncAction[] = [];
	for (const [type, count] of Object.entries(counts) as [SyncActionType, number][]) {
		for (let i = 0; i < count; i++) {
			actions.push({ path: `file-${type}-${i}.md`, action: type });
		}
	}
	return actions;
}

describe("checkSafety", () => {
	it("returns safe result for empty actions", () => {
		const result = checkSafety([]);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("returns safe result when no deletions", () => {
		const actions = makeActions({ push: 5, pull: 3 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("ignores match and cleanup when computing total", () => {
		const actions = makeActions({ match: 10, cleanup: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("returns shouldAbort when 100% are deletions", () => {
		const actions = makeActions({ delete_local: 5, delete_remote: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(true);
		expect(result.requiresConfirmation).toBe(false);
		expect(result.deletionRatio).toBe(1);
		expect(result.deletionCount).toBe(10);
	});

	it("returns shouldAbort when all non-trivial are deletions (with match/cleanup ignored)", () => {
		const actions = makeActions({ delete_local: 3, match: 20, cleanup: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(true);
		expect(result.deletionCount).toBe(3);
	});

	it("returns requiresConfirmation when >50% and >10 deletions", () => {
		const actions = makeActions({ delete_local: 11, push: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(true);
		expect(result.deletionCount).toBe(11);
	});

	it("does not require confirmation when >50% but <=10 deletions", () => {
		const actions = makeActions({ delete_local: 9, push: 3 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("does not require confirmation when >10 deletions but <=50%", () => {
		const actions = makeActions({ delete_local: 11, push: 20 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("does not trigger confirmation at exactly 50% deletions", () => {
		const actions = makeActions({ delete_local: 11, push: 11 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.requiresConfirmation).toBe(false);
	});

	it("counts both delete_local and delete_remote as deletions", () => {
		const actions = makeActions({ delete_local: 6, delete_remote: 6, push: 5 });
		const result = checkSafety(actions);
		expect(result.deletionCount).toBe(12);
		expect(result.requiresConfirmation).toBe(true);
	});

	it("returns deletionRatio for non-abort cases", () => {
		const actions = makeActions({ delete_local: 2, push: 8 });
		const result = checkSafety(actions);
		expect(result.deletionRatio).toBeCloseTo(0.2);
		expect(result.deletionCount).toBe(2);
	});
});
