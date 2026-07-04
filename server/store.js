// Persistence: images on disk in date-named folders, plus a JSON index.
//
// The index is a flat array of entries, newest first. Image bytes are written
// under images/<YYYY-MM-DD>/<id>.<ext> and referenced from the index by a
// relative path so the index stays small.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import { perceptualHash, hammingDistance } from "./hash.js";
import { extractText, parseEventDate } from "./ocr.js";

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Serialize index writes so concurrent captures don't clobber each other.
let writeChain = Promise.resolve();

export async function init() {
  await fs.mkdir(paths.imagesDir, { recursive: true });
  for (const file of [paths.indexFile, paths.datesFile]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "[]\n");
    }
  }
}

export async function readIndex() {
  try {
    const raw = await fs.readFile(paths.indexFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// Atomic-ish write: write a temp file then rename over the target.
async function writeIndex(entries) {
  const tmp = `${paths.indexFile}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + "\n");
  await fs.rename(tmp, paths.indexFile);
}

// The date an entry belongs to, as YYYY-MM-DD. Precedence: explicit
// assignedDate (user moved it) > structured event date > OCR-extracted date >
// capture date. This also names the on-disk folder.
function effectiveDate(entry) {
  if (isDateString(entry.assignedDate)) return entry.assignedDate;
  const structured = new Date(entry.event?.startDate);
  if (entry.event?.startDate && !Number.isNaN(structured.getTime())) {
    return structured.toISOString().slice(0, 10);
  }
  if (isDateString(entry.ocrDate)) return entry.ocrDate;
  const d = new Date(entry.capturedAt || Date.now());
  const day = Number.isNaN(d.getTime()) ? new Date() : d;
  return day.toISOString().slice(0, 10);
}

export function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const data = match[3];
  const buffer = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");
  return { mime, buffer, ext: MIME_EXT[mime] || "bin" };
}

// Save a capture: write the image, append an index entry, return the entry.
export async function addCapture(capture) {
  const id = capture.id || randomUUID();
  const capturedAt = capture.capturedAt || new Date().toISOString();

  const entry = {
    id,
    capturedAt,
    assignedDate: null,
    eventDate: capture.event?.startDate || null,
    imageFile: null,
    imageUrl: capture.imageUrl || null,
    caption: capture.caption || "",
    event: capture.event || null,
    pageUrl: capture.pageUrl || null,
    pageTitle: capture.pageTitle || null,
    // User-editable metadata (fall back to scraped values when null).
    title: null,
    venue: null,
    url: null,
    hash: null,
    // OCR (step 4): text read off the poster + a date parsed from it, used as
    // a fallback when there's no structured event date.
    ocrText: null,
    ocrDate: null,
    // Duplicate detection (step 3):
    duplicateOf: null,
    duplicateDistance: null,
  };

  const decoded = parseDataUrl(capture.imageDataUrl);
  if (decoded) {
    entry.hash = await perceptualHash(decoded.buffer);

    // Read the poster text; if there's no structured event date, try to parse
    // one from it. Do this before choosing the folder so the file lands in the
    // date folder the entry will actually be grouped under.
    const text = await extractText(decoded.buffer);
    if (text) {
      entry.ocrText = text.slice(0, 5000);
      if (!entry.event?.startDate) {
        entry.ocrDate = parseEventDate(text, capturedAt);
      }
    }

    const folder = effectiveDate(entry);
    const dir = path.join(paths.imagesDir, folder);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${id}.${decoded.ext}`;
    await fs.writeFile(path.join(dir, filename), decoded.buffer);
    // Relative to imagesDir; served at /images/<folder>/<filename>.
    entry.imageFile = `${folder}/${filename}`;
    entry.imageBytes = decoded.buffer.length;
  }

  await enqueueWrite(async () => {
    const entries = await readIndex();
    // Flag a likely duplicate by comparing against everything already stored.
    const match = findDuplicate(entry, entries);
    if (match) {
      entry.duplicateOf = match.id;
      entry.duplicateDistance = match.distance;
    }
    entries.unshift(entry);
    await writeIndex(entries);
  });

  return entry;
}

// Closest existing entry within the duplicate threshold, or null.
function findDuplicate(entry, entries) {
  if (!entry.hash) return null;
  let best = null;
  for (const other of entries) {
    if (other.id === entry.id || !other.hash) continue;
    const distance = hammingDistance(entry.hash, other.hash);
    if (distance <= config.dupThreshold && (!best || distance < best.distance)) {
      best = { id: other.id, distance };
    }
  }
  return best;
}

// Compute hashes for any stored captures that don't have one yet (e.g. saved
// before duplicate detection existed). Runs once at startup; keeps the catalog
// fully comparable without a manual migration.
export async function backfillHashes() {
  const entries = await readIndex();
  const missing = entries.filter((e) => e.imageFile && !e.hash);
  if (missing.length === 0) return 0;

  let updated = 0;
  for (const entry of missing) {
    try {
      const buffer = await fs.readFile(path.join(paths.imagesDir, entry.imageFile));
      const hash = await perceptualHash(buffer);
      if (hash) {
        entry.hash = hash;
        updated++;
      }
    } catch (err) {
      console.warn(`backfill: could not hash ${entry.imageFile}:`, err.message);
    }
  }
  if (updated > 0) {
    await enqueueWrite(async () => {
      // Merge freshly-computed hashes into the current index without clobbering
      // any captures added while we were hashing.
      const current = await readIndex();
      const byId = new Map(entries.map((e) => [e.id, e]));
      for (const e of current) {
        const source = byId.get(e.id);
        if (source && source.hash && !e.hash) e.hash = source.hash;
      }
      await writeIndex(current);
    });
  }
  return updated;
}

// Recover images for entries that have a source URL but no stored image (e.g.
// captured before the bytes were fetched reliably). Downloads from imageUrl —
// the server has no CORS restriction — then hashes, OCRs, files the image under
// its effective date, and re-runs duplicate detection. Best-effort per entry;
// URLs that have expired simply fail and are reported.
export async function backfillImages() {
  const entries = await readIndex();
  const missing = entries.filter((e) => !e.imageFile && e.imageUrl);
  if (missing.length === 0) return { attempted: 0, saved: 0, flagged: 0, failed: 0 };

  const updates = [];
  let failed = 0;
  for (const entry of missing) {
    try {
      const { buffer, mime } = await fetchImage(entry.imageUrl);
      const hash = await perceptualHash(buffer);

      let ocrText = null;
      let ocrDate = null;
      const text = await extractText(buffer);
      if (text) {
        ocrText = text.slice(0, 5000);
        if (!entry.event?.startDate) ocrDate = parseEventDate(text, entry.capturedAt);
      }

      const folder = effectiveDate({ ...entry, hash, ocrDate });
      const ext = MIME_EXT[mime] || "jpg";
      const rel = `${folder}/${entry.id}.${ext}`;
      await fs.mkdir(path.join(paths.imagesDir, folder), { recursive: true });
      await fs.writeFile(path.join(paths.imagesDir, rel), buffer);

      updates.push({ id: entry.id, imageFile: rel, imageBytes: buffer.length, hash, ocrText, ocrDate });
    } catch (err) {
      console.warn(`backfill-image ${entry.id} failed:`, err.message);
      failed++;
    }
  }

  let flagged = 0;
  if (updates.length) {
    await enqueueWrite(async () => {
      const current = await readIndex();
      const byId = new Map(current.map((e) => [e.id, e]));
      for (const u of updates) {
        const e = byId.get(u.id);
        if (e) Object.assign(e, u, { id: e.id });
      }
      // Now that hashes exist, flag duplicates among the recovered entries.
      for (const u of updates) {
        const e = byId.get(u.id);
        if (!e?.hash) continue;
        const match = findDuplicate(e, current);
        if (match) {
          e.duplicateOf = match.id;
          e.duplicateDistance = match.distance;
          flagged++;
        }
      }
      await writeIndex(current);
    });
  }

  return { attempted: missing.length, saved: updates.length, flagged, failed };
}

// Download an image, returning its bytes and mime type. Sends browser-ish
// headers since some CDNs reject default clients.
async function fetchImage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      Referer: "https://www.facebook.com/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  return { buffer, mime };
}

// Reassign a capture to a different date (used by drag/paste in the panel).
// Sets assignedDate and moves the image file into the matching date folder so
// the on-disk layout stays coherent with the displayed grouping. Pass
// assignedDate: null to revert to the derived date.
export async function updateCapture(id, patch) {
  let updated = null;
  await enqueueWrite(async () => {
    const entries = await readIndex();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    if ("assignedDate" in patch) {
      entry.assignedDate =
        patch.assignedDate === null || isDateString(patch.assignedDate)
          ? patch.assignedDate
          : entry.assignedDate;
      if (entry.imageFile) {
        entry.imageFile = await moveImageFile(entry.imageFile, effectiveDate(entry), id);
      }
    }

    // Optional user-editable metadata. Empty/blank clears the field (falls back
    // to scraped values in the UI).
    const MAX = { title: 300, venue: 300, url: 2000 };
    for (const field of ["title", "venue", "url"]) {
      if (field in patch) {
        const value = patch[field];
        entry[field] =
          value == null || String(value).trim() === ""
            ? null
            : String(value).trim().slice(0, MAX[field]);
      }
    }

    updated = entry;
    await writeIndex(entries);
  });
  return updated;
}

// Move an image file into <newFolder>/, returning the new relative path.
// Best-effort: on any failure the original path is kept.
async function moveImageFile(relPath, newFolder, id) {
  const currentFolder = path.dirname(relPath);
  if (currentFolder === newFolder) return relPath;
  const ext = path.extname(relPath);
  const newRel = `${newFolder}/${id}${ext}`;
  const from = path.join(paths.imagesDir, relPath);
  const to = path.join(paths.imagesDir, newRel);
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    // Tidy up the old folder if it's now empty.
    await fs.rmdir(path.join(paths.imagesDir, currentFolder)).catch(() => {});
    return newRel;
  } catch (err) {
    console.warn(`could not move image ${relPath} -> ${newRel}:`, err.message);
    return relPath;
  }
}

// --- User-created dates --------------------------------------------------

export async function readDates() {
  try {
    const raw = await fs.readFile(paths.datesFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isDateString) : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function addDate(date) {
  if (!isDateString(date)) return null;
  await enqueueWrite(async () => {
    const dates = await readDates();
    if (!dates.includes(date)) {
      dates.push(date);
      dates.sort();
      await writeDatesFile(dates);
    }
  });
  return date;
}

export async function removeDate(date) {
  await enqueueWrite(async () => {
    const dates = await readDates();
    const next = dates.filter((d) => d !== date);
    if (next.length !== dates.length) await writeDatesFile(next);
  });
  return date;
}

async function writeDatesFile(dates) {
  const tmp = `${paths.datesFile}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(dates, null, 2) + "\n");
  await fs.rename(tmp, paths.datesFile);
}

export async function deleteCapture(id) {
  let removed = null;
  await enqueueWrite(async () => {
    const entries = await readIndex();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    removed = entries.splice(idx, 1)[0];
    await writeIndex(entries);
  });

  if (removed?.imageFile) {
    await fs.rm(path.join(paths.imagesDir, removed.imageFile), { force: true });
  }
  return removed;
}

function enqueueWrite(task) {
  writeChain = writeChain.then(task, task);
  return writeChain;
}

export { config, paths };
