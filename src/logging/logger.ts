import type { SmartSyncSettings } from "../settings";

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

export class Logger {
	private buffer: string[] = [];
	private deviceName: string;
	private adapter: LoggerAdapter;
	private getSettings: () => SmartSyncSettings;
	private flushTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		adapter: LoggerAdapter,
		getSettings: () => SmartSyncSettings,
		isMobile: boolean,
	) {
		this.adapter = adapter;
		this.getSettings = getSettings;
		this.deviceName = isMobile ? "mobile" : "desktop";
		this.flushTimer = setInterval(() => {
			void this.flush();
		}, 30_000);
	}

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
	}

	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;

		const lines = this.buffer;
		this.buffer = [];

		const date = new Date().toISOString().slice(0, 10);
		const dir = `.smartsync/${this.deviceName}`;
		const filePath = `${dir}/${date}.log`;

		try {
			// Ensure directories exist
			if (!(await this.adapter.exists(".smartsync"))) {
				await this.adapter.mkdir(".smartsync");
			}
			if (!(await this.adapter.exists(dir))) {
				await this.adapter.mkdir(dir);
			}

			let existing = "";
			if (await this.adapter.exists(filePath)) {
				existing = await this.adapter.read(filePath);
			}

			const content = existing + lines.join("\n") + "\n";
			await this.adapter.write(filePath, content);
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
