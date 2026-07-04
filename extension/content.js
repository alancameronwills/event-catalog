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

  // Only report the URL and metadata here. The service worker fetches the
  // actual bytes — content scripts run in the page origin and are CORS-blocked
  // from fbcdn, which previously left captures with no image (and no hash).
  return {
    imageUrl: bestResolutionUrl(img),
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

// On a proper Facebook Event page, structured data is exposed via JSON-LD.
function scrapeEventDetails() {
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
})();
