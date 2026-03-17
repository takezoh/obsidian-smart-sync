import { describe, it, expect } from "vitest";
import { migrateConflictStrategy } from "./migrate";

describe("migrateConflictStrategy", () => {
	it("migrates keep_newer to auto_merge", () => {
		expect(migrateConflictStrategy("keep_newer")).toBe("auto_merge");
	});

	it("migrates three_way_merge to auto_merge", () => {
		expect(migrateConflictStrategy("three_way_merge")).toBe("auto_merge");
	});

	it("migrates keep_local to ask", () => {
		expect(migrateConflictStrategy("keep_local")).toBe("ask");
	});

	it("migrates keep_remote to ask", () => {
		expect(migrateConflictStrategy("keep_remote")).toBe("ask");
	});

	it("leaves auto_merge unchanged", () => {
		expect(migrateConflictStrategy("auto_merge")).toBe("auto_merge");
	});

	it("leaves ask unchanged", () => {
		expect(migrateConflictStrategy("ask")).toBe("ask");
	});

	it("leaves duplicate unchanged", () => {
		expect(migrateConflictStrategy("duplicate")).toBe("duplicate");
	});
});
