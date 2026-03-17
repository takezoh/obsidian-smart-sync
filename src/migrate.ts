import type { ConflictStrategy } from "./sync/types";

type LegacyConflictStrategy = "keep_newer" | "three_way_merge" | "keep_local" | "keep_remote";

const legacyMigrations: Record<LegacyConflictStrategy, ConflictStrategy> = {
	keep_newer: "auto_merge",
	three_way_merge: "auto_merge",
	keep_local: "ask",
	keep_remote: "ask",
};

/**
 * Migrates a legacy conflict strategy value to its current equivalent.
 *
 * Legacy strategy values (`keep_newer`, `three_way_merge`, `keep_local`, `keep_remote`)
 * must remain in the `ConflictStrategy` union until this migration function is removed.
 */
export function migrateConflictStrategy(strategy: ConflictStrategy): ConflictStrategy {
	const migrated = (legacyMigrations as Partial<Record<ConflictStrategy, ConflictStrategy>>)[strategy];
	return migrated ?? strategy;
}
