import { describe, it, expect } from "vitest";
import { computeDecisions } from "./engine";
import type { FileEntity, MixedEntity, SyncRecord } from "../fs/types";

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
		size: 100,
		syncedAt: 900,
		...overrides,
	};
}

describe("computeDecisions — 3-state decision table", () => {
	it("no_action: both exist, no changes since last sync", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.decision).toBe("no_action");
	});

	it("local_modified_push: local changed, remote unchanged", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000 }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("local_modified_push");
	});

	it("remote_modified_pull: remote changed, local unchanged", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({ mtime: 2000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("remote_modified_pull");
	});

	it("conflict_both_modified: both changed since last sync", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000 }),
				remote: makeFile({ mtime: 3000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_both_modified");
	});

	it("local_created_push: local exists, no remote, no prev sync", () => {
		const entities: MixedEntity[] = [
			{
				path: "new-file.md",
				local: makeFile({ path: "new-file.md" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("local_created_push");
	});

	it("remote_created_pull: remote exists, no local, no prev sync", () => {
		const entities: MixedEntity[] = [
			{
				path: "new-file.md",
				remote: makeFile({ path: "new-file.md" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("remote_created_pull");
	});

	it("conflict_both_created: both exist, no prev sync, different content", () => {
		const entities: MixedEntity[] = [
			{
				path: "new-file.md",
				local: makeFile({ path: "new-file.md", mtime: 1000, hash: "local_hash" }),
				remote: makeFile({ path: "new-file.md", mtime: 2000, hash: "remote_hash" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_both_created");
	});

	it("no_action: both created with identical hash and size", () => {
		const entities: MixedEntity[] = [
			{
				path: "same.md",
				local: makeFile({ path: "same.md", mtime: 1000, hash: "samehash", size: 42 }),
				remote: makeFile({ path: "same.md", mtime: 2000, hash: "samehash", size: 42 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("no_action");
	});

	it("conflict_both_created: both created with different hash", () => {
		const entities: MixedEntity[] = [
			{
				path: "diff.md",
				local: makeFile({ path: "diff.md", mtime: 1000, hash: "hash_a", size: 42 }),
				remote: makeFile({ path: "diff.md", mtime: 2000, hash: "hash_b", size: 42 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_both_created");
	});

	it("conflict_both_created: both created with empty hash (conservative)", () => {
		const entities: MixedEntity[] = [
			{
				path: "nohash.md",
				local: makeFile({ path: "nohash.md", mtime: 1000, hash: "", size: 42 }),
				remote: makeFile({ path: "nohash.md", mtime: 2000, hash: "", size: 42 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_both_created");
	});

	it("remote_deleted_propagate: remote deleted, local unchanged", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("remote_deleted_propagate");
	});

	it("local_deleted_propagate: local deleted, remote unchanged", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("local_deleted_propagate");
	});

	it("conflict_delete_vs_modify: remote deleted, local modified", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 2000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_delete_vs_modify");
	});

	it("conflict_delete_vs_modify: local deleted, remote modified", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				remote: makeFile({ mtime: 2000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("conflict_delete_vs_modify");
	});

	it("both_deleted_cleanup: neither exists, only prev sync (both deleted)", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				prevSync: makeRecord(),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("both_deleted_cleanup");
	});

	it("local_modified_push: local size changed, mtime same", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000, size: 200 }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000, size: 100 }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("local_modified_push");
	});

	it("handles multiple entities in a single batch", () => {
		const entities: MixedEntity[] = [
			{
				path: "unchanged.md",
				local: makeFile({ path: "unchanged.md", mtime: 1000 }),
				remote: makeFile({ path: "unchanged.md", mtime: 1000 }),
				prevSync: makeRecord({ path: "unchanged.md", localMtime: 1000, remoteMtime: 1000 }),
			},
			{
				path: "new-local.md",
				local: makeFile({ path: "new-local.md" }),
			},
			{
				path: "new-remote.md",
				remote: makeFile({ path: "new-remote.md" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions).toHaveLength(3);
		expect(decisions[0]!.decision).toBe("no_action");
		expect(decisions[1]!.decision).toBe("local_created_push");
		expect(decisions[2]!.decision).toBe("remote_created_pull");
	});

	it("returns empty array for empty input", () => {
		const decisions = computeDecisions([]);
		expect(decisions).toHaveLength(0);
	});

	it("conservative: treats local as changed when mtime is 0 and hash empty", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 0, hash: "" }),
				remote: makeFile({ mtime: 1000 }),
				prevSync: makeRecord({ localMtime: 0, remoteMtime: 1000 }),
			},
		];
		const decisions = computeDecisions(entities);
		// local: mtime=0 skips mtime check, hash="" is falsy → conservative true
		// remote: mtime=1000 === remoteMtime=1000 → unchanged
		expect(decisions[0]!.decision).toBe("local_modified_push");
	});

	it("no_action: remote unchanged via md5Checksum when mtime is 0", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({
					mtime: 0,
					hash: "",
					backendMeta: { md5Checksum: "aaa111" },
				}),
				prevSync: makeRecord({
					localMtime: 1000,
					remoteMtime: 0,
					hash: "",
					backendMeta: { md5Checksum: "aaa111" },
				}),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("no_action");
	});

	it("remote_modified_pull: remote changed via md5Checksum when mtime is 0", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({
					mtime: 0,
					hash: "",
					backendMeta: { md5Checksum: "bbb222" },
				}),
				prevSync: makeRecord({
					localMtime: 1000,
					remoteMtime: 0,
					hash: "",
					backendMeta: { md5Checksum: "aaa111" },
				}),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("remote_modified_pull");
	});

	it("conflict when both have mtime=0 and no hash", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 0, hash: "" }),
				remote: makeFile({ mtime: 0, hash: "" }),
				prevSync: makeRecord({ localMtime: 0, remoteMtime: 0, hash: "" }),
			},
		];
		const decisions = computeDecisions(entities);
		// Both conservative → conflict
		expect(decisions[0]!.decision).toBe("conflict_both_modified");
	});

	it("treats non-string md5Checksum as unavailable (falls through to hash)", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({
					mtime: 0,
					hash: "abc",
					backendMeta: { md5Checksum: 12345 }, // non-string
				}),
				prevSync: makeRecord({
					localMtime: 1000,
					remoteMtime: 0,
					hash: "abc",
					backendMeta: { md5Checksum: null }, // non-string
				}),
			},
		];
		const decisions = computeDecisions(entities);
		// md5 skipped, falls to hash comparison: both "abc" → no change
		expect(decisions[0]!.decision).toBe("no_action");
	});

	it("detects local change when mtime+size match but hash differs (H1)", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000, size: 100, hash: "new-hash" }),
				remote: makeFile({ mtime: 1000, size: 100, hash: "old-hash" }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000, size: 100, hash: "old-hash" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("local_modified_push");
	});

	it("no_action when mtime+size+hash all match (H1)", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000, size: 100, hash: "same-hash" }),
				remote: makeFile({ mtime: 1000, size: 100, hash: "same-hash" }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000, size: 100, hash: "same-hash" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("no_action");
	});

	it("detects remote change when mtime+size match but hash differs (H1)", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000, size: 100, hash: "old-hash" }),
				remote: makeFile({ mtime: 1000, size: 100, hash: "new-hash" }),
				prevSync: makeRecord({ localMtime: 1000, remoteMtime: 1000, size: 100, hash: "old-hash" }),
			},
		];
		const decisions = computeDecisions(entities);
		expect(decisions[0]!.decision).toBe("remote_modified_pull");
	});

	it("treats undefined md5Checksum as unavailable", () => {
		const entities: MixedEntity[] = [
			{
				path: "test.md",
				local: makeFile({ mtime: 1000 }),
				remote: makeFile({
					mtime: 0,
					hash: "different",
					backendMeta: { md5Checksum: undefined },
				}),
				prevSync: makeRecord({
					localMtime: 1000,
					remoteMtime: 0,
					hash: "abc",
					backendMeta: { md5Checksum: undefined },
				}),
			},
		];
		const decisions = computeDecisions(entities);
		// md5 skipped, falls to hash: "different" !== "abc" → remote changed
		expect(decisions[0]!.decision).toBe("remote_modified_pull");
	});
});
