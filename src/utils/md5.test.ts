import { describe, it, expect } from "vitest";
import { md5 } from "./md5";

const encode = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;

describe("md5", () => {
	// RFC 1321 test vectors
	it.each([
		["", "d41d8cd98f00b204e9800998ecf8427e"],
		["a", "0cc175b9c0f1b6a831c399e269772661"],
		["abc", "900150983cd24fb0d6963f7d28e17f72"],
		["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
		["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
		[
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
			"d174ab98d277d9f5a5611c2c9f419d9f",
		],
		[
			"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
			"57edf4a22be3c955ac49da2e2107b67a",
		],
	])("md5(%j) = %s", (input, expected) => {
		expect(md5(encode(input))).toBe(expected);
	});

	it("handles binary data", () => {
		const buf = new Uint8Array([0x00, 0xff, 0x80, 0x7f]).buffer;
		const hash = md5(buf);
		expect(hash).toMatch(/^[0-9a-f]{32}$/);
	});

	it("handles empty ArrayBuffer", () => {
		expect(md5(new ArrayBuffer(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
	});
});
