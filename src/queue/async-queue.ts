/**
 * Promise-based mutual exclusion lock.
 *
 * **Non-reentrant** – calling `run()` from within a `run()` callback on the
 * same instance will deadlock. Design callers so that nested locking is
 * never required.
 */
export class AsyncMutex {
	private locked = false;
	private waiting: (() => void)[] = [];

	/** Acquire the lock. Resolves when the lock is available. */
	private async acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return;
		}
		return new Promise<void>((resolve) => {
			this.waiting.push(resolve);
		});
	}

	/**
	 * Release the lock, allowing the next waiter to proceed.
	 *
	 * @throws {Error} If the lock is not currently held.
	 */
	private release(): void {
		if (!this.locked) {
			throw new Error("AsyncMutex.release() called while not locked");
		}
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.locked = false;
		}
	}

	/**
	 * Execute a callback while holding the lock.
	 *
	 * The lock is always released after `fn` settles, even if it throws.
	 * Accepts both synchronous and asynchronous callbacks.
	 */
	async run<T>(fn: () => T | Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/** Check if the lock is currently held. */
	get isLocked(): boolean {
		return this.locked;
	}
}
