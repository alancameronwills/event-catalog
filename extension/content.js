// Content script: runs on Facebook pages. On request from the service worker,
// locates the target image, upgrades it to full resolution where possible, and
// scrapes nearby caption text and (on Event pages) structured event details.
//
// Facebook's DOM changes often; the image path is robust but the caption/date
// scraping is best-effort and is expected to need occasional maintenance.
//
// Wrapped in a guarded IIFE so the script is safe to inject more than once
// (the manifest injects it on matching pages; the service worker may also
// inject it on demand into a tab that was open before the extension loaded).

(() => {
  if (window.__eventCatalogContentLoaded) return;
  window.__eventCatalogContentLoaded = true;

  let lastHoveredImage = null;

// Track the image under the cursor so the keyboard shortcut has a target.
document.addEventListener(
  "mouseover",
  (e) => {
    const img = e.target.closest("img");
    if (img) lastHoveredImage = img;
  },
  true
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "CAPTURE_IMAGE") return;
  // Respond asynchronously.
  buildCapture(message.hint)
    .then(sendResponse)
    .catch((err) => {
      console.error("[event-catalog] capture failed", err);
      sendResponse(null);
    });
  return true; // keep the message channel open for the async response
});

async function buildCapture(hint) {
  const img = findTargetImage(hint);
  if (!img) return null;

  // On an event page the poster *is* the cover photo, and og:image gives its
  // canonical full-res URL — better than a downscaled DOM <img>. Prefer it, but
  // only when the user didn't right-click a *specific* image (hint.srcUrl): a
  // deliberate right-click on some other photo should still be honoured.
  const cover = onEventPage() && !hint?.srcUrl ? metaContent("og:image") : null;

  // Only report the URL and metadata here. The service worker fetches the
  // actual bytes — content scripts run in the page origin and are CORS-blocked
  // from fbcdn, which previously left captures with no image (and no hash).
  return {
    imageUrl: cover || bestResolutionUrl(img),
    caption: findCaption(img),
    event: scrapeEventDetails(),
    pageUrl: hint?.pageUrl || location.href,
    pageTitle: document.title,
  };
}

// --- Image selection -----------------------------------------------------

function findTargetImage(hint) {
  if (hint?.srcUrl) {
    const match = [...document.images].find((i) => i.currentSrc === hint.srcUrl || i.src === hint.srcUrl);
    if (match) return match;
  }
  if (lastHoveredImage && lastHoveredImage.isConnected) return lastHoveredImage;
  return null;
}

// Facebook often renders a downscaled version; prefer the source set's largest
// candidate when available.
function bestResolutionUrl(img) {
  if (img.srcset) {
    const candidates = img.srcset
      .split(",")
      .map((part) => {
        const [url, size] = part.trim().split(/\s+/);
        return { url, density: parseFloat(size) || 1 };
      })
      .sort((a, b) => b.density - a.density);
    if (candidates.length) return candidates[0].url;
  }
  return img.currentSrc || img.src;
}

// --- Metadata scraping ---------------------------------------------------

// Walk up to a plausible post container and pull its visible text.
function findCaption(img) {
  const container =
    img.closest('[role="article"]') || img.closest("article") || img.parentElement;
  if (!container) return "";
  const text = container.innerText || "";
  return text.trim().slice(0, 2000);
}

// Are we on a Facebook event page (facebook.com/events/<id>/)?
function onEventPage() {
  return /\/events\/\d+/.test(location.pathname);
}

// First non-empty content of a <meta property=…> or <meta name=…> tag.
function metaContent(...keys) {
  for (const key of keys) {
    const el =
      document.querySelector(`meta[property="${key}"]`) ||
      document.querySelector(`meta[name="${key}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return null;
}

// FB titles the head/document as "<Event name> | Facebook" (or " - Facebook").
// Strip that suffix; reject a bare "Facebook" (feed pages with no event name).
function cleanEventName(s) {
  const name = (s || "").replace(/\s*[|\-–]\s*Facebook\s*$/i, "").trim();
  return name && !/^facebook$/i.test(name) ? name : null;
}

// --- Event-page header DOM parsing --------------------------------------
//
// On logged-in SPA sessions FB event pages often carry *no* JSON-LD and no
// event:* meta, so the date and venue live only as visible text. The header
// reads, in DOM order: <date/time line> → <title> → <venue line>. So we anchor
// on the title leaf and read its immediate neighbours. Fragile by nature (FB's
// classes are obfuscated and change often) — hence purely best-effort.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const pad2 = (n) => String(n).padStart(2, "0");
const monthIndex = (s) => MONTHS.split("|").indexOf(s.slice(0, 3).toLowerCase());
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// First clock time in a header line → "HH:MM" (24h). Handles "10:00" (and
// ranges like "10:00-12:30", taking the start) and 12h "7pm" / "7:30 PM". Try
// the am/pm form first, otherwise a bare "7:30" matches the 24h branch before
// its "pm" is seen and comes out as 07:30 instead of 19:30.
function parseHeaderTime(text) {
  let m = text.match(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?\b/i);
  if (m) {
    let h = +m[1] % 12;
    if (/p/i.test(m[3])) h += 12;
    return `${pad2(h)}:${m[2] || "00"}`;
  }
  m = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${pad2(+m[1])}:${m[2]}`;
  return null;
}

// The next date on/after `now` whose weekday matches (1..7 days out). A bare
// weekday name means the upcoming one — if it were today FB would say "Today".
function nextWeekday(now, targetDow) {
  const d = startOfDay(now);
  let add = (targetDow - d.getDay() + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

// A bare 1..31 → day-of-month, else null. FB's header shows a "day-only" line
// ("Saturday …") next to a calendar box carrying the day number (e.g. "11").
function parseBoxDay(text) {
  const m = (text || "").trim().match(/^(\d{1,2})$/);
  const day = m ? +m[1] : 0;
  return day >= 1 && day <= 31 ? day : null;
}

// The nearest date on/after `now` matching *both* a weekday and a day-of-month.
// Using the box day pins the month/year exactly — a bare weekday alone could
// resolve to the wrong week for an event more than 7 days out that FB still
// renders day-only. Searches ~14 months, enough to hit any weekday+day pairing.
function dateFromWeekdayAndDay(now, targetDow, day) {
  const d = startOfDay(now);
  for (let i = 0; i < 420; i++) {
    if (d.getDate() === day && d.getDay() === targetDow) return new Date(d);
    d.setDate(d.getDate() + 1);
  }
  return null;
}

// Parse a FB header date/time line into an ISO string the rest of the pipeline
// understands: "YYYY-MM-DDTHH:MM:00" (local-naive) when a time is present, else
// "YYYY-MM-DD". Resolves relative forms ("Today", "Tomorrow", weekday names)
// against `now`; also handles "18 July 2026" / "July 18". Returns null if the
// text isn't a recognisable date — which also serves as our "is this a date
// line?" test. Time is embedded so the panel's structuredStartTime() finds it.
function parseHeaderDate(text, now, boxDay = null) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const time = parseHeaderTime(text);
  let date = null;

  if (/\btoday\b/.test(lower)) {
    date = startOfDay(now);
  } else if (/\btomorrow\b/.test(lower)) {
    date = startOfDay(now);
    date.setDate(date.getDate() + 1);
  } else {
    // Explicit day + month, in either order ("18 July", "July 18").
    let m =
      lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})`)) ||
      lower.match(new RegExp(`\\b(${MONTHS})\\w*\\s+(\\d{1,2})`));
    if (m) {
      const dayFirst = /^\d/.test(m[1]);
      const day = +(dayFirst ? m[1] : m[2]);
      const month = monthIndex(dayFirst ? m[2] : m[1]);
      const yr = (text.match(/\b(20\d\d)\b/) || [])[1];
      date = new Date(yr ? +yr : now.getFullYear(), month, day);
      // No year given → assume the next future occurrence, not one in the past.
      if (!yr && date < startOfDay(now)) date = new Date(now.getFullYear() + 1, month, day);
    } else {
      // Day-only line ("Saturday …"): pin the exact date with the calendar-box
      // day number when we have it, else settle for the next such weekday.
      const dow = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
      if (dow >= 0) {
        date = (boxDay && dateFromWeekdayAndDay(now, dow, boxDay)) || nextWeekday(now, dow);
      }
    }
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  const iso = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return time ? `${iso}T${time}:00` : iso;
}

// A leaf just below the title is the venue unless it's a FB UI label or itself
// a date line.
function isLikelyVenue(text) {
  if (!text || text.length < 3) return false;
  if (/^(interested|going|maybe|details|share|invite|save|guests?|see more|see all)$/i.test(text)) {
    return false;
  }
  return !parseHeaderDate(text, new Date());
}

// Anchor on the header title leaf (its text === the event name) and read the
// date line above it and venue line below. Prefers the occurrence whose line
// above parses as a date, so we skip stray copies of the title elsewhere on the
// page (sidebar, breadcrumbs).
function scrapeEventHeaderFromDom(name, now) {
  if (!name) return {};
  const leaves = [...document.querySelectorAll("h1,h2,h3,span,div,a")].filter(
    (e) => e.childElementCount === 0 && e.textContent.trim()
  );
  const matches = [];
  leaves.forEach((e, i) => {
    if (e.textContent.trim() === name) matches.push(i);
  });
  let idx = matches.find((i) => i > 0 && parseHeaderDate(leaves[i - 1].textContent, now));
  if (idx === undefined) idx = matches[0];
  if (idx === undefined) return {};

  const above = idx > 0 ? leaves[idx - 1].textContent.trim() : "";
  const below = idx + 1 < leaves.length ? leaves[idx + 1].textContent.trim() : "";
  // The calendar-box day number sits just above the (day-only) date line.
  const boxDay = idx > 1 ? parseBoxDay(leaves[idx - 2].textContent) : null;
  return {
    startDate: parseHeaderDate(above, now, boxDay),
    venue: isLikelyVenue(below) ? below : null,
  };
}

// Pull an Event object out of JSON-LD, if present. This is the only source that
// reliably carries a venue, but it's frequently *absent* on logged-in SPA
// sessions — hence the meta/DOM fallbacks in scrapeEventDetails().
function scrapeEventJsonLd() {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(node.textContent);
      const events = Array.isArray(data) ? data : [data];
      const event = events.find((d) => d && /Event/.test(d["@type"] || ""));
      if (event) {
        return {
          name: event.name || null,
          startDate: event.startDate || null,
          endDate: event.endDate || null,
          venue: event.location?.name || event.location?.address?.name || null,
        };
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return null;
}

// Structured event details, merged from most- to least-reliable sources:
// JSON-LD (clean, has venue, but often missing) → og:/event: meta tags in the
// server-rendered head (survive when JSON-LD is gone) → the document title
// (name of last resort). Venue only comes from JSON-LD; DOM scraping it is too
// fragile to trust. The meta/title fallbacks are gated to event pages: off one,
// og:title/document.title are just "Facebook" or a person's name, not an event.
function scrapeEventDetails() {
  const jsonLd = scrapeEventJsonLd();
  const onEvent = onEventPage();
  const meta = onEvent
    ? {
        name: cleanEventName(metaContent("og:title")) || cleanEventName(document.title),
        startDate: metaContent("event:start_time", "og:start_time"),
        endDate: metaContent("event:end_time", "og:end_time"),
      }
    : {};

  const name = jsonLd?.name || meta.name || null;

  // Last resort for date/venue: read the visible event-page header. Only bother
  // when we have a name to anchor on and a structured source didn't already
  // supply the value.
  const needsDate = !(jsonLd?.startDate || meta.startDate);
  const needsVenue = !jsonLd?.venue;
  const dom =
    onEvent && name && (needsDate || needsVenue)
      ? scrapeEventHeaderFromDom(name, new Date())
      : {};

  const details = {
    name,
    startDate: jsonLd?.startDate || meta.startDate || dom.startDate || null,
    endDate: jsonLd?.endDate || meta.endDate || null,
    venue: jsonLd?.venue || dom.venue || null,
  };
  // Nothing worth reporting? Say so, so the entry stays purely image-derived.
  if (!details.name && !details.startDate && !details.venue) return null;
  return details;
}
})();
