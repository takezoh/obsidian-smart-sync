import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackendManager, BackendManagerDeps } from "./backend-manager";
import type { IBackendProvider } from "./backend";
import type { SmartSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { Logger } from "../logging/logger";

// Mock the registry to return our fake provider
vi.mock("./registry", () => ({
	getBackendProvider: (type: string) => {
		if (type === "test") return fakeProvider;
		return undefined;
	},
}));

let fakeProvider: IBackendProvider;
let fakeFs: IFileSystem;

function mockSettings(overrides: Partial<SmartSyncSettings> = {}): SmartSyncSettings {
	return {
		vaultId: "test-vault",
		backendType: "test",
		ignorePatterns: [],
		syncDotPaths: [],
		conflictStrategy: "keep_newer",
		enableThreeWayMerge: false,
		autoSyncIntervalMinutes: 0,
		mobileMaxFileSizeMB: 10,
		enableLogging: false,
		logLevel: "info",
		backendData: {},
		...overrides,
	};
}

function createDeps(settings: SmartSyncSettings, overrides: Partial<BackendManagerDeps> = {}): BackendManagerDeps {
	const noopLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		flush: vi.fn(),
	} as unknown as Logger;

	return {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({})) as unknown as BackendManagerDeps["getApp"],
		getLogger: () => noopLogger,
		getVaultName: () => "Test Vault",
		onConnected: vi.fn(),
		onDisconnected: vi.fn(),
		onIdentityChanged: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		refreshSettingsDisplay: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	fakeFs = {
		name: "test-remote",
		list: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockResolvedValue(null),
		read: vi.fn(),
		write: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
		rename: vi.fn(),
	} as unknown as IFileSystem;

	fakeProvider = {
		type: "test",
		displayName: "Test",
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn(),
		},
		createFs: () => fakeFs,
		isConnected: () => true,
		getIdentity: () => "test:folder-A",
		resetTargetState: vi.fn(),
		disconnect: vi.fn().mockResolvedValue({}),
	};
});

describe("BackendManager — identity change triggers onIdentityChanged", () => {
	it("does not call onIdentityChanged on first initBackend call", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
		expect(deps.onConnected).toHaveBeenCalled();
	});

	it("calls onIdentityChanged when identity changes between initBackend calls", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		// Change identity
		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);
	});

	it("does not call onIdentityChanged when identity stays the same", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls onIdentityChanged and resets identity on disconnect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.disconnectBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);

		// After disconnect, re-init should not trigger another callback
		// (lastBackendIdentity was reset to null)
		(deps.onIdentityChanged as ReturnType<typeof vi.fn>).mockClear();
		await mgr.initBackend();
		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls provider.resetTargetState on identity change", async () => {
		const resetSpy = vi.fn();
		fakeProvider.resetTargetState = resetSpy;

		const settings = mockSettings({
			backendData: {
				test: { changesStartPageToken: "old-token", other: "keep" },
			},
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(resetSpy).toHaveBeenCalledTimes(1);
		expect(resetSpy).toHaveBeenCalledWith(settings);
	});
});

describe("BackendManager — auth error notification on initBackend", () => {
	it("notifies user when initBackend fails with status 400", async () => {
		fakeProvider.resolveRemoteVault = async () => {
			const err = new Error("Request failed, status 400");
			(err as Error & { status: number }).status = 400;
			throw err;
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings."
		);
	});

	it("does not notify for non-auth errors", async () => {
		fakeProvider.resolveRemoteVault = async () => {
			const err = new Error("Network error");
			(err as Error & { status: number }).status = 503;
			throw err;
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
	});
});
