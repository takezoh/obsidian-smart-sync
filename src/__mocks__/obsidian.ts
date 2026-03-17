// Minimal mock of obsidian module for testing

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, ms: number, _immediate?: boolean): T & { cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const debounced = (...args: unknown[]) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
	debounced.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
	return debounced as unknown as T & { cancel: () => void };
}

export const requestUrl = async (_opts: unknown): Promise<unknown> => {
	throw new Error("requestUrl not mocked for this test");
};

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class Modal {
	app: unknown;
	constructor(app: unknown) { this.app = app; }
	open() {}
	close() {}
	get contentEl(): HTMLElement { return document.createElement("div"); }
}

export class Setting {
	constructor(_containerEl: HTMLElement) {}
	setName(_name: string) { return this; }
	setDesc(_desc: string) { return this; }
	setHeading() { return this; }
	addButton(_cb: (b: unknown) => unknown) { return this; }
	addText(_cb: (t: unknown) => unknown) { return this; }
	addDropdown(_cb: (d: unknown) => unknown) { return this; }
	addToggle(_cb: (t: unknown) => unknown) { return this; }
	addTextArea(_cb: (t: unknown) => unknown) { return this; }
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
};

export class TFile {
	path: string;
	stat: { size: number; mtime: number };
	constructor(path: string, size = 0, mtime = 0) {
		this.path = path;
		this.stat = { size, mtime };
	}
}

export class TFolder {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

/** In-memory Vault mock for unit tests */
export class Vault {
	private files = new Map<string, { type: "file" | "folder"; content?: ArrayBuffer; mtime?: number }>();
	adapter = {
		exists: async (path: string): Promise<boolean> => {
			return this.files.has(path);
		},
		stat: async (path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null> => {
			const entry = this.files.get(path);
			if (!entry) return null;
			return {
				type: entry.type,
				size: entry.content?.byteLength ?? 0,
				mtime: entry.mtime ?? 0,
			};
		},
		readBinary: async (path: string): Promise<ArrayBuffer> => {
			const entry = this.files.get(path);
			if (!entry || entry.type !== "file") throw new Error(`File not found: ${path}`);
			return entry.content ?? new ArrayBuffer(0);
		},
		list: async (dir: string): Promise<{ files: string[]; folders: string[] }> => {
			const files: string[] = [];
			const folders: string[] = [];
			const prefix = dir + "/";
			for (const [p, entry] of this.files) {
				if (p.startsWith(prefix) && !p.substring(prefix.length).includes("/")) {
					if (entry.type === "folder") folders.push(p);
					else files.push(p);
				}
			}
			return { files, folders };
		},
		writeBinary: async (path: string, data: ArrayBuffer, options?: { mtime?: number }): Promise<void> => {
			this.files.set(path, { type: "file", content: data, mtime: options?.mtime });
		},
		remove: async (path: string): Promise<void> => {
			this.files.delete(path);
		},
		rmdir: async (path: string, _recursive?: boolean): Promise<void> => {
			const prefix = path + "/";
			const toDelete: string[] = [];
			for (const key of this.files.keys()) {
				if (key === path || key.startsWith(prefix)) {
					toDelete.push(key);
				}
			}
			for (const key of toDelete) {
				this.files.delete(key);
			}
		},
	};

	getName(): string {
		return "test-vault";
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		// Real Obsidian excludes dot-prefixed paths from the vault index
		if (path.startsWith(".")) return null;
		const entry = this.files.get(path);
		if (!entry) return null;
		if (entry.type === "folder") return new TFolder(path);
		const f = new TFile(path, entry.content?.byteLength ?? 0, entry.mtime ?? 0);
		return f;
	}

	async createFolder(path: string): Promise<TFolder> {
		if (this.files.has(path)) {
			throw new Error("Folder already exists.");
		}
		this.files.set(path, { type: "folder" });
		return new TFolder(path);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const entry = this.files.get(file.path);
		if (!entry || entry.type !== "file") throw new Error(`File not found: ${file.path}`);
		return entry.content ?? new ArrayBuffer(0);
	}

	async createBinary(path: string, content: ArrayBuffer, options?: { mtime?: number }): Promise<TFile> {
		this.files.set(path, { type: "file", content, mtime: options?.mtime });
		return new TFile(path, content.byteLength, options?.mtime ?? 0);
	}

	async modifyBinary(file: TFile, content: ArrayBuffer, options?: { mtime?: number }): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry || entry.type !== "file") throw new Error(`File not found: ${file.path}`);
		entry.content = content;
		if (options?.mtime !== undefined) entry.mtime = options.mtime;
	}

	getAllLoadedFiles(): (TFile | TFolder)[] {
		const result: (TFile | TFolder)[] = [];
		for (const [path, entry] of this.files) {
			// Real Obsidian excludes dot-prefixed paths from the vault index
			if (path.startsWith(".")) continue;
			if (entry.type === "folder") {
				result.push(new TFolder(path));
			} else {
				result.push(new TFile(path, entry.content?.byteLength ?? 0, entry.mtime ?? 0));
			}
		}
		return result;
	}

	async rename(file: TFile | TFolder, newPath: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`File not found: ${file.path}`);
		this.files.delete(file.path);
		this.files.set(newPath, entry);
	}
}

export class App {
	vault: Vault;
	fileManager = {
		trashFile: async (_file: TFile | TFolder) => {},
	};
	constructor() {
		this.vault = new Vault();
	}
}

export class PluginSettingTab {
	app: unknown;
	constructor(app: unknown, _plugin: unknown) { this.app = app; }
	display() {}
	get containerEl(): HTMLElement { return document.createElement("div"); }
}
