// Client-side perceptual image hashing for duplicate-poster detection.
//
// This used to run server-side (a dHash via `sharp`, comparing a new
// capture's hash against every entry already in the catalog). With Pawb as
// the sole backend there's no server left to do that, so it's reimplemented
// here using an OffscreenCanvas instead of `sharp`. Same idea: shrink the
// image to a fixed small grid, compare adjacent pixel brightness to get a
// bit per comparison, and compare hashes by Hamming distance.

const HASH_WIDTH = 9; // 9 columns -> 8 pairwise left/right comparisons per row
const HASH_HEIGHT = 8;
export const DUP_THRESHOLD = 10; // out of 64 bits; matches the old server threshold

/**
 * Compute a 64-bit dHash for an image, returned as a 16-character hex
 * string. Accepts anything `createImageBitmap` accepts (Blob, ImageBitmap,
 * etc.) — callers typically pass a fetched Blob or a data-URL-derived Blob.
 */
export async function computeDHash(source) {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = new OffscreenCanvas(HASH_WIDTH, HASH_HEIGHT);
    const ctx = canvas.getContext("2d");
    // Stretch to the fixed grid, ignoring aspect ratio - same intent as the
    // old server-side `fit: "fill"` resize.
    ctx.drawImage(bitmap, 0, 0, HASH_WIDTH, HASH_HEIGHT);
    const { data } = ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT);

    const grey = new Array(HASH_WIDTH * HASH_HEIGHT);
    for (let i = 0; i < grey.length; i++) {
      const o = i * 4;
      grey[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }

    let bits = "";
    for (let row = 0; row < HASH_HEIGHT; row++) {
      for (let col = 0; col < HASH_WIDTH - 1; col++) {
        const left = grey[row * HASH_WIDTH + col];
        const right = grey[row * HASH_WIDTH + col + 1];
        bits += left < right ? "1" : "0";
      }
    }
    return bitsToHex(bits);
  } finally {
    bitmap.close?.();
  }
}

function bitsToHex(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two hashes produced by computeDHash(). Returns
 * Infinity if either is missing/malformed, so callers can compare freely
 * without a "do both exist?" guard first.
 */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let xor;
  try {
    xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  } catch {
    return Infinity;
  }
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}
