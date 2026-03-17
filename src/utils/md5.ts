import { md5 as jsMd5 } from "js-md5";

/** Compute MD5 hex digest. Returns lowercase hex string. */
export function md5(data: ArrayBuffer): string {
	return jsMd5(data);
}
