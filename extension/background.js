// Service worker: registers the context menu, handles capture requests,
// and manages the side panel.
//
// This no longer talks to any backend directly. It just scrapes the page
// (via content.js) and fetches the image bytes (content scripts are
// CORS-blocked from CDNs like fbcdn; the service worker isn't, thanks to
// host_permissions), then hands the result to the side panel. The panel
// decides whether the capture is complete enough to post straight to Pawb
// or needs to be held locally (chrome.storage.local) until edited.

const CONTEXT_MENU_ID = "add-to-event-catalog";

// --- Setup ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Add to event catalog",
    contexts: ["image"],
  });
});

// Let clicking the toolbar icon open the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("sidePanel.setPanelBehavior failed", err));
});

// --- Capture triggers ----------------------------------------------------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab) return;
  openPanel(tab.windowId);
  captureImage(tab.id, { srcUrl: info.srcUrl, pageUrl: info.pageUrl });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "capture-hovered-image" || !tab) return;
  openPanel(tab.windowId);
  // No srcUrl from a keyboard command; content script uses the hovered image.
  captureImage(tab.id, { srcUrl: null, pageUrl: tab.url });
});

function openPanel(windowId) {
  chrome.sidePanel
    .open({ windowId })
    .catch((err) => console.warn("sidePanel.open failed", err));
}

// --- Capture flow --------------------------------------------------------

// Ask the content script (running in the page) to gather the full-resolution
// image and nearby metadata, fetch the image bytes, and hand the result to
// the side panel. The panel owns all persistence decisions from here.
async function captureImage(tabId, hint) {
  try {
    const capture = await requestCapture(tabId, hint);
    if (!capture) return;

    // Fetch the image bytes here in the service worker. Content scripts run in
    // the page's origin and are CORS-blocked from image CDNs (e.g. fbcdn); the
    // service worker can fetch hosts listed in host_permissions without CORS.
    // The panel needs these bytes both to hash the image (duplicate detection)
    // and to upload it to Pawb.
    if (!capture.imageDataUrl && capture.imageUrl) {
      try {
        capture.imageDataUrl = await fetchImageDataUrl(capture.imageUrl);
      } catch (err) {
        console.warn("image fetch failed", capture.imageUrl, err);
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      ...capture,
    };
    notifyPanel({ type: "CAPTURE_ADDED", entry });
  } catch (err) {
    console.error("capture failed", err);
    const message = /Receiving end does not exist|Could not establish connection/i.test(
      String(err)
    )
      ? "Couldn't reach the page. Reload the tab and try again."
      : String(err.message || err);
    notifyPanel({ type: "CAPTURE_ERROR", message });
  }
}

// Message the content script; if it isn't there yet (e.g. the tab was open
// before the extension loaded), inject it and retry once.
async function requestCapture(tabId, hint) {
  const message = { type: "CAPTURE_IMAGE", hint };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(err))) {
      throw err;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// Fetch an image and encode it as a data URL. Runs in the service worker,
// which has no FileReader, so we build the base64 from an ArrayBuffer.
async function fetchImageDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch responded ${res.status}`);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const mime = blob.type || "image/jpeg";
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Best-effort message to the side panel; ignored if it isn't open.
function notifyPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
