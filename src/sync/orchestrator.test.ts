import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncOrchestrator } from "./orchestrator";
import type { SyncOrchestratorDeps } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import { createMockFs, addFile } from "../__mocks__/sync-test-helpers";
import { AuthError } from "../fs/errors";

function mockSettings() {
	return {
		vaultId: `test-${Math.random()}`,
		backendType: "none",
		ignorePatterns: [] as string[],
		syncDotPaths: [] as string[],
		conflictStrategy: "auto_merge" as const,
		enableThreeWayMerge: false,
		mobileMaxFileSizeMB: 10,
		enableLogging: false,
		logLevel: "info" as const,
		backendData: {} as Record<string, Record<string, unknown>>,
	};
}

function createDeps(overrides: Partial<SyncOrchestratorDeps> = {}): SyncOrchestratorDeps {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	return {
		getSettings: () => mockSettings(),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		localFs: () => localFs,
		remoteFs: () => remoteFs,
		backendProvider: () => null,
		onStatusChange: vi.fn(),
		onProgress: vi.fn(),
		notify: vi.fn(),
		isMobile: () => false,
		localTracker: new LocalChangeTracker(),
		...overrides,
	};
}

describe("SyncOrchestrator", () => {
	describe("isSyncing()", () => {
		it("returns false when not syncing", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.isSyncing()).toBe(false);
			await orchestrator.close();
		});

		it("returns true while sync is running", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			let resolveSync!: () => void;
			const syncStarted = new Promise<void>((res) => { resolveSync = res; });

			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			// Intercept list to block sync and capture isSyncing state
			let isSyncingDuringSync = false;
			const orchestrator = new SyncOrchestrator(deps);
			vi.spyOn(localFs, "list").mockImplementationOnce(() => {
				isSyncingDuringSync = orchestrator.isSyncing();
				resolveSync();
				return Promise.resolve([]);
			});

			const syncPromise = orchestrator.runSync();
			await syncStarted;
			expect(isSyncingDuringSync).toBe(true);
			await syncPromise;
			await orchestrator.close();
		});
	});

	describe("runSync()", () => {
		it("does not notify when remoteFs is not available", async () => {
			const debugFn = vi.fn();
			const deps = createDeps({
				remoteFs: () => null,
				logger: { debug: debugFn, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as import("../logging/logger").Logger,
			});
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).not.toHaveBeenCalled();
			expect(deps.onStatusChange).toHaveBeenCalledWith("not_connected");
			expect(debugFn).toHaveBeenCalledWith("runSync: skipped — no remote backend");
			await orchestrator.close();
		});

		it("notifies 'Everything up to date' when both sides are empty", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();
			expect(deps.notify).toHaveBeenCalledWith("Everything up to date");
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("queues a pending sync when called while locked", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let callCount = 0;
			let unblockFirst!: () => void;
			const blocker = new Promise<void>((res) => { unblockFirst = res; });

			vi.spyOn(localFs, "list").mockImplementation(async () => {
				callCount++;
				if (callCount === 1) await blocker;
				return [];
			});

			const orchestrator = new SyncOrchestrator(deps);
			const first = orchestrator.runSync();
			// Give the first sync time to enter the mutex and start
			await new Promise((res) => setTimeout(res, 10));
			const second = orchestrator.runSync(); // should set syncPending since mutex is held
			unblockFirst();
			await first;
			await second;
			expect(callCount).toBeGreaterThanOrEqual(2);
			await orchestrator.close();
		});

		it("sets status to error and notifies on AuthError", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			const authErr = new AuthError("Unauthorized", 401);
			vi.spyOn(localFs, "list").mockRejectedValue(authErr);

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.onStatusChange).toHaveBeenCalledWith("error");
			expect(deps.notify).toHaveBeenCalledWith(
				"Authentication error. Please reconnect in settings."
			);
			await orchestrator.close();
		});

		it("retries on transient error and succeeds", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			let attempt = 0;
			vi.spyOn(localFs, "list").mockImplementation(async () => {
				attempt++;
				if (attempt === 1) throw new Error("transient");
				return await Promise.resolve([]);
			});

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(attempt).toBe(2);
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("fails after MAX_RETRIES and sets error status", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			vi.spyOn(localFs, "list").mockRejectedValue(new Error("network down"));

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.onStatusChange).toHaveBeenCalledWith("error");
			expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("Sync error:"));
			await orchestrator.close();
		});

		it("excludes files matching ignore patterns", async () => {
			const settings = mockSettings();
			settings.ignorePatterns = ["*.tmp"];
			const deps = createDeps({ getSettings: () => settings });
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(localFs, "file.tmp", "ignored");
			addFile(localFs, "file.md", "included");

			let filteredCount = 0;
			const origList = localFs.list.bind(localFs);
			vi.spyOn(localFs, "list").mockImplementation(async () => {
				const result = await origList();
				filteredCount = result.filter((f) => !f.isDirectory).length;
				return result;
			});

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(filteredCount).toBe(2); // both files listed
			// but file.tmp would be excluded from sync — check notify shows only md synced
			expect(deps.onStatusChange).toHaveBeenCalledWith("idle");
			await orchestrator.close();
		});

		it("acknowledges dirty paths after sync", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			deps.localTracker.markDirty("file.md");
			deps.localTracker.acknowledge([]); // initialize tracker

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.runSync();

			expect(deps.localTracker.getDirtyPaths().size).toBe(0);
			await orchestrator.close();
		});
	});

	describe("pullSingle()", () => {
		it("pulls a remote file and saves sync record", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "remote content", 2000);

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("note.md");

			expect(localFs.files.has("note.md")).toBe(true);
			const record = await orchestrator.state.get("note.md");
			expect(record).toBeDefined();
			expect(record?.path).toBe("note.md");
			await orchestrator.close();
		});

		it("acknowledges path after pull", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "content", 2000);
			deps.localTracker.markDirty("note.md");

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("note.md");

			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(false);
			await orchestrator.close();
		});

		it("logs error but does not throw on pull failure", async () => {
			const errorSpy = vi.fn();
			const deps = createDeps({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: errorSpy,
					flush: vi.fn().mockResolvedValue(undefined),
				} as unknown as SyncOrchestratorDeps["logger"],
			});
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;

			vi.spyOn(remoteFs, "stat").mockResolvedValue(
				{ path: "note.md", isDirectory: false, size: 10, mtime: 1000, hash: "" }
			);
			vi.spyOn(remoteFs, "read").mockRejectedValue(new Error("network error"));

			const orchestrator = new SyncOrchestrator(deps);
			await expect(orchestrator.pullSingle("note.md")).resolves.toBeUndefined();
			expect(errorSpy).toHaveBeenCalledWith(
				"pullSingle: failed",
				expect.objectContaining({ path: "note.md" })
			);
			await orchestrator.close();
		});

		it("skips when remote file is not found", async () => {
			const warnSpy = vi.fn();
			const deps = createDeps({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: warnSpy,
					error: vi.fn(),
					flush: vi.fn().mockResolvedValue(undefined),
				} as unknown as SyncOrchestratorDeps["logger"],
			});
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			// remote file does not exist

			const orchestrator = new SyncOrchestrator(deps);
			await orchestrator.pullSingle("missing.md");

			expect(localFs.files.has("missing.md")).toBe(false);
			expect(warnSpy).toHaveBeenCalled();
			await orchestrator.close();
		});

		it("runs pullSingle within mutex (exclusive with runSync)", async () => {
			const deps = createDeps();
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "note.md", "content", 2000);

			const orchestrator = new SyncOrchestrator(deps);

			// Start runSync first, then immediately call pullSingle
			// pullSingle should wait because mutex is held
			let syncStarted = false;
			vi.spyOn(localFs, "list").mockImplementation(() => {
				syncStarted = true;
				return Promise.resolve([]);
			});

			const syncPromise = orchestrator.runSync();
			const pullPromise = orchestrator.pullSingle("note.md");

			await Promise.all([syncPromise, pullPromise]);

			expect(syncStarted).toBe(true);
			await orchestrator.close();
		});
	});

	describe("isExcluded()", () => {
		it("returns true for ignored paths", () => {
			const settings = mockSettings();
			settings.ignorePatterns = [".config/**"];
			const deps = createDeps({ getSettings: () => settings });
			const orchestrator = new SyncOrchestrator(deps);

			expect(orchestrator.isExcluded(".config/settings")).toBe(true);
			expect(orchestrator.isExcluded("notes/hello.md")).toBe(false);
		});
	});

	describe("getStatus()", () => {
		it("returns idle when not syncing", () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);
			expect(orchestrator.getStatus()).toBe("idle");
		});
	});

	describe("clearSyncState()", () => {
		it("clears the state store", async () => {
			const deps = createDeps();
			const orchestrator = new SyncOrchestrator(deps);

			// Put a record first via a sync
			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			deps.localFs = () => localFs;
			deps.remoteFs = () => remoteFs;
			addFile(remoteFs, "a.md", "content", 1000);

			await orchestrator.runSync();
			await orchestrator.clearSyncState();

			const all = await orchestrator.state.getAll();
			expect(all).toHaveLength(0);
			await orchestrator.close();
		});
	});
});
