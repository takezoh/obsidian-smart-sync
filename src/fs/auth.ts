import type { App } from "obsidian";
import type { SmartSyncSettings } from "../settings";

/** Authentication provider interface — abstracts OAuth/credential lifecycle */
export interface IAuthProvider {
	isAuthenticated(settings: SmartSyncSettings): boolean;
	startAuth(app: App, settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>>;
	completeAuth(input: string, settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>>;
	disconnect(settings: SmartSyncSettings): Promise<Partial<SmartSyncSettings>>;
}
