import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger, LoggerAdapter, getDeviceName } from "./logger";
import type { SmartSyncSettings } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";

function createMockAdapter(): LoggerAdapter & {
	written: Map<string, string>;
	dirs: Set<string>;
} {
	const written = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		written,
		dirs,
		exists: vi.fn(async (path: string) => written.has(path) || dirs.has(path)),
		read: vi.fn(async (path: string) => written.get(path) ?? ""),
		write: vi.fn(async (path: string, data: string) => {
			written.set(path, data);
		}),
		mkdir: vi.fn(async (path: string) => {
			dirs.add(path);
		}),
	};
}

function createSettings(overrides: Partial<SmartSyncSettings> = {}): SmartSyncSettings {
	return { ...DEFAULT_SETTINGS, enableLogging: true, ...overrides };
}

describe("Logger", () => {
	let adapter: ReturnType<typeof createMockAdapter>;
	let settings: SmartSyncSettings;
	let logger: Logger;

	beforeEach(() => {
		adapter = createMockAdapter();
		settings = createSettings();
		logger = new Logger(adapter, () => settings, "desktop");
	});

	afterEach(() => {
		logger.dispose();
	});

	it("writes buffered log lines on flush", async () => {
		logger.info("test message");
		logger.warn("another message");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\.smartsync\/desktop\/\d{4}-\d{2}-\d{2}\.log$/);

		const content = adapter.written.get(files[0] ?? "")!;
		expect(content).toContain("[INFO] test message");
		expect(content).toContain("[WARN] another message");
	});

	it("includes context as JSON", async () => {
		logger.error("fail", { status: 401 });
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).toContain('[ERROR] fail {"status":401}');
	});

	it("uses provided device name for log directory", async () => {
		logger.dispose();
		logger = new Logger(adapter, () => settings, "My iPhone");
		logger.info("mobile log");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".smartsync/my-iphone/");
	});

	it("sanitizes unsafe characters in device name", async () => {
		logger.dispose();
		logger = new Logger(adapter, () => settings, "PC/Work:Station\\1");
		logger.info("test");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".smartsync/pc-work-station-1/");
	});

	it("falls back to 'unknown' for empty device name", async () => {
		logger.dispose();
		logger = new Logger(adapter, () => settings, "");
		logger.info("test");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".smartsync/unknown/");
	});

	it("filters logs below configured level", async () => {
		settings.logLevel = "warn";

		logger.debug("should be skipped");
		logger.info("also skipped");
		logger.warn("included");
		logger.error("also included");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).not.toContain("[DEBUG]");
		expect(content).not.toContain("[INFO]");
		expect(content).toContain("[WARN] included");
		expect(content).toContain("[ERROR] also included");
	});

	it("is a no-op when logging is disabled", async () => {
		settings.enableLogging = false;

		logger.info("should not appear");
		logger.error("also not");
		await logger.flush();

		expect(adapter.written.size).toBe(0);
	});

	it("appends to existing log file", async () => {
		logger.info("first");
		await logger.flush();

		logger.info("second");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).toContain("[INFO] first");
		expect(content).toContain("[INFO] second");
	});

	it("creates directories if they do not exist", async () => {
		logger.info("test");
		await logger.flush();

		expect(adapter.dirs.has(".smartsync")).toBe(true);
		expect(adapter.dirs.has(".smartsync/desktop")).toBe(true);
	});

	it("getDeviceName returns 'mobile-{vaultId}' on mobile with vaultId", () => {
		expect(getDeviceName(true, "abc123")).toBe("mobile-abc123");
	});

	it("getDeviceName returns 'mobile' on mobile without vaultId", () => {
		expect(getDeviceName(true)).toBe("mobile");
	});

	it("getDeviceName returns hostname on desktop", () => {
		const name = getDeviceName(false);
		expect(name).toBeTruthy();
		expect(name).not.toBe("mobile");
	});

	it("formats timestamp in ISO format", async () => {
		logger.info("timestamped");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		// Match ISO timestamp pattern: [YYYY-MM-DDTHH:MM:SS.mmmZ]
		expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
	});
});
