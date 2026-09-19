// Content script: runs on every page. On request from the service worker,
// locates the target image, upgrades it to full resolution where possible, and
// scrapes nearby caption text plus structured event details. The generic parts
// (image selection, caption, JSON-LD Event) work anywhere; the Facebook-specific
// scraping (og:/event: meta, header-DOM date/venue, og:image cover) is gated to
// FB event pages via onEventPage().
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

// Are we on a Facebook event page (facebook.com/events/<id>/)? Gated to the FB
// host too: the extension now runs on every site, and the event-specific
// scraping below (title "| Facebook" stripping, header-DOM date/venue, og:image
// cover) is meaningless — and potentially wrong — on some other site that
// happens to use an /events/<id> path.
function onEventPage() {
  return (
    /(^|\.)facebook\.com$/.test(location.hostname) &&
    /\/events\/\d+/.test(location.pathname)
  );
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
// event:* meta, so the date and venue live only as visible text. FB's classes
// are obfuscated, but the structure (found by inspecting a live event page)
// is stable enough to anchor on: the title sits in its own <div><h1>…</h1></div>;
// the <div> immediately before that one holds the date/time line, and the
// <div> immediately after it holds the venue. Fragile by nature — expected to
// need occasional maintenance as FB's DOM shifts.

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

// A leaf near the title is the venue unless it's a FB UI label, an attendee
// count, or itself a date line. Capped length: venues are short lines, not
// paragraphs (an over-long match is more likely a description leaf).
function isLikelyVenue(text) {
  if (!text || text.length < 3 || text.length > 120) return false;
  if (
    /^(interested|going|maybe|details|share|invite|save|guests?|see more|see all|public|private event|event by|hosted by|message|contact|report|duplicate event|add to timeline)\b/i.test(
      text
    )
  ) {
    return false;
  }
  if (/^[\d,.\s]+\s*(people|guests?)\b/i.test(text)) return false;
  return !parseHeaderDate(text, new Date());
}

// Leaves (elements with no element children) with non-empty text, inside a
// given root, in DOM order.
function textLeavesWithin(root) {
  return [...root.querySelectorAll("*")]
    .filter((e) => e.childElementCount === 0 && e.textContent.trim())
    .map((e) => e.textContent.trim());
}

// Read one <h1> candidate's sibling <div>s: the one before holds the
// date/time line, the one after holds the venue.
function readHeaderCandidate(h1, now) {
  const name = h1.textContent.trim();
  const titleDiv = h1.closest("div");
  if (!titleDiv) return { name, startDate: null, venue: null };

  const dateDiv = titleDiv.previousElementSibling;
  let startDate = null;
  if (dateDiv) {
    // Usually the whole block reads straight as a date/time line, but when
    // FB renders a calendar-box day number alongside a day-only weekday line
    // ("Saturday"), scan its leaves so the box day can pin the exact date.
    startDate = parseHeaderDate(dateDiv.textContent.trim(), now);
    if (!startDate) {
      const leaves = textLeavesWithin(dateDiv);
      for (let i = 0; i < leaves.length && !startDate; i++) {
        const boxDay = i > 0 ? parseBoxDay(leaves[i - 1]) : null;
        startDate = parseHeaderDate(leaves[i], now, boxDay);
      }
    }
  }

  const venueDiv = titleDiv.nextElementSibling;
  const venueText = venueDiv ? venueDiv.textContent.trim() : "";
  const venue = isLikelyVenue(venueText) ? venueText : null;

  return { name, startDate, venue };
}

// FB renders several <h1>s per page — visually-hidden landmark headings for
// unrelated widgets (e.g. a "Chats" heading for the Messenger sidebar, an
// "Events" nav heading) alongside the real event title. Try each in document
// order and keep the first whose neighbouring div actually parses as a date:
// that's the one signal a generic landmark heading won't have, so it reliably
// picks out the true event header. Falls back to the first <h1> (still useful
// for its name) if none have a parseable date neighbour.
function scrapeEventHeaderFromDom(now) {
  const h1s = [...document.querySelectorAll("h1")];
  const candidates = h1s.map((h1) => readHeaderCandidate(h1, now));
  let fallback = null;
  for (const candidate of candidates) {
    if (candidate.startDate) return candidate;
    if (!fallback) fallback = candidate;
  }
  return fallback || {};
}

// --- Tickets link ---------------------------------------------------------

// The next element (in DOM order) after `start` matching `predicate`.
function nextElementMatching(start, predicate) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = start;
  let node;
  while ((node = walker.nextNode())) {
    if (predicate(node)) return node;
  }
  return null;
}

// FB event pages often show a "Tickets" section linking out to the actual
// ticketing site (Eventbrite, DICE, the venue's own site, …) — a more useful
// booking link than the bare facebook.com event URL. Structure (per a live
// page): a <span> containing exactly "Tickets", then the next <div> in
// document order holds the link. FB renders more than one such span (e.g. a
// header quick-action pill as well as a dedicated Tickets section), so try
// each in turn and keep the first that actually yields a link.
function findTicketsUrl() {
  const labels = [...document.querySelectorAll("span")].filter(
    (s) => s.textContent.trim().toLowerCase() === "tickets"
  );
  for (const label of labels) {
    const container = nextElementMatching(label, (e) => e.tagName === "DIV");
    const link = container?.querySelector("a[href]");
    if (link) return resolveFacebookRedirect(link.href);
  }
  return null;
}

// FB routes outbound links through a redirector, e.g.
// "https://l.facebook.com/l.php?u=<encoded target>&h=…" — unwrap to the real
// destination. Anything else (e.g. an FB-hosted checkout link) is returned
// as-is.
function resolveFacebookRedirect(href) {
  try {
    const u = new URL(href, location.href);
    if (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname === "/l.php") {
      const target = u.searchParams.get("u");
      if (target) return target;
    }
    return u.href;
  } catch {
    return href || null;
  }
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

// Structured event details, merged from most- to least-reliable sources. On
// an event page the visible header DOM (see scrapeEventHeaderFromDom) goes
// *first*: it's the only source guaranteed to reflect what's actually on
// screen right now. JSON-LD and the <head> og:/event: meta tags are
// server-rendered at the initial page load and only refreshed on a full
// reload — after Facebook's in-app SPA navigation to an event they can lag
// behind, so they're kept only as fallbacks for whatever the DOM didn't
// supply. The meta/title/DOM fallbacks are gated to event pages: off one,
// og:title/document.title are just "Facebook" or a person's name, not an
// event.
function scrapeEventDetails() {
  const jsonLd = scrapeEventJsonLd();
  const onEvent = onEventPage();
  const dom = onEvent ? scrapeEventHeaderFromDom(new Date()) : {};
  const meta = onEvent
    ? {
        name: cleanEventName(metaContent("og:title")) || cleanEventName(document.title),
        startDate: metaContent("event:start_time", "og:start_time"),
        endDate: metaContent("event:end_time", "og:end_time"),
      }
    : {};

  const name = dom.name || jsonLd?.name || meta.name || null;

  const details = {
    name,
    startDate: dom.startDate || jsonLd?.startDate || meta.startDate || null,
    endDate: jsonLd?.endDate || meta.endDate || null,
    venue: dom.venue || jsonLd?.venue || null,
    url: onEvent ? findTicketsUrl() : null,
  };
  // Nothing worth reporting? Say so, so the entry stays purely image-derived.
  if (!details.name && !details.startDate && !details.venue && !details.url) return null;
  return details;
}
})();
