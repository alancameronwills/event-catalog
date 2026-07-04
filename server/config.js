// Server configuration. Override via environment variables.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.CATALOG_PORT) || 3777,
  host: process.env.CATALOG_HOST || "127.0.0.1",

  // Where images and the index live. Defaults to <server>/data.
  dataDir: process.env.CATALOG_DATA_DIR || path.join(here, "data"),

  // Reject request bodies larger than this (data URLs can be a few MB).
  maxBodyBytes: Number(process.env.CATALOG_MAX_BODY) || 30 * 1024 * 1024,

  // Max Hamming distance (out of 64) for two posters to be treated as likely
  // duplicates. Lower = stricter. ~10 catches re-compressed/rescaled re-shares
  // without many false positives.
  dupThreshold: Number(process.env.CATALOG_DUP_THRESHOLD) || 10,

  // Run OCR on ingest to read text off the poster (used as a fallback event
  // date). Set CATALOG_OCR=0 to disable.
  ocrEnabled: process.env.CATALOG_OCR !== "0",
};

export const paths = {
  imagesDir: path.join(config.dataDir, "images"),
  indexFile: path.join(config.dataDir, "index.json"),
  // User-created dates (including empty ones with no captures yet).
  datesFile: path.join(config.dataDir, "dates.json"),
  // Tesseract language data / cache, kept so it isn't re-downloaded each run.
  ocrCacheDir: path.join(config.dataDir, "ocr-cache"),
};
