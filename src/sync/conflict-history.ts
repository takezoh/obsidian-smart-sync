import type { LoggerAdapter } from "../logging/logger";
import type { ConflictRecord } from "./types";

const CONFLICTS_DIR = ".airsync/conflicts";
const MAX_RECORDS = 500;

export class ConflictHistory {
	private adapter: LoggerAdapter;
	private filePath: string;

	/** @param deviceName must be pre-sanitized (e.g. via Logger.sanitizedDeviceName) */
	constructor(adapter: LoggerAdapter, deviceName: string) {
		this.adapter = adapter;
		this.filePath = `${CONFLICTS_DIR}/${deviceName}.json`;
	}

	async load(): Promise<ConflictRecord[]> {
		try {
			if (!(await this.adapter.exists(this.filePath))) {
				return [];
			}
			const raw = await this.adapter.read(this.filePath);
			return JSON.parse(raw) as ConflictRecord[];
		} catch {
			return [];
		}
	}

	async append(records: ConflictRecord[]): Promise<void> {
		if (records.length === 0) return;

		const existing = await this.load();
		const combined = [...existing, ...records];
		const capped = combined.length > MAX_RECORDS
			? combined.slice(combined.length - MAX_RECORDS)
			: combined;

		if (!(await this.adapter.exists(".airsync"))) {
			await this.adapter.mkdir(".airsync");
		}
		if (!(await this.adapter.exists(CONFLICTS_DIR))) {
			await this.adapter.mkdir(CONFLICTS_DIR);
		}

		await this.adapter.write(this.filePath, JSON.stringify(capped, null, 2));
	}
}
