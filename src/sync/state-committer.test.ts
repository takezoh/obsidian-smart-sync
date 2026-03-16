import { describe, it, expect, beforeEach, vi } from "vitest";
import { commitAction, buildSyncRecord } from "./state-committer";
import type { SyncAction } from "./types";
import { createMockFs, createMockStateStore, makeFile } from "../__mocks__/sync-test-helpers";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";

describe("buildSyncRecord", () => {
	it("builds record from both sides", () => {
		const local = makeFile("a.md", "hello", 1000).entity;
		const remote = makeFile("a.md", "hello", 2000).entity;
		remote.backendMeta = { id: "drive-id" };

		const record = buildSyncRecord(local, remote, "a.md");

		expect(record.path).toBe("a.md");
		expect(record.localMtime).toBe(1000);
		expect(record.remoteMtime).toBe(2000);
		expect(record.localSize).toBe(local.size);
		expect(record.remoteSize).toBe(remote.size);
		expect(record.backendMeta).toEqual({ id: "drive-id" });
		expect(record.syncedAt).toBeGreaterThan(0);
	});

	it("handles missing local (pull from remote only)", () => {
		const remote = makeFile("a.md", "hello", 2000).entity;
		remote.hash = "remote-hash";
		const record = buildSyncRecord(undefined, remote, "a.md");

		expect(record.localMtime).toBe(0);
		expect(record.remoteMtime).toBe(2000);
		expect(record.hash).toBe("remote-hash");
	});

	it("handles missing remote (push local only)", () => {
		const local = makeFile("a.md", "hello", 1000).entity;
		local.hash = "abc123";
		const record = buildSyncRecord(local, undefined, "a.md");

		expect(record.remoteMtime).toBe(0);
		expect(record.hash).toBe("abc123");
	});
});

describe("commitAction", () => {
	let stateStore: ReturnType<typeof createMockStateStore>;
	let localFs: ReturnType<typeof createMockFs>;

	beforeEach(() => {
		stateStore = createMockStateStore();
		localFs = createMockFs("local");
	});

	function makeCtx(enableThreeWayMerge = false) {
		return {
			stateStore: stateStore as unknown as SyncStateStore,
			localFs,
			enableThreeWayMerge,
		};
	}

	it("push: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("a.md", "local content", 1000);
		const { entity: remote } = makeFile("a.md", "local content", 1000);
		const action: SyncAction = { path: "a.md", action: "push" };

		await commitAction(action, local, remote, makeCtx());

		expect(stateStore.records.has("a.md")).toBe(true);
		expect(stateStore.records.get("a.md")!.localMtime).toBe(1000);
	});

	it("pull: upserts SyncRecord", async () => {
		const { entity: remote } = makeFile("b.md", "remote content", 2000);
		const action: SyncAction = { path: "b.md", action: "pull" };

		await commitAction(action, undefined, remote, makeCtx());

		expect(stateStore.records.has("b.md")).toBe(true);
		expect(stateStore.records.get("b.md")!.remoteMtime).toBe(2000);
	});

	it("match: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("c.md", "same", 500);
		const { entity: remote } = makeFile("c.md", "same", 500);
		const action: SyncAction = { path: "c.md", action: "match" };

		await commitAction(action, local, remote, makeCtx());

		expect(stateStore.records.has("c.md")).toBe(true);
	});

	it("conflict: upserts SyncRecord", async () => {
		const { entity: local } = makeFile("d.md", "local", 1000);
		const { entity: remote } = makeFile("d.md", "remote", 2000);
		const action: SyncAction = { path: "d.md", action: "conflict" };

		await commitAction(action, local, remote, makeCtx());

		expect(stateStore.records.has("d.md")).toBe(true);
	});

	it("delete_local: deletes SyncRecord", async () => {
		stateStore.records.set("e.md", {
			path: "e.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const action: SyncAction = { path: "e.md", action: "delete_local" };

		await commitAction(action, undefined, undefined, makeCtx());

		expect(stateStore.records.has("e.md")).toBe(false);
	});

	it("delete_remote: deletes SyncRecord", async () => {
		stateStore.records.set("f.md", {
			path: "f.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const action: SyncAction = { path: "f.md", action: "delete_remote" };

		await commitAction(action, undefined, undefined, makeCtx());

		expect(stateStore.records.has("f.md")).toBe(false);
	});

	it("cleanup: deletes SyncRecord", async () => {
		stateStore.records.set("g.md", {
			path: "g.md", hash: "", localMtime: 1000, remoteMtime: 1000,
			localSize: 4, remoteSize: 4, syncedAt: 900,
		});
		const action: SyncAction = { path: "g.md", action: "cleanup" };

		await commitAction(action, undefined, undefined, makeCtx());

		expect(stateStore.records.has("g.md")).toBe(false);
	});

	it("push with enableThreeWayMerge: stores merge-base content for eligible file", async () => {
		const buf = new TextEncoder().encode("hello world").buffer as ArrayBuffer;
		const localEntry = makeFile("h.md", "hello world", 1000);
		localFs.files.set("h.md", { content: buf, entity: localEntry.entity });

		const { entity: remote } = makeFile("h.md", "hello world", 1000);
		const action: SyncAction = { path: "h.md", action: "push" };

		await commitAction(action, localEntry.entity, remote, makeCtx(true));

		expect(stateStore.contents.has("h.md")).toBe(true);
	});

	it("push with enableThreeWayMerge: logs warning and still upserts record when localFs.read throws", async () => {
		const { entity: local } = makeFile("h.md", "hello world", 1000);
		const { entity: remote } = makeFile("h.md", "hello world", 1000);
		const action: SyncAction = { path: "h.md", action: "push" };

		const readError = new Error("read failed");
		const failingLocalFs = { read: (_path: string): Promise<ArrayBuffer> => { throw readError; } };
		const warnSpy = vi.fn();
		const logger: Logger = {
			debug: vi.fn(), info: vi.fn(),
			warn: warnSpy, error: vi.fn(),
		} as unknown as Logger;

		await commitAction(action, local, remote, {
			stateStore: stateStore as unknown as SyncStateStore,
			localFs: failingLocalFs,
			enableThreeWayMerge: true,
			logger,
		});

		expect(stateStore.records.has("h.md")).toBe(true);
		expect(stateStore.contents.has("h.md")).toBe(false);
		expect(warnSpy).toHaveBeenCalledWith(
			"Failed to store content for 3-way merge",
			expect.objectContaining({ path: "h.md", error: "read failed" }),
		);
	});

	it("push with enableThreeWayMerge: skips content store for binary/ineligible file", async () => {
		const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; // PNG header
		const localEntry = makeFile("image.png", "", 1000);
		localFs.files.set("image.png", { content: buf, entity: localEntry.entity });

		const { entity: remote } = makeFile("image.png", "", 1000);
		const action: SyncAction = { path: "image.png", action: "push" };

		await commitAction(action, localEntry.entity, remote, makeCtx(true));

		expect(stateStore.contents.has("image.png")).toBe(false);
	});

	// Note: there is no test for a "failed" action because "failed" is not a member of
	// SyncActionType and therefore cannot be passed to commitAction. Failed execution is
	// handled by the caller, which simply does not call commitAction for failed actions.
});
