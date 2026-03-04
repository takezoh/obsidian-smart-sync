const globCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, path: string): boolean {
	let re = globCache.get(pattern);
	if (!re) {
		const regex = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*\//g, "{{GLOBSTAR_SLASH}}")
			.replace(/\*\*/g, "{{GLOBSTAR}}")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/\{\{GLOBSTAR_SLASH\}\}/g, "(.*/)?")
			.replace(/\{\{GLOBSTAR\}\}/g, ".*");
		re = new RegExp("^" + regex + "$");
		globCache.set(pattern, re);
	}
	return re.test(path);
}
