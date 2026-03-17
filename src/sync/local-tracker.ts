export class LocalChangeTracker {
	private dirtyPaths = new Set<string>();
	private initialized = false;

	markDirty(path: string): void {
		this.dirtyPaths.add(path);
	}

	getDirtyPaths(): ReadonlySet<string> {
		return this.dirtyPaths;
	}

	acknowledge(paths: Iterable<string>): void {
		for (const p of paths) this.dirtyPaths.delete(p);
		this.initialized = true;
	}

	isInitialized(): boolean {
		return this.initialized;
	}
}
