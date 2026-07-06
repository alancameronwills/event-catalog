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

// Pull an Event object out of JSON-LD, if present. This is the only source that
// reliably carries a venue, but it's frequently *absent* on logged-in SPA
// sessions — hence the meta/title fallbacks in scrapeEventDetails().
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
  const meta = onEventPage()
    ? {
        name: cleanEventName(metaContent("og:title")) || cleanEventName(document.title),
        startDate: metaContent("event:start_time", "og:start_time"),
        endDate: metaContent("event:end_time", "og:end_time"),
      }
    : {};

  const details = {
    name: jsonLd?.name || meta.name || null,
    startDate: jsonLd?.startDate || meta.startDate || null,
    endDate: jsonLd?.endDate || meta.endDate || null,
    venue: jsonLd?.venue || null,
  };
  // Nothing worth reporting? Say so, so the entry stays purely image-derived.
  if (!details.name && !details.startDate && !details.venue) return null;
  return details;
}
})();
