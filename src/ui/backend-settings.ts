import type { SmartSyncSettings } from "../settings";
import { GoogleDriveSettingsRenderer } from "./googledrive-settings";

/** Actions that settings renderers can invoke for connection flow UI */
export interface BackendConnectionActions {
	startAuth(): Promise<void>;
	completeAuth(code: string): Promise<void>;
	disconnect(): Promise<void>;
	refreshDisplay(): void;
}

/**
 * Renders backend-specific settings UI.
 * Each backend (Google Drive, Dropbox, etc.) implements this interface
 * to provide its configuration fields and connection flow.
 */
export interface IBackendSettingsRenderer {
	/** Must match the corresponding IBackendProvider.type */
	readonly backendType: string;

	render(
		containerEl: HTMLElement,
		settings: SmartSyncSettings,
		onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions
	): void;
}

// --- Registry (same pattern as src/fs/registry.ts) ---

const renderers: IBackendSettingsRenderer[] = [
	new GoogleDriveSettingsRenderer(),
];

const rendererMap = new Map<string, IBackendSettingsRenderer>();
for (const r of renderers) {
	if (rendererMap.has(r.backendType)) {
		// Defensive: should never happen at runtime with a single renderer
		continue;
	}
	rendererMap.set(r.backendType, r);
}

/** Get a settings renderer by backend type */
export function getBackendSettingsRenderer(
	type: string
): IBackendSettingsRenderer | undefined {
	return rendererMap.get(type);
}

/** Get all registered settings renderers */
export function getAllBackendSettingsRenderers(): readonly IBackendSettingsRenderer[] {
	return [...renderers];
}
