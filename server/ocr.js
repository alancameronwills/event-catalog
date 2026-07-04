// OCR: read text off a poster image and parse a likely event date from it.
//
// Used as a fallback for the event date when a capture has no structured date
// (i.e. an ordinary post rather than a Facebook Event page). The recognized
// text is also stored on the entry for later use (search / secondary duplicate
// signal).

import fs from "node:fs/promises";
import sharp from "sharp";
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

  // Never hand Tesseract raw bytes. On input it can't decode it throws from
  // inside its worker, and that error is re-thrown on the process — an
  // *uncaught* exception that takes the whole server down. Decode + normalize
  // with sharp first (the same thing that would just return null in hashing);
  // if sharp can't read it, it isn't a usable image, so skip OCR. The greyscale
  // PNG it emits is also cleaner input for recognition.
  let image;
  try {
    image = await sharp(buffer).rotate().greyscale().png().toBuffer();
  } catch (err) {
    console.warn("OCR skipped — undecodable image:", err.message);
    return "";
  }

  const run = ocrChain.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
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

// --- Time parsing --------------------------------------------------------

// Extract a likely event *start* time as 24-hour "HH:MM", or null. Posters
// commonly print a range ("7pm–11pm", "7 to 11pm", "7-11PM"); we take the start
// and ignore the end — often the meridiem sits only on the end time, so the
// start borrows it. A bare number is ignored unless it carries am/pm or reads
// as a colon clock, so dates ("7/8") and prices ("$15.00") aren't mistaken for
// times.
export function parseEventTime(text) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/[–—]/g, "-"); // en/em dash → "-"

  // start clock (+optional meridiem) then an optional range (separator + end
  // clock + optional end meridiem). Spaces are tolerated around ":" for OCR.
  const TIME = new RegExp(
    "\\b(\\d{1,2})(?:\\s*([:.])\\s*(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?" +
      "(?:\\s*(?:-|to|til|till|until|thru|through)\\s*" +
      "(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?)?",
    "gi"
  );

  for (const m of t.matchAll(TIME)) {
    const [, hour, sep, min, startMer, , , endMer] = m;
    const mer = normalizeMeridiem(startMer) || normalizeMeridiem(endMer);
    // Only accept genuine times: am/pm present, or a colon-separated clock.
    const isColonClock = sep === ":" && min !== undefined;
    if (!mer && !isColonClock) continue;

    const iso = toClock(hour, min, mer);
    if (iso) return iso;
  }
  return null;
}

function normalizeMeridiem(m) {
  return m ? m.replace(/\./g, "") : null; // "p.m." → "pm"
}

function toClock(hour, min, mer) {
  let h = +hour;
  const mm = min !== undefined ? +min : 0;
  if (mm > 59) return null;
  if (mer && h > 12) return null; // "19pm" is nonsense
  if (mer === "pm" && h < 12) h += 12;
  else if (mer === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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
