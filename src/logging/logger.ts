import type { AirSyncSettings } from "../settings";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface LoggerAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/**
 * Sanitize a device name for use as a directory name.
 * Replaces characters that are unsafe in file paths with hyphens,
 * collapses runs, trims, lowercases, and falls back to "unknown".
 */
function sanitizeDeviceName(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "unknown";
}

/**
 * Detect a device name for the current platform.
 * Returns "{device}-{vaultId}" when a vaultId is provided so that
 * logs and conflict history are scoped per device AND per vault.
 */
export function getDeviceName(isMobile: boolean, vaultId?: string): string {
	const device = isMobile ? "mobile" : "desktop";
	return vaultId ? `${device}-${vaultId}` : device;
}

export class Logger {
	private buffer: string[] = [];
	private _deviceName: string;
	private _adapter: LoggerAdapter;
	private getSettings: () => AirSyncSettings;
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		adapter: LoggerAdapter,
		getSettings: () => AirSyncSettings,
		deviceName: string,
	) {
		this._adapter = adapter;
		this.getSettings = getSettings;
		this._deviceName = sanitizeDeviceName(deviceName);
		this.flushTimer = setInterval(() => {
			void this.flush();
		}, 30_000);
	}

	get adapter(): LoggerAdapter { return this._adapter; }
	get sanitizedDeviceName(): string { return this._deviceName; }

	debug(message: string, context?: Record<string, unknown>): void {
		this.log("debug", message, context);
	}

	info(message: string, context?: Record<string, unknown>): void {
		this.log("info", message, context);
	}

	warn(message: string, context?: Record<string, unknown>): void {
		this.log("warn", message, context);
	}

	error(message: string, context?: Record<string, unknown>): void {
		this.log("error", message, context);
	}

	private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		const settings = this.getSettings();
		if (!settings.enableLogging) return;
		if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[settings.logLevel]) return;

		const timestamp = new Date().toISOString();
		const tag = level.toUpperCase();
		let line = `[${timestamp}] [${tag}] ${message}`;
		if (context) {
			line += ` ${JSON.stringify(context)}`;
		}
		this.buffer.push(line);

		// Mirror to developer console
		const consoleFn = level === "error" ? console.error
			: level === "warn" ? console.warn
			: console.debug;
		if (context) {
			consoleFn(`Air Sync: ${message}`, context);
		} else {
			consoleFn(`Air Sync: ${message}`);
		}
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		const lines = this.buffer;
		this.buffer = [];

		const date = new Date().toISOString().slice(0, 10);
		const logsDir = ".airsync/logs";
		const dir = `${logsDir}/${this._deviceName}`;
		const filePath = `${dir}/${date}.log`;

		try {
			// Ensure directories exist
			if (!(await this._adapter.exists(".airsync"))) {
				await this._adapter.mkdir(".airsync");
			}
			if (!(await this._adapter.exists(logsDir))) {
				await this._adapter.mkdir(logsDir);
			}
			if (!(await this._adapter.exists(dir))) {
				await this._adapter.mkdir(dir);
			}

			let existing = "";
			if (await this._adapter.exists(filePath)) {
				existing = await this._adapter.read(filePath);
			}

			const content = existing + lines.join("\n") + "\n";
			await this._adapter.write(filePath, content);
		} catch {
			// Logging should never break the app — silently drop on failure
		}
	}

	dispose(): void {
		if (this.flushTimer !== null) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
	}
}
