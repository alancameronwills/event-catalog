// Service worker: registers the context menu, handles capture requests,
// and manages the side panel.
//
// Step 1 scaffold: captures are stored in chrome.storage.local so the side
// panel is functional standalone. Step 2 will forward captures to the local
// Node server instead (see saveCapture()).

const CONTEXT_MENU_ID = "add-to-event-catalog";
const STORAGE_KEY = "captures";

// Local catalog server (step 2). Captures POST here; if it's unreachable we
// fall back to chrome.storage.local so nothing is lost.
const SERVER_URL = "http://127.0.0.1:3777";

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

// Ask the content script (running in the Facebook page) to gather the
// full-resolution image and nearby metadata, then persist the result.
async function captureImage(tabId, hint) {
  try {
    const capture = await requestCapture(tabId, hint);
    if (!capture) return;

    // Fetch the image bytes here in the service worker. Content scripts run in
    // the page's origin and are CORS-blocked from fbcdn; the service worker can
    // fetch hosts listed in host_permissions without CORS. Without the bytes
    // there's no perceptual hash and therefore no duplicate detection.
    if (!capture.imageDataUrl && capture.imageUrl) {
      try {
        capture.imageDataUrl = await fetchImageDataUrl(capture.imageUrl);
      } catch (err) {
        console.warn("image fetch failed", capture.imageUrl, err);
      }
    }

    await saveCapture(capture);
  } catch (err) {
    console.error("capture failed", err);
    const message = /Receiving end does not exist|Could not establish connection/i.test(
      String(err)
    )
      ? "Couldn't reach the page. Reload the Facebook tab and try again."
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

async function saveCapture(capture) {
  const entry = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    ...capture,
  };

  try {
    const res = await fetch(`${SERVER_URL}/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const saved = await res.json();
    notifyPanel({ type: "CAPTURE_ADDED", entry: saved });
  } catch (err) {
    // Server offline: keep the capture locally so it isn't lost.
    console.warn("server save failed, storing locally", err);
    await storeLocally(entry);
    notifyPanel({ type: "CAPTURE_ADDED", entry, pending: true });
    notifyPanel({
      type: "SERVER_OFFLINE",
      message: "Catalog server offline — saved locally.",
    });
  }
}

async function storeLocally(entry) {
  const { [STORAGE_KEY]: existing = [] } = await chrome.storage.local.get(
    STORAGE_KEY
  );
  existing.unshift({ ...entry, pending: true });
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
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
