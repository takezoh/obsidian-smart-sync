import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { RemoteVaultStore, REMOTE_VAULT_ROOT } from "./remote-vault";

describe("RemoteVaultStore", () => {
	let store: RemoteVaultStore;

	afterEach(async () => {
		await store?.close();
	});

	function createStore(): RemoteVaultStore {
		store = new RemoteVaultStore(`test-vault-${Math.random()}`);
		return store;
	}

	it("returns undefined when no data saved", async () => {
		const s = createStore();
		expect(await s.getRemoteVaultId()).toBeUndefined();
		expect(await s.getLastKnownVaultName()).toBeUndefined();
	});

	it("saves and retrieves remoteVaultId and lastKnownVaultName", async () => {
		const s = createStore();
		await s.save("vault-123", "My Vault");
		expect(await s.getRemoteVaultId()).toBe("vault-123");
		expect(await s.getLastKnownVaultName()).toBe("My Vault");
	});

	it("overwrites previous values on save", async () => {
		const s = createStore();
		await s.save("vault-123", "My Vault");
		await s.save("vault-123", "Renamed Vault");
		expect(await s.getRemoteVaultId()).toBe("vault-123");
		expect(await s.getLastKnownVaultName()).toBe("Renamed Vault");
	});

	it("persists data across close/reopen cycles", async () => {
		const vaultId = `test-vault-${Math.random()}`;
		const s1 = new RemoteVaultStore(vaultId);
		await s1.save("vault-abc", "Test Vault");
		await s1.close();

		const s2 = new RemoteVaultStore(vaultId);
		store = s2; // for cleanup
		expect(await s2.getRemoteVaultId()).toBe("vault-abc");
		expect(await s2.getLastKnownVaultName()).toBe("Test Vault");
	});
});

describe("REMOTE_VAULT_ROOT", () => {
	it("is obsidian-smart-sync", () => {
		expect(REMOTE_VAULT_ROOT).toBe("obsidian-smart-sync");
	});
});
