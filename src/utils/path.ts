/**
 * Normalize a sync path to canonical form:
 * - Backslashes → forward slashes
 * - Collapse consecutive slashes
 * - Strip leading/trailing slashes
 */
export function normalizeSyncPath(path: string): string {
	let p = path.replace(/\\/g, "/");
	p = p.replace(/\/+/g, "/");
	if (p.startsWith("/")) p = p.substring(1);
	if (p.endsWith("/")) p = p.substring(0, p.length - 1);
	return p;
}

/**
 * Extract the file extension (including the dot) in lowercase.
 * Returns "" if the path has no extension or the last dot belongs to a directory segment.
 */
export function getFileExtension(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot <= path.lastIndexOf("/")) {
		return "";
	}
	return path.substring(lastDot).toLowerCase();
}

/**
 * Validate that a rename operation is safe.
 * @throws if oldPath === newPath or newPath is inside oldPath's subtree.
 */
export function validateRename(oldPath: string, newPath: string): void {
	if (oldPath === newPath) {
		throw new Error(`Cannot rename "${oldPath}" to itself`);
	}
	if (newPath.startsWith(oldPath + "/")) {
		throw new Error(
			`Cannot move "${oldPath}" into its own subtree "${newPath}"`
		);
	}
}
