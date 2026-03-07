import ignore from "ignore";

export function isIgnored(path: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return ignore().add(patterns).ignores(path);
}
