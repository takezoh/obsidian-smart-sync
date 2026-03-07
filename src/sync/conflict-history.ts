import type { LoggerAdapter } from "../logging/logger";
import type { ConflictRecord } from "./types";

const CONFLICT_FILE = ".smartsync/conflicts.json";
const MAX_RECORDS = 500;

export class ConflictHistory {
	private adapter: LoggerAdapter;

	constructor(adapter: LoggerAdapter) {
		this.adapter = adapter;
	}

	async load(): Promise<ConflictRecord[]> {
		try {
			if (!(await this.adapter.exists(CONFLICT_FILE))) {
				return [];
			}
			const raw = await this.adapter.read(CONFLICT_FILE);
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

		if (!(await this.adapter.exists(".smartsync"))) {
			await this.adapter.mkdir(".smartsync");
		}

		await this.adapter.write(CONFLICT_FILE, JSON.stringify(capped, null, 2));
	}
}
