import type { IBackendProvider } from "./backend";
import { GoogleDriveProvider } from "./googledrive/provider";

/**
 * Registry of available backend providers.
 * New backends are added here — no changes needed in main.ts or sync/.
 */
const providers: IBackendProvider[] = [new GoogleDriveProvider()];

const providerMap = new Map<string, IBackendProvider>();
for (const p of providers) {
	if (providerMap.has(p.type)) {
		console.warn(`Smart Sync: duplicate backend type "${p.type}" — keeping first registration`);
		continue;
	}
	providerMap.set(p.type, p);
}

/** Get a backend provider by type, or undefined if unknown */
export function getBackendProvider(
	type: string
): IBackendProvider | undefined {
	return providerMap.get(type);
}

/** Get all registered backend providers (returns a copy) */
export function getAllBackendProviders(): readonly IBackendProvider[] {
	return [...providers];
}
