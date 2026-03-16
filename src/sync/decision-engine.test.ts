import { describe, it, expect } from "vitest";
import { planSync } from "./decision-engine";
import type { FileEntity } from "../fs/types";
import type { MixedEntity, SyncRecord } from "./types";

function makeFile(overrides: Partial<FileEntity> = {}): FileEntity {
	return {
		path: "test.md",
		isDirectory: false,
		size: 100,
		mtime: 1000,
		hash: "abc",
		...overrides,
	};
}

function makeRecord(overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path: "test.md",
		hash: "abc",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
		...overrides,
	};
}

describe("planSync", () => {
	it("returns empty plan for empty input", () => {
		const plan = planSync([]);
		expect(plan.actions).toHaveLength(0);
		expect(plan.safetyCheck.shouldAbort).toBe(false);
	});

	it("push: local created, no remote, no baseline", () => {
		const entries: MixedEntity[] = [
			{ path: "new.md", local: makeFile({ path: "new.md" }) },
		];
		const plan = planSync(entries);
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]!.action).toBe("push");
	});

	it("pull: remote created, no local, no baseline", () => {
		const entries: MixedEntity[] = [
			{ path: "new.md", remote: makeFile({ path: "new.md" }) },
		];
		const plan = planSync(entries);
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]!.action).toBe("pull");
	});

	it("match: both created with identical hash and size, no baseline", () => {
		const entries: MixedEntity[] = [
			{
				path: "same.md",
				local: makeFile({ path: "same.md", hash: "samehash", size: 42 }),
				remote: makeFile({ path: "same.md", hash: "samehash", size: 42 }),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("match");
	});

	it("conflict: both created with different hashes, no baseline", () => {
		const entries: MixedEntity[] = [
			{
				path: "diff.md",
				local: makeFile({ path: "diff.md", hash: "hash_a", size: 42 }),
				remote: makeFile({ path: "diff.md", hash: "hash_b", size: 42 }),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("conflict");
	});

	it("conflict: both created with empty hashes (conservative), no baseline", () => {
		const entries: MixedEntity[] = [
			{
				path: "nohash.md",
				local: makeFile({ path: "nohash.md", hash: "", size: 42 }),
				remote: makeFile({ path: "nohash.md", hash: "", size: 42 }),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("conflict");
	});

	it("push: local modified, remote unchanged, baseline exists", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000, hash: "new-local" }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("push");
	});

	it("pull: remote modified, local unchanged, baseline exists", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({ mtime: 2000, hash: "def" }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("pull");
	});

	it("conflict: both modified, baseline exists", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000, hash: "new-local" }),
				remote: makeFile({ mtime: 3000, hash: "new-remote" }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("conflict");
	});

	it("delete_local: remote deleted, local unchanged", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("delete_local");
	});

	it("conflict: remote deleted, local modified", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000, hash: "new-local" }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("conflict");
	});

	it("delete_remote: local deleted, remote unchanged", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("delete_remote");
	});

	it("conflict: local deleted, remote modified", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				remote: makeFile({ mtime: 2000 }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("conflict");
	});

	it("cleanup: both deleted (only baseline exists)", () => {
		const entries: MixedEntity[] = [
			{ path: "test.md", prevSync: makeRecord() },
		];
		const plan = planSync(entries);
		expect(plan.actions[0]!.action).toBe("cleanup");
	});

	it("no action: both exist unchanged, baseline exists", () => {
		const entries: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord(),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions).toHaveLength(0);
	});

	it("skips entry when neither local nor remote exist and no baseline", () => {
		const entries: MixedEntity[] = [{ path: "ghost.md" }];
		const plan = planSync(entries);
		expect(plan.actions).toHaveLength(0);
	});

	it("populates safetyCheck via checkSafety", () => {
		const entries: MixedEntity[] = Array.from({ length: 5 }, (_, i) => ({
			path: `file-${i}.md`,
			remote: makeFile({ path: `file-${i}.md`, mtime: 1000 }),
			prevSync: makeRecord({ path: `file-${i}.md` }),
		}));
		const plan = planSync(entries);
		expect(plan.actions.every((a) => a.action === "delete_remote")).toBe(true);
		expect(plan.safetyCheck.shouldAbort).toBe(true);
	});

	it("action includes local, remote and baseline references", () => {
		const local = makeFile({ mtime: 2000, hash: "new" });
		const remote = makeFile({ mtime: 1000 });
		const baseline = makeRecord();
		const plan = planSync([{ path: "test.md", local, remote, prevSync: baseline }]);
		const action = plan.actions[0]!;
		expect(action.local).toBe(local);
		expect(action.remote).toBe(remote);
		expect(action.baseline).toBe(baseline);
	});

	it("handles multiple entries in a batch", () => {
		const entries: MixedEntity[] = [
			{ path: "push.md", local: makeFile({ path: "push.md" }) },
			{ path: "pull.md", remote: makeFile({ path: "pull.md" }) },
			{
				path: "noop.md",
				local: makeFile({ path: "noop.md" }),
				remote: makeFile({ path: "noop.md" }),
				prevSync: makeRecord({ path: "noop.md" }),
			},
		];
		const plan = planSync(entries);
		expect(plan.actions).toHaveLength(2);
		expect(plan.actions[0]!.action).toBe("push");
		expect(plan.actions[1]!.action).toBe("pull");
	});
});
