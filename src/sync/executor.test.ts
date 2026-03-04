import { describe, it, expect, beforeEach } from "vitest";
import { SyncExecutor } from "./executor";
import type { FileEntity, SyncDecision, SyncRecord } from "../fs/types";
import type { SyncStateStore } from "./state";
import { createMockFs, createMockStateStore, makeFile } from "../__mocks__/sync-test-helpers";

describe("SyncExecutor", () => {
	let localFs: ReturnType<typeof createMockFs>;
	let remoteFs: ReturnType<typeof createMockFs>;
	let stateStore: ReturnType<typeof createMockStateStore>;

	beforeEach(() => {
		localFs = createMockFs("local");
		remoteFs = createMockFs("remote");
		stateStore = createMockStateStore();
	});

	function createExecutor() {
		return new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "keep_newer",
			enableThreeWayMerge: false,
		});
	}

	it("local_created_push: copies local file to remote and saves SyncRecord", async () => {
		const { entity, content } = makeFile("new.md", "hello");
		localFs.files.set("new.md", { content, entity });

		const decisions: SyncDecision[] = [
			{ path: "new.md", decision: "local_created_push", local: entity },
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pushed).toBe(1);
		expect(result.pulled).toBe(0);
		expect(remoteFs.files.has("new.md")).toBe(true);
		expect(stateStore.records.has("new.md")).toBe(true);
	});

	it("remote_created_pull: copies remote file to local and saves SyncRecord", async () => {
		const { entity, content } = makeFile("remote.md", "world");
		remoteFs.files.set("remote.md", { content, entity });

		const decisions: SyncDecision[] = [
			{ path: "remote.md", decision: "remote_created_pull", remote: entity },
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pulled).toBe(1);
		expect(result.pushed).toBe(0);
		expect(localFs.files.has("remote.md")).toBe(true);
		expect(stateStore.records.has("remote.md")).toBe(true);
	});

	it("remote_deleted_propagate: deletes local file and removes SyncRecord", async () => {
		const { entity, content } = makeFile("deleted.md", "gone");
		localFs.files.set("deleted.md", { content, entity });
		stateStore.records.set("deleted.md", {
			path: "deleted.md",
			hash: "",
			localMtime: 1000,
			remoteMtime: 1000,
			size: 4,
			syncedAt: 900,
		});

		const decisions: SyncDecision[] = [
			{
				path: "deleted.md",
				decision: "remote_deleted_propagate",
				local: entity,
				prevSync: stateStore.records.get("deleted.md"),
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pulled).toBe(1);
		expect(localFs.files.has("deleted.md")).toBe(false);
		expect(stateStore.records.has("deleted.md")).toBe(false);
	});

	it("local_deleted_propagate: deletes remote file and removes SyncRecord", async () => {
		const { entity, content } = makeFile("deleted.md", "gone");
		remoteFs.files.set("deleted.md", { content, entity });
		stateStore.records.set("deleted.md", {
			path: "deleted.md",
			hash: "",
			localMtime: 1000,
			remoteMtime: 1000,
			size: 4,
			syncedAt: 900,
		});

		const decisions: SyncDecision[] = [
			{
				path: "deleted.md",
				decision: "local_deleted_propagate",
				remote: entity,
				prevSync: stateStore.records.get("deleted.md"),
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pushed).toBe(1);
		expect(remoteFs.files.has("deleted.md")).toBe(false);
		expect(stateStore.records.has("deleted.md")).toBe(false);
	});

	it("both_deleted_cleanup: removes SyncRecord only", async () => {
		stateStore.records.set("gone.md", {
			path: "gone.md",
			hash: "",
			localMtime: 1000,
			remoteMtime: 1000,
			size: 10,
			syncedAt: 900,
		});

		const decisions: SyncDecision[] = [
			{
				path: "gone.md",
				decision: "both_deleted_cleanup",
				prevSync: stateStore.records.get("gone.md"),
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pushed).toBe(0);
		expect(result.pulled).toBe(0);
		expect(stateStore.records.has("gone.md")).toBe(false);
	});

	it("no_action: is filtered out and does not execute", async () => {
		const decisions: SyncDecision[] = [
			{ path: "unchanged.md", decision: "no_action" },
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.pushed).toBe(0);
		expect(result.pulled).toBe(0);
		expect(result.conflicts).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	it("continues processing after an error on one file", async () => {
		// First file will fail (not in remoteFs so write is fine but read from localFs will fail)
		const decisions: SyncDecision[] = [
			{
				path: "missing.md",
				decision: "local_created_push",
				local: { path: "missing.md", isDirectory: false, size: 5, mtime: 1000, hash: "" },
			},
			{
				path: "ok.md",
				decision: "remote_created_pull",
				remote: {
					path: "ok.md",
					isDirectory: false,
					size: 3,
					mtime: 1000,
					hash: "",
				},
			},
		];

		// Add ok.md to remote
		const { content, entity } = makeFile("ok.md", "ok");
		remoteFs.files.set("ok.md", { content, entity });

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("missing.md");
		expect(result.pulled).toBe(1);
		expect(localFs.files.has("ok.md")).toBe(true);
	});

	it("throws when ask strategy is used without onConflict", () => {
		expect(() => new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "ask",
			enableThreeWayMerge: false,
		})).toThrow('defaultStrategy "ask" requires an onConflict callback');
	});

	it("allows ask strategy when onConflict is provided", () => {
		expect(() => new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "ask",
			enableThreeWayMerge: false,
			onConflict: async () => "keep_newer",
		})).not.toThrow();
	});

	it("conflict: uses onConflict callback with ask strategy", async () => {
		const localFile = makeFile("conflict.md", "local content", 2000);
		localFs.files.set("conflict.md", localFile);
		const remoteFile = makeFile("conflict.md", "remote content", 3000);
		remoteFs.files.set("conflict.md", remoteFile);

		const decisions: SyncDecision[] = [
			{
				path: "conflict.md",
				decision: "conflict_both_modified",
				local: localFile.entity,
				remote: remoteFile.entity,
			},
		];

		const executor = new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "ask",
			enableThreeWayMerge: false,
			onConflict: async () => "keep_local",
		});

		const result = await executor.execute(decisions);
		expect(result.conflicts).toBe(1);
	});

	it("conflict: keep_newer resolves to newer side", async () => {
		const localFile = makeFile("conflict.md", "local old", 1000);
		localFs.files.set("conflict.md", localFile);
		const remoteFile = makeFile("conflict.md", "remote new", 2000);
		remoteFs.files.set("conflict.md", remoteFile);

		const decisions: SyncDecision[] = [
			{
				path: "conflict.md",
				decision: "conflict_both_modified",
				local: localFile.entity,
				remote: remoteFile.entity,
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		expect(result.conflicts).toBe(1);
		// Remote is newer, so local should get remote content
		const localContent = localFs.files.get("conflict.md");
		expect(localContent).toBeDefined();
		expect(new TextDecoder().decode(localContent!.content)).toBe("remote new");
	});

	it("0-byte file: sync record preserves size=0 with ?? operator", async () => {
		const emptyBuf = new ArrayBuffer(0);
		const localEntity: FileEntity = {
			path: "empty.md",
			isDirectory: false,
			size: 0,
			mtime: 1000,
			hash: "",
		};
		localFs.files.set("empty.md", { content: emptyBuf, entity: localEntity });

		const decisions: SyncDecision[] = [
			{
				path: "empty.md",
				decision: "local_created_push",
				local: localEntity,
			},
		];

		const executor = createExecutor();
		await executor.execute(decisions);

		const record = stateStore.records.get("empty.md");
		expect(record).toBeDefined();
		expect(record!.size).toBe(0);
	});

	it("enableThreeWayMerge does not override keep_local strategy", async () => {
		const localFile = makeFile("conflict.md", "local ver", 2000);
		localFs.files.set("conflict.md", localFile);
		const remoteFile = makeFile("conflict.md", "remote ver", 1000);
		remoteFs.files.set("conflict.md", remoteFile);

		const prevSync: SyncRecord = {
			path: "conflict.md",
			hash: "",
			localMtime: 500,
			remoteMtime: 500,
			size: 5,
			syncedAt: 400,
		};
		stateStore.records.set("conflict.md", prevSync);

		const decisions: SyncDecision[] = [
			{
				path: "conflict.md",
				decision: "conflict_both_modified",
				local: localFile.entity,
				remote: remoteFile.entity,
				prevSync,
			},
		];

		const executor = new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "keep_local",
			enableThreeWayMerge: true,
		});

		const result = await executor.execute(decisions);
		expect(result.conflicts).toBe(1);

		// keep_local should push local content to remote, not attempt 3-way merge
		const remoteContent = remoteFs.files.get("conflict.md");
		expect(remoteContent).toBeDefined();
		expect(new TextDecoder().decode(remoteContent!.content)).toBe("local ver");
	});

	it("remote_deleted_propagate: re-checks remote and treats as conflict if re-created", async () => {
		// Local file exists, decision says remote was deleted
		const { entity: localEntity, content: localContent } = makeFile("recreated.md", "local content", 1000);
		localFs.files.set("recreated.md", { content: localContent, entity: localEntity });

		// But remote has been re-created since the decision was made
		const { entity: remoteEntity, content: remoteContent } = makeFile("recreated.md", "new remote", 2000);
		remoteFs.files.set("recreated.md", { content: remoteContent, entity: remoteEntity });

		stateStore.records.set("recreated.md", {
			path: "recreated.md", hash: "", localMtime: 500, remoteMtime: 500, size: 5, syncedAt: 400,
		});

		const decisions: SyncDecision[] = [
			{
				path: "recreated.md",
				decision: "remote_deleted_propagate",
				local: localEntity,
				prevSync: stateStore.records.get("recreated.md"),
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		// Should NOT have deleted — should have treated as conflict
		expect(localFs.files.has("recreated.md")).toBe(true);
		expect(result.pulled).toBe(0);
		expect(result.conflicts).toBe(1);
	});

	it("local_deleted_propagate: re-checks local and treats as conflict if re-created", async () => {
		// Remote file exists, decision says local was deleted
		const { entity: remoteEntity, content: remoteContent } = makeFile("recreated.md", "remote content", 1000);
		remoteFs.files.set("recreated.md", { content: remoteContent, entity: remoteEntity });

		// But local has been re-created since the decision was made
		const { entity: localEntity, content: localContent } = makeFile("recreated.md", "new local", 2000);
		localFs.files.set("recreated.md", { content: localContent, entity: localEntity });

		stateStore.records.set("recreated.md", {
			path: "recreated.md", hash: "", localMtime: 500, remoteMtime: 500, size: 5, syncedAt: 400,
		});

		const decisions: SyncDecision[] = [
			{
				path: "recreated.md",
				decision: "local_deleted_propagate",
				remote: remoteEntity,
				prevSync: stateStore.records.get("recreated.md"),
			},
		];

		const executor = createExecutor();
		const result = await executor.execute(decisions);

		// Should NOT have deleted — should have treated as conflict
		expect(remoteFs.files.has("recreated.md")).toBe(true);
		expect(result.pushed).toBe(0);
		expect(result.conflicts).toBe(1);
	});

	it("local_created_push: sync record uses fresh local stat after push", async () => {
		const { entity, content } = makeFile("fresh.md", "content", 1000);
		localFs.files.set("fresh.md", { content, entity });

		// Simulate the file being updated between decision and execution:
		// after read() the mock stat will return a different mtime
		const originalStat = localFs.stat.bind(localFs);
		let statCalls = 0;
		localFs.stat = async (path: string) => {
			statCalls++;
			const result = await originalStat(path);
			if (result && path === "fresh.md") {
				// Return a fresh entity with updated mtime
				return { ...result, mtime: 9999 };
			}
			return result;
		};

		const decisions: SyncDecision[] = [
			{ path: "fresh.md", decision: "local_created_push", local: entity },
		];

		const executor = createExecutor();
		await executor.execute(decisions);

		const record = stateStore.records.get("fresh.md");
		expect(record).toBeDefined();
		// Should use the fresh mtime (9999) not the decision mtime (1000)
		expect(record!.localMtime).toBe(9999);
	});

	it("remote_created_pull: sync record uses fresh remote stat after pull", async () => {
		const { entity, content } = makeFile("pulled.md", "remote data", 1000);
		remoteFs.files.set("pulled.md", { content, entity });

		// After write, remote stat returns updated mtime
		const originalStat = remoteFs.stat.bind(remoteFs);
		remoteFs.stat = async (path: string) => {
			const result = await originalStat(path);
			if (result && path === "pulled.md") {
				return { ...result, mtime: 8888 };
			}
			return result;
		};

		const decisions: SyncDecision[] = [
			{ path: "pulled.md", decision: "remote_created_pull", remote: entity },
		];

		const executor = createExecutor();
		await executor.execute(decisions);

		const record = stateStore.records.get("pulled.md");
		expect(record).toBeDefined();
		// Should use the fresh remote mtime (8888) not the decision mtime (1000)
		expect(record!.remoteMtime).toBe(8888);
	});

	it("reports progress during execution", async () => {
		const { entity, content } = makeFile("a.md", "aaa");
		localFs.files.set("a.md", { content, entity });

		const progressCalls: Array<{ total: number; completed: number }> = [];

		const executor = new SyncExecutor({
			localFs,
			remoteFs,
			stateStore: stateStore as unknown as SyncStateStore,
			defaultStrategy: "keep_newer",
			enableThreeWayMerge: false,
			onProgress: (p) => progressCalls.push({ total: p.total, completed: p.completed }),
		});

		await executor.execute([
			{ path: "a.md", decision: "local_created_push", local: entity },
		]);

		// Should have progress for start (completed=0) and finish (completed=total)
		expect(progressCalls.length).toBeGreaterThanOrEqual(2);
		expect(progressCalls[0]!.completed).toBe(0);
		expect(progressCalls[progressCalls.length - 1]!.completed).toBe(1);
	});
});
