/** Compute SHA-256 hex digest using Web Crypto API */
export async function sha256(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = new Uint8Array(hashBuffer);
	let hex = "";
	for (let i = 0; i < hashArray.length; i++) {
		hex += hashArray[i]!.toString(16).padStart(2, "0");
	}
	return hex;
}
