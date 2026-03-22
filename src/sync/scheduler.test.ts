import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal window/document stubs for scheduler's event wiring
const windowListeners = new Map<string, EventListener>();
const documentListeners = new Map<string, EventListener>();

vi.stubGlobal("window", {
	addEventListener: (event: string, handler: EventListener) => { windowListeners.set(event, handler); },
	removeEventListener: (event: string, _handler: EventListener) => { windowListeners.delete(event); },
});

vi.stubGlobal("document", {
	visibilityState: "visible" as string,
	addEventListener: (event: string, handler: EventListener) => { documentListeners.set(event, handler); },
	removeEventListener: (event: string, _handler: EventListener) => { documentListeners.delete(event); },
});

import { SyncScheduler } from "./scheduler";
import type { SyncSchedulerDeps } from "./scheduler";
import type { EventRef, TAbstractFile } from "obsidian";
import { LocalChangeTracker } from "./local-tracker";
import { createMockFs, createMockStateStore } from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

type VaultHandler = (file: TAbstractFile) => void;
type RenameHandler = (file: TAbstractFile, oldPath: string) => void;
type WorkspaceHandler = (...args: unknown[]) => Promise<void> | void;

function createDeps(overrides: Partial<SyncSchedulerDeps> = {}) {
	const vaultHandlers = new Map<string, WorkspaceHandler>();
	const workspaceHandlers = new Map<string, WorkspaceHandler>();
	const cleanups: (() => void)[] = [];

	const runSync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	const pullSingle = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);

	const deps: SyncSchedulerDeps & {
		vaultHandlers: Map<string, WorkspaceHandler>;
		workspaceHandlers: Map<string, WorkspaceHandler>;
		cleanups: (() => void)[];
		runSync: typeof runSync;
		pullSingle: typeof pullSingle;
	} = {
		workspace: {
			on: vi.fn((event: string, handler: WorkspaceHandler) => {
				workspaceHandlers.set(event, handler);
				return {} as EventRef;
			}),
		} as unknown as SyncSchedulerDeps["workspace"],
		vault: {
			on: vi.fn((event: string, handler: WorkspaceHandler) => {
				vaultHandlers.set(event, handler);
				return {} as EventRef;
			}),
		} as unknown as SyncSchedulerDeps["vault"],
		localFs: () => createMockFs("local"),
		remoteFs: () => createMockFs("remote"),
		stateStore: createMockStateStore(),
		localTracker: new LocalChangeTracker(),
		orchestrator: { runSync, pullSingle, isSyncing: () => false },
		isExcluded: () => false,
		registerEvent: vi.fn(),
		register: vi.fn((cb: () => void) => { cleanups.push(cb); }),
		getSlowPollIntervalSec: () => 0,
		vaultHandlers,
		workspaceHandlers,
		cleanups,
		runSync,
		pullSingle,
		...overrides,
	};
	return deps;
}

function makeFile(path: string): TAbstractFile {
	return { path } as TAbstractFile;
}

describe("SyncScheduler", () => {
	let deps: ReturnType<typeof createDeps>;
	let scheduler: SyncScheduler;

	beforeEach(() => {
		vi.useFakeTimers();
		deps = createDeps();
		scheduler = new SyncScheduler(deps);
		scheduler.start();
	});

	describe("vault events", () => {
		it("marks path dirty on create", () => {
			const handler = deps.vaultHandlers.get("create") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("marks path dirty on modify", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("marks path dirty on delete", () => {
			const handler = deps.vaultHandlers.get("delete") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("marks both old and new paths dirty on rename", () => {
			const handler = deps.vaultHandlers.get("rename") as RenameHandler;
			handler(makeFile("new.md"), "old.md");
			expect(deps.localTracker.getDirtyPaths().has("new.md")).toBe(true);
			expect(deps.localTracker.getDirtyPaths().has("old.md")).toBe(true);
		});

		it("skips excluded paths", () => {
			scheduler.destroy();
			deps = createDeps({ isExcluded: (p: string) => p.startsWith("excluded/") });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("create") as VaultHandler;
			handler(makeFile("excluded/note.md"));
			expect(deps.localTracker.getDirtyPaths().has("excluded/note.md")).toBe(false);
		});

		it("triggers sync via heartbeat after debounce window", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("coalesces rapid vault changes into a single sync", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("a.md"));
			vi.advanceTimersByTime(2000);
			handler(makeFile("b.md"));
			vi.advanceTimersByTime(2000);
			handler(makeFile("c.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("does not trigger sync for excluded paths", () => {
			scheduler.destroy();
			deps = createDeps({ isExcluded: () => true });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("ignored.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("skips sync via heartbeat when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("skips sync via heartbeat when already syncing", () => {
			scheduler.destroy();
			deps = createDeps({ orchestrator: { runSync: vi.fn().mockResolvedValue(undefined), pullSingle: vi.fn().mockResolvedValue(undefined), isSyncing: () => true } });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("file-open priority sync", () => {
		it("pulls when remote changed but local unchanged", async () => {
			const record: SyncRecord = {
				path: "note.md", hash: "abc", localMtime: 1000,
				remoteMtime: 1000, localSize: 10, remoteSize: 10, syncedAt: 900,
			};
			await deps.stateStore.put(record);

			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			localFs.files.set("note.md", {
				content: new ArrayBuffer(10),
				entity: { path: "note.md", isDirectory: false, size: 10, mtime: 1000, hash: "" },
			});
			remoteFs.files.set("note.md", {
				content: new ArrayBuffer(15),
				entity: { path: "note.md", isDirectory: false, size: 15, mtime: 2000, hash: "" },
			});

			scheduler.destroy();
			deps = createDeps({
				stateStore: deps.stateStore,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
			});
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler({ path: "note.md" });

			expect(deps.pullSingle).toHaveBeenCalledWith("note.md");
		});

		it("skips pull when no sync record", async () => {
			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler({ path: "unknown.md" });
			expect(deps.pullSingle).not.toHaveBeenCalled();
		});

		it("skips pull when file is null", async () => {
			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler(null);
			expect(deps.pullSingle).not.toHaveBeenCalled();
		});
	});

	describe("focus event", () => {
		it("triggers immediate sync when window gains focus", () => {
			const handler = windowListeners.get("focus");
			expect(handler).toBeDefined();
			handler!(new Event("focus"));
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on focus when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = windowListeners.get("focus");
			handler!(new Event("focus"));
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("online event", () => {
		it("triggers sync on network restore", () => {
			const handler = windowListeners.get("online");
			expect(handler).toBeDefined();
			handler!(new Event("online"));
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on online event when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = windowListeners.get("online");
			handler!(new Event("online"));
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("visibility event", () => {
		it("triggers immediate sync when app becomes visible", () => {
			const handler = documentListeners.get("visibilitychange");
			expect(handler).toBeDefined();
			handler!(new Event("visibilitychange"));
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on visibility change when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = documentListeners.get("visibilitychange");
			handler!(new Event("visibilitychange"));
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("slow poll", () => {
		it("does not poll when slowPollIntervalSec is 0", () => {
			// interval is 0 (default in createDeps), so slow poll is disabled
			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(300_000); // 5 minutes
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("triggers sync after slow poll interval elapses since last sync", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 60 });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(59_000);
			expect(deps.runSync).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1_000); // now at 60s
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("does not fire before interval elapses", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 60 });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(59_999);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("resets interval when notifySyncComplete is called again", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 60 });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(30_000);
			// A local-change sync finishes partway through the interval
			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(30_000); // only 30s since last completion
			expect(deps.runSync).not.toHaveBeenCalled();

			vi.advanceTimersByTime(30_000); // now 60s since last completion
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("does not poll when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 60, remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(120_000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("does not poll when already syncing", () => {
			const runSync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
			scheduler.destroy();
			deps = createDeps({
				getSlowPollIntervalSec: () => 60,
				orchestrator: { runSync, pullSingle: vi.fn().mockResolvedValue(undefined), isSyncing: () => true },
			});
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			scheduler.notifySyncComplete();
			vi.advanceTimersByTime(120_000);
			expect(runSync).not.toHaveBeenCalled();
		});

		it("debounce-triggered sync takes priority over slow poll in same tick", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 5 });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			// Vault change schedules debounce sync at now+5s; slow poll also due at now+5s
			scheduler.notifySyncComplete();
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			// Both conditions met but heartbeat should fire runSync exactly once per tick
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});
	});

	describe("destroy", () => {
		it("stops heartbeat and prevents further syncs", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			scheduler.destroy();
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("stops slow poll after destroy", () => {
			scheduler.destroy();
			deps = createDeps({ getSlowPollIntervalSec: () => 60 });
			scheduler = new SyncScheduler(deps);
			scheduler.start();
			scheduler.notifySyncComplete();

			scheduler.destroy();
			vi.advanceTimersByTime(120_000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});
});
