import { describe, it, expect, vi } from "vitest";
import { executePlan } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import type { SyncAction, SyncPlan } from "./types";
import { createMockFs, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import type { SyncStateStore } from "./state";
import { AuthError } from "../fs/errors";

function makeCtx(
	overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	const stateStore = createMockStateStore();
	return {
		localFs,
		remoteFs,
		committer: {
			stateStore: stateStore as unknown as SyncStateStore,
		},
		conflictStrategy: "auto_merge",
		...overrides,
	};
}

function makePlan(actions: SyncAction[], overrides: Partial<SyncPlan["safetyCheck"]> = {}): SyncPlan {
	return {
		actions,
		safetyCheck: {
			shouldAbort: false,
			requiresConfirmation: false,
			...overrides,
		},
	};
}

describe("executePlan", () => {
	describe("safety checks", () => {
		it("returns empty result immediately when shouldAbort is true", async () => {
			const ctx = makeCtx();
			const plan = makePlan(
				[{ path: "a.md", action: "push" }],
				{ shouldAbort: true },
			);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
		});

		it("proceeds when requiresConfirmation is true and user confirms", async () => {
			const ctx = makeCtx({
				onConfirmation: () => Promise.resolve(true),
			});
			addFile(ctx.localFs as ReturnType<typeof createMockFs>, "a.md", "hello");
			const plan = makePlan(
				[{ path: "a.md", action: "push", local: { path: "a.md", isDirectory: false, size: 5, mtime: 1000, hash: "" } }],
				{ requiresConfirmation: true },
			);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
		});

		it("aborts when requiresConfirmation is true and user rejects", async () => {
			const ctx = makeCtx({
				onConfirmation: () => Promise.resolve(false),
			});
			const plan = makePlan(
				[{ path: "a.md", action: "push" }],
				{ requiresConfirmation: true },
			);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(0);
		});

		it("proceeds without confirmation callback even when requiresConfirmation is true", async () => {
			const ctx = makeCtx();
			addFile(ctx.localFs as ReturnType<typeof createMockFs>, "a.md", "hello");
			const plan = makePlan(
				[{ path: "a.md", action: "push", local: { path: "a.md", isDirectory: false, size: 5, mtime: 1000, hash: "" } }],
				{ requiresConfirmation: true },
			);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
		});
	});

	describe("push", () => {
		it("uploads local file to remote and commits state", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "a.md", "content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "a.md",
				action: "push",
				local: { path: "a.md", isDirectory: false, size: 7, mtime: 1000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect(remoteFs.files.has("a.md")).toBe(true);
			expect(stateStore.records.has("a.md")).toBe(true);
		});
	});

	describe("pull", () => {
		it("downloads remote file to local and commits state", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "b.md", "remote content");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;

			const plan = makePlan([{
				path: "b.md",
				action: "pull",
				remote: { path: "b.md", isDirectory: false, size: 14, mtime: 2000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
			expect((ctx.localFs as ReturnType<typeof createMockFs>).files.has("b.md")).toBe(true);
			expect(stateStore.records.has("b.md")).toBe(true);
		});
	});

	describe("match", () => {
		it("commits state without file I/O", async () => {
			const ctx = makeCtx();
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			const local = { path: "c.md", isDirectory: false, size: 5, mtime: 1000, hash: "abc" };
			const remote = { path: "c.md", isDirectory: false, size: 5, mtime: 1000, hash: "abc" };

			const plan = makePlan([{ path: "c.md", action: "match", local, remote }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("c.md")).toBe(true);
		});
	});

	describe("delete_remote", () => {
		it("deletes remote file and removes state record", async () => {
			const ctx = makeCtx();
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "d.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("d.md", {
				path: "d.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "d.md", action: "delete_remote" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(remoteFs.files.has("d.md")).toBe(false);
			expect(stateStore.records.has("d.md")).toBe(false);
		});
	});

	describe("delete_local", () => {
		it("deletes local file and removes state record", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "e.md", "to delete");
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("e.md", {
				path: "e.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 9, remoteSize: 9, syncedAt: 900,
			});

			const plan = makePlan([{ path: "e.md", action: "delete_local" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(localFs.files.has("e.md")).toBe(false);
			expect(stateStore.records.has("e.md")).toBe(false);
		});
	});

	describe("cleanup", () => {
		it("removes state record without file I/O", async () => {
			const ctx = makeCtx();
			const stateStore = ctx.committer.stateStore as unknown as ReturnType<typeof createMockStateStore>;
			stateStore.records.set("f.md", {
				path: "f.md", hash: "", localMtime: 1000, remoteMtime: 1000,
				localSize: 0, remoteSize: 0, syncedAt: 900,
			});

			const plan = makePlan([{ path: "f.md", action: "cleanup" }]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(1);
			expect(stateStore.records.has("f.md")).toBe(false);
		});
	});

	describe("conflict", () => {
		it("resolves conflict and records it in both succeeded and conflicts arrays", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "g.md", "local version");
			addFile(remoteFs, "g.md", "remote version");

			const plan = makePlan([{
				path: "g.md",
				action: "conflict",
				local: { path: "g.md", isDirectory: false, size: 13, mtime: 2000, hash: "local-hash" },
				remote: { path: "g.md", isDirectory: false, size: 14, mtime: 1500, hash: "remote-hash" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.conflicts).toHaveLength(1);
			expect(result.succeeded).toHaveLength(1);
			expect(result.failed).toHaveLength(0);
		});

		it("records conflict in failed array when resolveConflictV2 throws a non-Auth error", async () => {
			const ctx = makeCtx({ conflictStrategy: "duplicate" });
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "err.md", "local version");
			addFile(remoteFs, "err.md", "remote version");

			// Force localFs.read to throw a non-Auth error to simulate conflict resolution failure
			vi.spyOn(localFs, "read").mockRejectedValueOnce(new Error("I/O error"));

			const plan = makePlan([{
				path: "err.md",
				action: "conflict",
				local: { path: "err.md", isDirectory: false, size: 13, mtime: 2000, hash: "local-hash" },
				remote: { path: "err.md", isDirectory: false, size: 14, mtime: 1500, hash: "remote-hash" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]!.action.path).toBe("err.md");
			expect(result.conflicts).toHaveLength(0);
			expect(result.succeeded).toHaveLength(0);
		});
	});

	describe("error isolation", () => {
		it("records failed action and continues processing remaining actions", async () => {
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "good.md", "good content");

			const plan = makePlan([
				{
					path: "missing.md",
					action: "push",
					local: { path: "missing.md", isDirectory: false, size: 10, mtime: 1000, hash: "" },
				},
				{
					path: "good.md",
					action: "push",
					local: { path: "good.md", isDirectory: false, size: 12, mtime: 1000, hash: "" },
				},
			]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]!.action.path).toBe("missing.md");
			expect(result.succeeded).toHaveLength(1);
			expect(result.succeeded[0]!.action.path).toBe("good.md");
		});

		it("aborts immediately on AuthError during Group A (push)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);

			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			// Use path-based logic so the correct file triggers AuthError regardless of concurrency order
			vi.spyOn(localFs, "read").mockImplementation((path: string) => {
				if (path === "auth-fail.md") return Promise.reject(authErr);
				return Promise.resolve(new ArrayBuffer(0));
			});

			const plan = makePlan([
				{
					path: "auth-fail.md",
					action: "push",
					local: { path: "auth-fail.md", isDirectory: false, size: 5, mtime: 1000, hash: "" },
				},
				{
					path: "other.md",
					action: "push",
					local: { path: "other.md", isDirectory: false, size: 13, mtime: 1000, hash: "" },
				},
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("aborts immediately on AuthError during Group B (delete_remote)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(remoteFs, "del1.md", "content");
			addFile(remoteFs, "del2.md", "content");
			vi.spyOn(remoteFs, "delete").mockRejectedValueOnce(authErr);

			const plan = makePlan([
				{ path: "del1.md", action: "delete_remote" },
				{ path: "del2.md", action: "delete_remote" },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
			expect(remoteFs.files.has("del2.md")).toBe(true);
		});

		it("aborts immediately on AuthError during Group C (delete_local)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "del1.md", "content");
			addFile(localFs, "del2.md", "content");
			vi.spyOn(localFs, "delete").mockRejectedValueOnce(authErr);

			const plan = makePlan([
				{ path: "del1.md", action: "delete_local" },
				{ path: "del2.md", action: "delete_local" },
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
			expect(localFs.files.has("del2.md")).toBe(true);
		});

		it("aborts immediately on AuthError during Group D (conflict)", async () => {
			const ctx = makeCtx();
			const authErr = new AuthError("Unauthorized", 401);
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;
			addFile(localFs, "c1.md", "local");
			addFile(remoteFs, "c1.md", "remote");
			addFile(localFs, "c2.md", "local2");
			addFile(remoteFs, "c2.md", "remote2");
			vi.spyOn(localFs, "stat").mockRejectedValueOnce(authErr);

			const plan = makePlan([
				{
					path: "c1.md",
					action: "conflict",
					local: { path: "c1.md", isDirectory: false, size: 5, mtime: 2000, hash: "l" },
					remote: { path: "c1.md", isDirectory: false, size: 6, mtime: 1500, hash: "r" },
				},
				{
					path: "c2.md",
					action: "conflict",
					local: { path: "c2.md", isDirectory: false, size: 6, mtime: 2000, hash: "l2" },
					remote: { path: "c2.md", isDirectory: false, size: 7, mtime: 1500, hash: "r2" },
				},
			]);

			await expect(executePlan(plan, ctx)).rejects.toThrow(AuthError);
		});

		it("logs error for failed individual action", async () => {
			const errorSpy = vi.fn();
			const ctx = makeCtx({
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: errorSpy,
				} as unknown as ExecutionContext["logger"],
			});

			const plan = makePlan([{
				path: "no-such-file.md",
				action: "push",
				local: { path: "no-such-file.md", isDirectory: false, size: 5, mtime: 1000, hash: "" },
			}]);

			const result = await executePlan(plan, ctx);

			expect(result.failed).toHaveLength(1);
			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe("execution ordering", () => {
		it("executes groups in order: A before B before C before D", async () => {
			const order: string[] = [];
			const ctx = makeCtx();
			const localFs = ctx.localFs as ReturnType<typeof createMockFs>;
			const remoteFs = ctx.remoteFs as ReturnType<typeof createMockFs>;

			addFile(localFs, "push.md", "push");
			addFile(remoteFs, "del-remote.md", "delete");
			addFile(localFs, "del-local.md", "delete");
			addFile(localFs, "conflict.md", "local");
			addFile(remoteFs, "conflict.md", "remote");

			const origLocalRead = localFs.read.bind(localFs);
			vi.spyOn(localFs, "read").mockImplementation(async (path: string) => {
				if (path === "push.md") order.push("push");
				// conflict resolution also reads; track it separately
				if (path === "conflict.md") order.push("conflict");
				return origLocalRead(path);
			});
			const origRemoteDelete = remoteFs.delete.bind(remoteFs);
			vi.spyOn(remoteFs, "delete").mockImplementation(async (path: string) => {
				order.push("delete_remote");
				return origRemoteDelete(path);
			});
			const origLocalDelete = localFs.delete.bind(localFs);
			vi.spyOn(localFs, "delete").mockImplementation(async (path: string) => {
				order.push("delete_local");
				return origLocalDelete(path);
			});

			const plan = makePlan([
				{ path: "push.md", action: "push", local: { path: "push.md", isDirectory: false, size: 4, mtime: 1000, hash: "" } },
				{ path: "del-remote.md", action: "delete_remote" },
				{ path: "del-local.md", action: "delete_local" },
				{
					path: "conflict.md",
					action: "conflict",
					local: { path: "conflict.md", isDirectory: false, size: 5, mtime: 2000, hash: "l" },
					remote: { path: "conflict.md", isDirectory: false, size: 6, mtime: 1500, hash: "r" },
				},
			]);

			await executePlan(plan, ctx);

			const pushIdx = order.indexOf("push");
			const deleteRemoteIdx = order.indexOf("delete_remote");
			const deleteLocalIdx = order.indexOf("delete_local");
			const conflictIdx = order.indexOf("conflict");

			expect(pushIdx).toBeLessThan(deleteRemoteIdx);
			expect(deleteRemoteIdx).toBeLessThan(deleteLocalIdx);
			expect(deleteLocalIdx).toBeLessThan(conflictIdx);
		});
	});

	describe("empty plan", () => {
		it("returns empty result for a plan with no actions", async () => {
			const ctx = makeCtx();
			const plan = makePlan([]);

			const result = await executePlan(plan, ctx);

			expect(result.succeeded).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
			expect(result.conflicts).toHaveLength(0);
		});
	});
});
