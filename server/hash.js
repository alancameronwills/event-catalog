// Perceptual hashing for near-duplicate detection.
//
// Uses a 64-bit dHash (difference hash): shrink the image to 9x8 grayscale and,
// for each row, record whether each pixel is brighter than the one to its
// right. This is robust to rescaling and re-compression (e.g. Facebook
// re-encoding a re-shared poster), which is exactly the duplicate case we care
// about. Similarity is measured by Hamming distance between two hashes.

import sharp from "sharp";

// Compute the 16-hex-char (64-bit) dHash for an image buffer.
// Returns null if the image can't be decoded.
export async function perceptualHash(buffer) {
  try {
    const { data, info } = await sharp(buffer)
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    let bits = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = data[(row * 9 + col) * ch];
        const right = data[(row * 9 + col + 1) * ch];
        bits += left < right ? "1" : "0";
      }
    }
    return bitsToHex(bits);
  } catch (err) {
    console.warn("perceptualHash failed:", err.message);
    return null;
  }
}

// Number of differing bits between two 64-bit hex hashes (0 = identical).
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let diff = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

function bitsToHex(bits) {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
