import type { ISecretStore } from "./secret-store";

/** Generate a deterministic SecretStorage key for a backend token */
function tokenKey(backendType: string, tokenType: "refresh" | "access"): string {
	return `air-sync-${backendType}-${tokenType}-token`;
}

export interface StoredTokens {
	refreshToken: string;
	accessToken: string;
}

/** Store tokens in SecretStorage */
export function storeTokens(store: ISecretStore, backendType: string, tokens: StoredTokens): void {
	if (tokens.refreshToken) {
		store.setSecret(tokenKey(backendType, "refresh"), tokens.refreshToken);
	}
	if (tokens.accessToken) {
		store.setSecret(tokenKey(backendType, "access"), tokens.accessToken);
	}
}

/** Read tokens from SecretStorage */
export function readTokens(store: ISecretStore, backendType: string): StoredTokens {
	return {
		refreshToken: store.getSecret(tokenKey(backendType, "refresh")) ?? "",
		accessToken: store.getSecret(tokenKey(backendType, "access")) ?? "",
	};
}

/** Check if a refresh token exists in SecretStorage */
export function hasRefreshToken(store: ISecretStore, backendType: string): boolean {
	return !!store.getSecret(tokenKey(backendType, "refresh"));
}

/** Clear tokens from SecretStorage */
export function clearTokens(store: ISecretStore, backendType: string): void {
	store.setSecret(tokenKey(backendType, "refresh"), "");
	store.setSecret(tokenKey(backendType, "access"), "");
}
