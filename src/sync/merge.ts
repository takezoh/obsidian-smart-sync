import { mergeDiff3 } from "node-diff3";
import { getFileExtension } from "../utils/path";

const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".json", ".canvas", ".css", ".js", ".ts", ".html", ".xml",
	".yaml", ".yml", ".csv", ".svg", ".tex", ".bib", ".org",
	".rst", ".adoc", ".toml", ".ini", ".cfg", ".conf", ".log",
	".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".lua",
	".sql", ".graphql", ".env", ".gitignore",
]);

const MAX_MERGE_SIZE = 1024 * 1024; // 1MB

/** Check if a file is eligible for 3-way text merge */
export function isMergeEligible(path: string, size: number): boolean {
	if (size > MAX_MERGE_SIZE) return false;
	const ext = getFileExtension(path);
	return TEXT_EXTENSIONS.has(ext);
}

export interface MergeResult {
	success: boolean;
	/** Merged content (may contain conflict markers if success is false) */
	content: string;
	/** True if the merge had conflicts (markers inserted) */
	hasConflicts: boolean;
}

/**
 * Perform a 3-way merge using the base (last synced), local, and remote versions.
 * Returns the merged content. If there are conflicting changes, conflict markers
 * are inserted (<<<<<<< / ======= / >>>>>>>).
 */
export function threeWayMerge(
	base: string,
	local: string,
	remote: string
): MergeResult {
	// Normalize CRLF to LF before merging; restore if either side used CRLF
	const useCRLF = local.includes("\r\n") || remote.includes("\r\n");
	const normBase = base.replace(/\r\n/g, "\n");
	const normLocal = local.replace(/\r\n/g, "\n");
	const normRemote = remote.replace(/\r\n/g, "\n");

	const result = mergeDiff3(normLocal, normBase, normRemote, {
		stringSeparator: "\n",
		label: { a: "LOCAL", o: "BASE", b: "REMOTE" },
	});

	let content = result.result.join("\n");
	if (useCRLF) {
		content = content.replace(/\n/g, "\r\n");
	}

	return {
		success: !result.conflict,
		content,
		hasConflicts: result.conflict,
	};
}
