import { describe, it, expect } from "vitest";
import { isIgnored } from "./ignore";

describe("isIgnored", () => {
	it("returns false for empty patterns", () => {
		expect(isIgnored("foo.md", [])).toBe(false);
	});

	it("excludes matching files", () => {
		expect(isIgnored("secret/key.pem", ["secret/**"])).toBe(true);
		expect(isIgnored("notes/hello.md", ["secret/**"])).toBe(false);
	});

	it("supports negation patterns (last match wins)", () => {
		// Must re-include the directory before re-including files inside it
		const patterns = ["secret/**", "!secret/public/", "!secret/public/**"];
		expect(isIgnored("secret/key.pem", patterns)).toBe(true);
		expect(isIgnored("secret/public/readme.md", patterns)).toBe(false);
	});

	it("skips comment lines", () => {
		const patterns = ["# This is a comment", "*.tmp"];
		expect(isIgnored("file.tmp", patterns)).toBe(true);
		expect(isIgnored("file.md", patterns)).toBe(false);
	});

	it("matches trailing slash as directory-only pattern", () => {
		// trailing slash in pattern means "only match directories"
		// isIgnored passes plain paths (no trailing slash) so directory-only patterns don't match files
		expect(isIgnored("build", ["build/"])).toBe(false);
		// A path like "build/file.txt" is still matched because "build/" matches the directory component
		expect(isIgnored("build/file.txt", ["build/"])).toBe(true);
	});

	it("supports wildcard-all with negation for allowlist", () => {
		// !*/ re-includes directories so negation patterns can match nested files
		const patterns = ["*", "!*/", "!**/*.md", "!**/*.canvas"];
		expect(isIgnored("image.png", patterns)).toBe(true);
		expect(isIgnored("notes/hello.md", patterns)).toBe(false);
		expect(isIgnored("folder/diagram.canvas", patterns)).toBe(false);
		expect(isIgnored("assets/photo.png", patterns)).toBe(true);
	});
});
