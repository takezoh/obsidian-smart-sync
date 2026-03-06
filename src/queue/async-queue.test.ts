import { describe, it, expect } from "vitest";
import { AsyncMutex, AsyncPool } from "./async-queue";

/** Helper that creates a promise resolvable from outside */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("AsyncMutex", () => {
	it("run() returns the callback value", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.run(() => Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("run() accepts a synchronous callback", async () => {
		const mutex = new AsyncMutex();
		const result = await mutex.run(() => "sync-value");
		expect(result).toBe("sync-value");
	});

	it("isLocked is false when idle, true during execution", async () => {
		const mutex = new AsyncMutex();
		expect(mutex.isLocked).toBe(false);

		const { promise: gate, resolve: openGate } = deferred();
		const running = mutex.run(() => gate);

		expect(mutex.isLocked).toBe(true);
		openGate(undefined);
		await running;
		expect(mutex.isLocked).toBe(false);
	});

	it("concurrent run() calls execute in FIFO order", async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];

		const { promise: gate1, resolve: open1 } = deferred();
		const { promise: gate2, resolve: open2 } = deferred();
		const { promise: gate3, resolve: open3 } = deferred();

		const p1 = mutex.run(async () => {
			await gate1;
			order.push(1);
		});
		const p2 = mutex.run(async () => {
			await gate2;
			order.push(2);
		});
		const p3 = mutex.run(async () => {
			await gate3;
			order.push(3);
		});

		// Only p1 should be running; p2 and p3 are queued.
		open1(undefined);
		await p1;

		// Now p2 should be running.
		open2(undefined);
		await p2;

		// Now p3.
		open3(undefined);
		await p3;

		expect(order).toEqual([1, 2, 3]);
	});

	it("releases the lock when callback throws", async () => {
		const mutex = new AsyncMutex();

		await expect(
			mutex.run(() => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");

		expect(mutex.isLocked).toBe(false);
	});

	it("next run() succeeds after a previous run() threw", async () => {
		const mutex = new AsyncMutex();

		await expect(
			mutex.run(() => {
				throw new Error("fail");
			})
		).rejects.toThrow("fail");

		const result = await mutex.run(() => "recovered");
		expect(result).toBe("recovered");
	});

	it("many queued callers complete in order", async () => {
		const mutex = new AsyncMutex();
		const order: number[] = [];
		const count = 20;

		const promises = Array.from({ length: count }, (_, i) =>
			mutex.run(async () => {
				// Yield to simulate async work
				await Promise.resolve();
				order.push(i);
			})
		);

		await Promise.all(promises);
		expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
		expect(mutex.isLocked).toBe(false);
	});
});

describe("AsyncPool", () => {
	it("throws when concurrency is less than 1", () => {
		expect(() => new AsyncPool(0)).toThrow("concurrency must be at least 1");
		expect(() => new AsyncPool(-1)).toThrow("concurrency must be at least 1");
	});

	it("returns the callback value", async () => {
		const pool = new AsyncPool(2);
		const result = await pool.run(() => Promise.resolve(42));
		expect(result).toBe(42);
	});

	it("respects concurrency limit", async () => {
		const pool = new AsyncPool(2);
		let running = 0;
		let maxRunning = 0;

		const task = async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			running--;
		};

		await Promise.all(
			Array.from({ length: 5 }, () => pool.run(task))
		);

		expect(maxRunning).toBe(2);
	});

	it("propagates errors without breaking the pool", async () => {
		const pool = new AsyncPool(2);

		await expect(
			pool.run(() => Promise.reject(new Error("boom")))
		).rejects.toThrow("boom");

		// Pool should still work after error
		const result = await pool.run(() => Promise.resolve("ok"));
		expect(result).toBe("ok");
	});

	it("all tasks complete even when some fail", async () => {
		const pool = new AsyncPool(2);
		const completed: number[] = [];

		const promises = [0, 1, 2, 3].map((i) =>
			pool.run(async () => {
				if (i === 1) throw new Error("fail");
				completed.push(i);
			}).catch(() => { /* swallow */ })
		);

		await Promise.all(promises);
		expect(completed).toEqual(expect.arrayContaining([0, 2, 3]));
		expect(completed).toHaveLength(3);
	});
});
