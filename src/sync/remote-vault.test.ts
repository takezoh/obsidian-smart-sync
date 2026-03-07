import { describe, it, expect } from "vitest";
import { REMOTE_VAULT_ROOT } from "./remote-vault";

describe("REMOTE_VAULT_ROOT", () => {
	it("is obsidian-smart-sync", () => {
		expect(REMOTE_VAULT_ROOT).toBe("obsidian-smart-sync");
	});
});
