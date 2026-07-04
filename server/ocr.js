// OCR: read text off a poster image and parse a likely event date from it.
//
// Used as a fallback for the event date when a capture has no structured date
// (i.e. an ordinary post rather than a Facebook Event page). The recognized
// text is also stored on the entry for later use (search / secondary duplicate
// signal).

import fs from "node:fs/promises";
import { createWorker } from "tesseract.js";
import { config, paths } from "./config.js";

// Reuse a single Tesseract worker across captures — spinning one up (and
// loading language data) is the slow part, so we do it once. Recognition is
// serialized because a worker handles one job at a time.
let workerPromise = null;
let ocrChain = Promise.resolve();

async function getWorker() {
  if (!workerPromise) {
    await fs.mkdir(paths.ocrCacheDir, { recursive: true });
    workerPromise = createWorker("eng", 1, { cachePath: paths.ocrCacheDir }).catch((err) => {
      workerPromise = null; // allow a later retry
      throw err;
    });
  }
  return workerPromise;
}

// Recognize text in an image buffer. Returns "" on any failure so ingest keeps
// working even if OCR is unavailable.
export async function extractText(buffer) {
  if (!config.ocrEnabled) return "";
  const run = ocrChain.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    return (data.text || "").trim();
  });
  ocrChain = run.catch(() => {}); // keep the chain alive past failures
  try {
    return await run;
  } catch (err) {
    console.warn("OCR failed:", err.message);
    return "";
  }
}

// --- Date parsing --------------------------------------------------------

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_ALT = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length) // longest first so "september" beats "sep"
  .join("|");

// Extract a likely event date as YYYY-MM-DD, or null. `reference` (the capture
// date) is used to infer a missing year — events are upcoming, so a bare
// "15 August" resolves to the next such date rather than a past one.
export function parseEventDate(text, reference = new Date()) {
  if (!text) return null;
  const ref = new Date(reference);
  const lower = text.toLowerCase();

  for (const cand of dateCandidates(lower)) {
    const iso = resolve(cand, ref);
    if (iso) return iso;
  }
  return null;
}

// Yield {y?, m, d} candidates from the text, most-reliable patterns first.
function* dateCandidates(text) {
  // ISO 2026-08-15
  for (const m of text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    yield { y: +m[1], m: +m[2], d: +m[3] };
  }
  // 15 August 2026 / 15th Aug
  const dayMonth = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?`,
    "g"
  );
  for (const m of text.matchAll(dayMonth)) {
    yield { d: +m[1], m: MONTHS[m[2]], y: m[3] ? +m[3] : undefined };
  }
  // August 15 2026 / Aug 15th, 2026
  const monthDay = new RegExp(
    `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
    "g"
  );
  for (const m of text.matchAll(monthDay)) {
    yield { m: MONTHS[m[1]], d: +m[2], y: m[3] ? +m[3] : undefined };
  }
  // Numeric 15/08/2026, 15-8-26, 15.08 — assume day-first unless impossible.
  for (const m of text.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/g)) {
    let a = +m[1], b = +m[2];
    let d, mon;
    if (a > 12 && b <= 12) { d = a; mon = b; }
    else if (b > 12 && a <= 12) { d = b; mon = a; }
    else { d = a; mon = b; } // ambiguous → day-first
    yield { d, m: mon, y: m[3] ? +m[3] : undefined };
  }
}

// Validate a candidate and produce YYYY-MM-DD, inferring/adjusting the year.
function resolve(cand, ref) {
  let { y, m, d } = cand;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;

  if (y === undefined) {
    y = ref.getFullYear();
  } else if (y < 100) {
    y += 2000;
  }

  const valid = (yr) => {
    const dt = new Date(yr, m - 1, d);
    return dt.getFullYear() === yr && dt.getMonth() === m - 1 && dt.getDate() === d
      ? dt
      : null;
  };

  let dt = valid(y);
  if (!dt) return null;

  // If the year was inferred and the date is well in the past, roll forward:
  // posters advertise upcoming events.
  if (cand.y === undefined) {
    const cutoff = new Date(ref);
    cutoff.setDate(cutoff.getDate() - 45);
    if (dt < cutoff) {
      const next = valid(y + 1);
      if (next) dt = next;
    }
  }

  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}
