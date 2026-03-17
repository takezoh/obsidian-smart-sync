/**
 * Pure-JS MD5 implementation (RFC 1321).
 * Returns lowercase hex digest string.
 */
export function md5(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);

	// Pre-processing: add padding
	const bitLen = bytes.length * 8;
	// Message needs to be padded to 64-byte blocks (512 bits)
	// Padding: 1 bit, then zeros, then 64-bit length
	const padLen = (bytes.length % 64 < 56 ? 56 : 120) - (bytes.length % 64);
	const padded = new Uint8Array(bytes.length + padLen + 8);
	padded.set(bytes);
	padded[bytes.length] = 0x80;

	// Append length in bits as 64-bit little-endian
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, bitLen >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

	// Initialize hash values
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	// Process each 64-byte block
	for (let i = 0; i < padded.length; i += 64) {
		const m = new Uint32Array(16);
		for (let j = 0; j < 16; j++) {
			m[j] = view.getUint32(i + j * 4, true);
		}

		let a = a0, b = b0, c = c0, d = d0;

		for (let j = 0; j < 64; j++) {
			let f: number, g: number;
			if (j < 16) {
				f = (b & c) | (~b & d);
				g = j;
			} else if (j < 32) {
				f = (d & b) | (~d & c);
				g = (5 * j + 1) % 16;
			} else if (j < 48) {
				f = b ^ c ^ d;
				g = (3 * j + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * j) % 16;
			}
			const temp = d;
			d = c;
			c = b;
			const sum = (a + f + K[j]! + m[g]!) >>> 0;
			b = (b + rotl(sum, S[j]!)) >>> 0;
			a = temp;
		}

		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}

	return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

function rotl(x: number, n: number): number {
	return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function toHex(n: number): string {
	let hex = "";
	for (let i = 0; i < 4; i++) {
		hex += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
	}
	return hex;
}

/* Per-round shift amounts */
const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/* Pre-computed constants: floor(2^32 * abs(sin(i+1))) */
const K = [
	0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
	0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
	0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
	0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
	0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
	0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
	0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
	0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
	0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
	0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
	0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
	0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
	0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
	0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
	0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
	0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
