// Side panel: an editor for Pawb (gigiau.uk/pawb) content, grouped by date.
//
// Pawb is the catalog. A capture with enough info (title + venue) is posted
// straight to Pawb on save; anything missing is held in chrome.storage.local
// until it's completed, then synced automatically. Editing/deleting a
// Pawb-backed poster writes straight through to Pawb too.
//
// Users can create empty dates and move items between dates by dragging, or
// by copy/paste (select an item, Ctrl/Cmd+C, focus a date group, Ctrl/Cmd+V).

import { computeDHash, hammingDistance, DUP_THRESHOLD } from "../dhash.js";

const STORAGE_KEY = "captures"; // locally-held entries not yet valid enough for Pawb
const CREATED_DATES_KEY = "createdDates"; // local-only empty date placeholders
const IMAGE_HASH_CACHE_KEY = "imageHashCache"; // pictureUrl -> dHash, across renders

const PAWB_BASE = "https://gigiau.uk/pawb/wp-json/gigiau/v1";

// The username and (secret) application password are NOT kept in source. Both
// are stored in chrome.storage.local (this browser profile only) and prompted
// for on first use — see getPawbAuth(). The username is only a default the
// prompt pre-fills, since it may change. Storage keys are unchanged from the
// old upload-only flow so any already-saved credentials keep working.
const PAWB_USER_DEFAULT = "alan";
const PAWB_USER_KEY = "uploadUser";
const PAWB_PASSWORD_KEY = "uploadPassword";

const POLL_INTERVAL_MS = 60000; // other people may have this open too

const catalogEl = document.getElementById("catalog");
const emptyEl = document.getElementById("empty");
const emptyFiltered = document.getElementById("emptyFiltered");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const expandBtn = document.getElementById("expand-btn");
const filterBtn = document.getElementById("filter-btn");
const turnOffFilterBtn = document.getElementById("turnOffFilter");
const addDateForm = document.getElementById("add-date-form");
const addDateInput = document.getElementById("add-date-input");
const lightboxEl = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const editorForm = document.getElementById("editor-form");
const editorDupWarning = document.getElementById("editor-dup-warning");
const editorRecurringNote = document.getElementById("editor-recurring-note");
const editorTitle = document.getElementById("editor-title");
const editorVenue = document.getElementById("editor-venue");
const editorStart = document.getElementById("editor-start");
const editorEndDate = document.getElementById("editor-end-date");
const editorDtinfo = document.getElementById("editor-dtinfo");
const editorUrl = document.getElementById("editor-url");
const editorCancel = document.getElementById("editor-cancel");
const venueDatalist = document.getElementById("venue-suggestions");

// Interaction state.
let selectedId = null; // highlighted item
let clipboardId = null; // item picked up with Ctrl/Cmd+C
let focusedDate = null; // group targeted for paste
let draggingActive = false;
let entriesById = new Map(); // id -> entry, refreshed each render
let editingId = null; // poster whose metadata is open in the editor
// True while the open editor is for a capture that was just taken and hasn't
// been saved yet — Cancel/Escape on this one discards the capture entirely
// (see cancelEditor) rather than leaving an empty local entry behind.
let editingIsNewCapture = false;
let filterInvalid = false; // when on, show only locally-held (not-yet-on-Pawb) items
let lastKnownVersion = null; // last-seen GET /events/version fingerprint
let authPromptDeclined = false; // avoid re-prompting repeatedly after a Cancel this session
const monthState = new Map(); // "YYYY-MM"|"unknown" -> open? (persists re-renders)

document.addEventListener("DOMContentLoaded", async () => {
  await pruneOutdated();
  await render();
  wireControls();
  startPolling();
});

// --- Talking to Pawb -------------------------------------------------------

// Build the Basic-auth header, prompting for (and locally saving) the
// username and app password the first time. Returns null if the user
// cancels (and won't re-prompt again this session unless the credentials are
// later forgotten, e.g. after a 401). WordPress strips non-alphanumerics on
// auth, so the display spaces in the password are dropped.
async function getPawbAuth() {
  let { [PAWB_USER_KEY]: user, [PAWB_PASSWORD_KEY]: password } =
    await chrome.storage.local.get([PAWB_USER_KEY, PAWB_PASSWORD_KEY]);
  if ((!user || !password) && authPromptDeclined) return null;
  if (!user || !password) {
    const enteredUser = window.prompt(
      "gigiau.uk username:\nSaved in this browser only, not in the extension's code.",
      user || PAWB_USER_DEFAULT
    );
    if (!enteredUser || !enteredUser.trim()) {
      authPromptDeclined = true;
      return null;
    }
    user = enteredUser.trim();
    const enteredPass = window.prompt(
      `WordPress Application Password for "${user}":\n` +
        `NOT your normal WordPress login password — this is a separate, revocable ` +
        `code you create under your WordPress profile → Application Passwords. ` +
        `Saved in this browser only, not in the extension's code.`
    );
    if (!enteredPass || !enteredPass.trim()) {
      authPromptDeclined = true;
      return null;
    }
    password = enteredPass.trim();
    await chrome.storage.local.set({
      [PAWB_USER_KEY]: user,
      [PAWB_PASSWORD_KEY]: password,
    });
  }
  return "Basic " + btoa(`${user}:${password.replace(/\s+/g, "")}`);
}

// Drop the saved (e.g. wrong) credentials so the next call re-prompts.
async function forgetPawbAuth() {
  await chrome.storage.local.remove([PAWB_USER_KEY, PAWB_PASSWORD_KEY]);
  authPromptDeclined = false;
}

// fetch() against Pawb's REST API with the auth header attached. A 401/403
// means missing/wrong credentials, so forget them and let the next call
// re-prompt.
async function pawbFetch(path, options = {}) {
  const auth = await getPawbAuth();
  const headers = { ...(options.headers || {}) };
  if (auth) headers["Authorization"] = auth;
  const res = await fetch(`${PAWB_BASE}${path}`, { ...options, headers });
  if (res.status === 401 || res.status === 403) await forgetPawbAuth();
  return res;
}

// Cheap poll target: only trigger a full refresh when the fingerprint changes
// (see gigio_rest_events_version in the plugin).
async function fetchVersion() {
  try {
    const res = await pawbFetch("/events/version");
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

function startPolling() {
  setInterval(async () => {
    const v = await fetchVersion();
    if (v && v !== lastKnownVersion) await render();
  }, POLL_INTERVAL_MS);
}

// Re-render when a capture is added, and surface status messages.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_ADDED") {
    if (!message.entry) return;
    // Held locally until the user completes and saves it (see syncEntry).
    openMonthFor(dateKey(message.entry));
    storeLocalCapture(message.entry)
      .then(() => render())
      .then(() =>
        openEditor(entriesById.get(message.entry.id) || message.entry, {
          isNewCapture: true,
        })
      );
  } else if (message.type === "CAPTURE_ERROR") {
    showStatus(`Capture failed: ${message.message}`);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[CREATED_DATES_KEY])) {
    render();
  }
});

// --- Data loading ----------------------------------------------------------

// Pawb is the source of truth for everything valid; chrome.storage.local
// holds only entries not yet complete enough to post there.
async function loadCaptures() {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  try {
    const res = await pawbFetch("/events");
    if (!res.ok) throw new Error(`Pawb responded ${res.status}`);
    const remote = await res.json();
    // The admin (rich) shape always has a `venue` key; a bad/missing
    // credential silently degrades to the minimal public shape instead of
    // erroring. Treat that as an auth problem rather than rendering a
    // half-broken catalog.
    if (remote.length && !("venue" in remote[0])) {
      console.warn(
        "loadCaptures: GET /events returned the minimal (unauthenticated) shape " +
          "even though credentials are saved — treating as an auth failure.",
        remote[0]
      );
      await forgetPawbAuth();
      showStatus("Pawb sign-in needed — try an edit/delete to re-enter your app password.");
      return local;
    }
    return [...local, ...remote.map(fromPawbEvent)];
  } catch (err) {
    console.warn("loadCaptures: GET /events failed, showing local only", err);
    return local;
  }
}

async function loadCreatedDates() {
  const { [CREATED_DATES_KEY]: local = [] } = await chrome.storage.local.get(
    CREATED_DATES_KEY
  );
  return local;
}

// Map one admin-shaped Pawb event (see gigio_admin_event_shape in the plugin)
// into the panel's internal entry fields.
function fromPawbEvent(gig) {
  const [datePart, timePart] = splitDtstart(gig.dtstart);
  const endDatePart = isDateString(gig.dtend) ? gig.dtend : null;
  return {
    id: String(gig.id),
    wpId: gig.id,
    title: gig.title || "",
    venue: gig.venue || "",
    dtinfo: gig.dtinfo || "",
    url: gig.bookinglink || "",
    assignedDate: datePart,
    assignedTime: timePart,
    // Only a real multi-day span counts as an end date; Pawb always stores
    // dtend even for single-day events (defaulted equal to dtstart).
    assignedEndDate: endDatePart && datePart && endDatePart > datePart ? endDatePart : null,
    imageSrc: gig.picture || "",
    recurring: !!gig.recurring,
    pawbLink: gig.link || "",
  };
}

// gig.dtstart is "YYYY-MM-DD", "YYYY-MM-DD HH:MM", or "YYYY-MM-DDTHH:MM".
function splitDtstart(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(value || "");
  if (m) return [m[1], `${m[2]}:${m[3]}`];
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(value || "");
  return [dateOnly ? dateOnly[1] : null, null];
}

// --- Duplicate detection (client-side) --------------------------------------

// Hash every loaded entry's image, caching Pawb-hosted ones (by picture URL)
// across renders so an unchanged catalog isn't re-fetched/re-hashed every
// time. Local (not-yet-synced) entries are cheap to re-hash (no network —
// their bytes are already a data URL) so they're never cached.
async function ensureHashes(captures) {
  const { [IMAGE_HASH_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(
    IMAGE_HASH_CACHE_KEY
  );
  let dirty = false;

  const hashes = await Promise.all(
    captures.map(async (entry) => {
      const src = imageSrc(entry);
      if (!src) return null;
      if (entry.imageSrc && cache[entry.imageSrc]) return cache[entry.imageSrc];
      const hash = await hashForSrc(src);
      if (hash && entry.imageSrc) {
        cache[entry.imageSrc] = hash;
        dirty = true;
      }
      return hash;
    })
  );

  const liveSrcs = new Set(captures.map((e) => e.imageSrc).filter(Boolean));
  for (const key of Object.keys(cache)) {
    if (!liveSrcs.has(key)) {
      delete cache[key];
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.local.set({ [IMAGE_HASH_CACHE_KEY]: cache });

  return hashes;
}

async function hashForSrc(src) {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await computeDHash(blob);
  } catch (err) {
    console.warn("hash failed for", src, err);
    return null;
  }
}

// Flag every entry whose image is within DUP_THRESHOLD of another currently-
// loaded entry's image. Mutual (both sides of a pair get flagged) — simpler
// than picking a "newer" side, and the existing UI (badge, warning,
// skip-confirm-on-delete) works the same either way.
function annotateDuplicates(captures, hashes) {
  for (const entry of captures) {
    entry.duplicateOf = null;
    entry.duplicateDistance = null;
  }
  for (let i = 0; i < captures.length; i++) {
    if (!hashes[i]) continue;
    let best = null;
    for (let j = 0; j < captures.length; j++) {
      if (j === i || !hashes[j]) continue;
      const d = hammingDistance(hashes[i], hashes[j]);
      if (d <= DUP_THRESHOLD && (!best || d < best.d)) best = { j, d };
    }
    if (best) {
      captures[i].duplicateOf = captures[best.j].id;
      captures[i].duplicateDistance = best.d;
    }
  }
}

// --- Rendering ---------------------------------------------------------------

async function render() {
  const [captures, createdDates, version] = await Promise.all([
    loadCaptures(),
    loadCreatedDates(),
    fetchVersion(),
  ]);
  if (version) lastKnownVersion = version;

  const hashes = await ensureHashes(captures);
  annotateDuplicates(captures, hashes);

  entriesById = new Map(captures.map((e) => [e.id, e]));
  populateVenueSuggestions(captures);

  countEl.textContent = captures.length
    ? `${captures.length} ${captures.length === 1 ? "capture" : "captures"}`
    : "";

  // Drop previously-rendered content (top-level month sections and the
  // always-visible "unknown" group).
  for (const el of catalogEl.querySelectorAll(":scope > .month, :scope > .date-group")) {
    el.remove();
  }

  // When the filter is on, show only entries not yet on Pawb (incomplete or
  // still waiting to sync).
  const visible = filterInvalid ? captures.filter((e) => !e.wpId) : captures;

  // Group items by stable date key, then ensure created (possibly empty) dates
  // each have a group.
  const groups = new Map();
  for (const entry of visible) {
    const key = dateKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  // Empty created dates only clutter the filtered view, so skip them there.
  const createdSet = new Set(createdDates);
  if (!filterInvalid) {
    for (const date of createdDates) {
      if (!groups.has(date)) groups.set(date, []);
    }
  }

  if (groups.size === 0) {
    if (filterInvalid)
      emptyFiltered.hidden = false;
    else
      emptyEl.hidden = false;

    return;
  }
  emptyEl.hidden = true;
  emptyFiltered.hidden = true;

  // Bucket date keys (earliest first, "unknown" last) into calendar months so
  // the list reads as collapsible month sections.
  const months = new Map(); // monthKey -> [dateKey, ...]
  for (const key of sortedKeys(groups.keys())) {
    const mKey = monthKeyOf(key);
    if (!months.has(mKey)) months.set(mKey, []);
    months.get(mKey).push(key);
  }

  for (const [mKey, dateKeys] of months) {
    if (mKey === "unknown") {
      // No real month to fold under; render the group on its own at the end.
      for (const key of dateKeys) {
        catalogEl.appendChild(renderGroup(key, groups.get(key), createdSet));
      }
    } else {
      catalogEl.appendChild(renderMonth(mKey, dateKeys, groups, createdSet));
    }
  }
}

// --- Month grouping ----------------------------------------------------------

function monthKeyOf(key) {
  return key === "unknown" ? "unknown" : key.slice(0, 7);
}

function currentMonthKey() {
  return todayKey().slice(0, 7);
}

// Whether a month section is expanded. First sighting defaults to open for the
// current month, collapsed otherwise; user toggles then persist across renders.
function isMonthOpen(mKey) {
  if (!monthState.has(mKey)) monthState.set(mKey, mKey === currentMonthKey());
  return monthState.get(mKey);
}

// Force a month open — used when something lands in it (new capture, move, or
// a freshly added date) so the change is actually visible.
function openMonthFor(key) {
  monthState.set(monthKeyOf(key), true);
}

function formatMonthKey(mKey) {
  const [y, m] = mKey.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  if (Number.isNaN(d.getTime())) return mKey;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function renderMonth(mKey, dateKeys, groups, createdSet) {
  const section = document.createElement("section");
  section.className = "month";
  section.dataset.month = mKey;
  if (!isMonthOpen(mKey)) section.classList.add("collapsed");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "month-header";

  const chevron = document.createElement("span");
  chevron.className = "month-chevron";
  chevron.textContent = "▸";

  const label = document.createElement("span");
  label.className = "month-label";
  label.textContent = formatMonthKey(mKey);

  const count = document.createElement("span");
  count.className = "month-count";
  const n = dateKeys.reduce((sum, k) => sum + groups.get(k).length, 0);
  count.textContent = n ? String(n) : "";

  header.append(chevron, label, count);
  header.addEventListener("click", () => {
    const collapsed = section.classList.toggle("collapsed");
    monthState.set(mKey, !collapsed);
  });
  section.appendChild(header);

  const body = document.createElement("div");
  body.className = "month-body";
  for (const key of dateKeys) {
    body.appendChild(renderGroup(key, groups.get(key), createdSet));
  }
  section.appendChild(body);
  return section;
}

// Stable YYYY-MM-DD key. Precedence: explicit assignment > structured event
// date > OCR-extracted date > capture date; unparseable dates fall into
// "unknown". For Pawb-backed entries, assignedDate is always Pawb's own
// dtstart, so this resolves on the first check.
function dateKey(entry) {
  if (isDateString(entry.assignedDate)) return entry.assignedDate;
  const structured = new Date(entry.event?.startDate);
  if (entry.event?.startDate && !Number.isNaN(structured.getTime())) {
    return structured.toISOString().slice(0, 10);
  }
  if (isDateString(entry.ocrDate)) return entry.ocrDate;
  const d = new Date(entry.capturedAt);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

function isDateString(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function isTimeString(v) {
  if (typeof v !== "string") return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return !!m && +m[1] <= 23 && +m[2] <= 59;
}

// Valid dates earliest first (upcoming events read top-to-bottom); "unknown"
// always last.
function sortedKeys(keys) {
  return [...keys].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function formatDateKey(key) {
  if (key === "unknown") return "Unknown date";
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function renderGroup(key, entries, createdSet) {
  const section = document.createElement("section");
  section.className = "date-group";
  section.dataset.date = key;
  if (key === focusedDate) section.classList.add("focused");

  const heading = document.createElement("h2");
  const label = document.createElement("span");
  label.textContent = formatDateKey(key);
  heading.appendChild(label);

  // Empty groups are always user-created dates; offer to remove them.
  if (entries.length === 0 && createdSet.has(key)) {
    const del = document.createElement("button");
    del.className = "date-del";
    del.type = "button";
    del.title = "Remove this date";
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDate(key);
    });
    heading.appendChild(del);
  }
  section.appendChild(heading);

  if (entries.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "drop-hint";
    placeholder.textContent = "Drop or paste posters here";
    section.appendChild(placeholder);
  } else {
    const grid = document.createElement("div");
    grid.className = "thumb-grid";
    for (const entry of entries) grid.appendChild(renderThumb(entry));
    section.appendChild(grid);
  }

  wireGroupTarget(section, key);
  return section;
}

function renderThumb(entry) {
  const fig = document.createElement("figure");
  fig.className = "thumb";
  fig.dataset.id = entry.id;
  fig.draggable = true;
  fig.title = thumbTooltip(entry);
  if (entry.id === selectedId) fig.classList.add("selected");

  const img = document.createElement("img");
  img.loading = "lazy";
  img.draggable = false; // let the figure own the drag
  img.src = imageSrc(entry);
  img.alt = displayTitle(entry) || "Event poster";
  fig.appendChild(img);

  const edit = document.createElement("button");
  edit.className = "thumb-edit";
  edit.type = "button";
  edit.title = "Edit details";
  edit.textContent = "✎";
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(entry);
  });
  fig.appendChild(edit);

  const del = document.createElement("button");
  del.className = "thumb-del";
  del.type = "button";
  del.title = "Delete this poster";
  del.textContent = "×";
  del.addEventListener("click", (e) => {
    e.stopPropagation(); // don't select / enlarge
    confirmDelete(entry); // confirms first, unless it's a flagged duplicate
  });
  fig.appendChild(del);

  if (entry.duplicateOf) {
    const badge = document.createElement("span");
    badge.className = "dup-badge";
    badge.textContent = "dup?";
    const base =
      entry.duplicateDistance != null
        ? `Possible duplicate of an existing poster (similarity distance ${entry.duplicateDistance})`
        : "Possible duplicate of an existing poster";
    badge.title = `${base} — click to show it`;
    badge.addEventListener("click", (e) => {
      e.stopPropagation(); // don't select / enlarge this thumb
      scrollToDuplicate(entry);
    });
    fig.appendChild(badge);
  }

  // "Not yet on Pawb" indicator, bottom-left: red = missing title/venue
  // (can't sync yet), grey = valid but not synced (e.g. a create attempt
  // failed offline — click to retry). Nothing shown once it's on Pawb.
  if (!entry.wpId) {
    const state = document.createElement("button");
    state.className = "thumb-state";
    state.type = "button";
    const complete = isUploadable(entry);
    state.dataset.state = complete ? "pending" : "incomplete";
    state.title = complete
      ? "Not yet on Pawb — click to retry"
      : "Set title and venue to add it to Pawb";
    state.addEventListener("click", (e) => {
      e.stopPropagation();
      if (complete) retrySync(entry);
      else openEditor(entry);
    });
    fig.appendChild(state);
  }

  fig.addEventListener("click", (e) => {
    e.stopPropagation(); // selecting an item shouldn't also refocus its group
    selectThumb(entry.id);
    openLightbox(entry);
  });
  fig.addEventListener("dragstart", (e) => {
    draggingActive = true;
    fig.classList.add("dragging");
    e.dataTransfer.setData("text/plain", entry.id);
    e.dataTransfer.effectAllowed = "move";
  });
  fig.addEventListener("dragend", () => {
    draggingActive = false;
    fig.classList.remove("dragging");
    for (const el of catalogEl.querySelectorAll(".drop-target")) {
      el.classList.remove("drop-target");
    }
  });

  return fig;
}

// A date group is both a drop target (for dragging) and a paste target (click
// to focus, then Ctrl/Cmd+V). "unknown" has no concrete date, so skip it.
function wireGroupTarget(section, key) {
  if (key === "unknown") return;

  section.addEventListener("click", () => setFocusedDate(key));

  section.addEventListener("dragover", (e) => {
    // Accept both an internal poster move and an image dragged in from a page
    // or the file system.
    if (!draggingActive && !isImageDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = draggingActive ? "move" : "copy";
    section.classList.add("drop-target");
  });
  section.addEventListener("dragleave", (e) => {
    if (!section.contains(e.relatedTarget)) section.classList.remove("drop-target");
  });
  section.addEventListener("drop", (e) => {
    e.preventDefault();
    section.classList.remove("drop-target");
    if (draggingActive) {
      const id = e.dataTransfer.getData("text/plain");
      if (id) moveEntry(id, key);
      return;
    }
    // A poster dropped onto this date: capture it here, pinned to this date
    // (no date parsing — the drop location is the date).
    addDroppedImage(e.dataTransfer, key);
  });
}

// True when a drag carries an image (a file, or an <img>/URL from a page). Used
// to light up date groups as drop targets for capture-by-drop.
function isImageDrag(dt) {
  if (!dt) return false;
  return [...dt.types].some(
    (t) => t === "Files" || t === "text/uri-list" || t === "text/html"
  );
}

// --- Interactions ------------------------------------------------------------

function selectThumb(id) {
  selectedId = id;
  for (const el of catalogEl.querySelectorAll(".thumb.selected")) {
    el.classList.remove("selected");
  }
  const fig = catalogEl.querySelector(`.thumb[data-id="${CSS.escape(id)}"]`);
  if (fig) fig.classList.add("selected");
}

// Jump to the poster this one was flagged a duplicate of: expand its month if
// collapsed, scroll it into view, and flash/select it.
function scrollToDuplicate(entry) {
  const target = entry.duplicateOf && entriesById.get(entry.duplicateOf);
  if (!target) {
    showHint("The matching poster isn't in the catalog anymore.");
    return;
  }
  const mKey = monthKeyOf(dateKey(target));
  const monthEl = catalogEl.querySelector(`.month[data-month="${CSS.escape(mKey)}"]`);
  if (monthEl && monthEl.classList.contains("collapsed")) {
    monthEl.classList.remove("collapsed");
    monthState.set(mKey, true);
  }

  const fig = catalogEl.querySelector(`.thumb[data-id="${CSS.escape(target.id)}"]`);
  if (!fig) return;
  selectThumb(target.id);
  fig.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restart the flash animation even if it's already selected/flashed.
  fig.classList.remove("flash");
  void fig.offsetWidth;
  fig.classList.add("flash");
}

// Plain enlarge: image only, dismissed by clicking the overlay.
function openLightbox(entry) {
  editorForm.hidden = true;
  lightboxEl.classList.remove("editing");
  editingId = null;
  lightboxImg.src = imageSrc(entry);
  lightboxEl.hidden = false;
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxImg.removeAttribute("src");
}

// --- Metadata editor ----------------------------------------------------------

// Effective title/venue. Pawb-backed entries always have these set directly;
// a freshly-captured local entry falls back to whatever content.js scraped.
function displayTitle(entry) {
  return entry.title || entry.event?.name || "";
}
function displayVenue(entry) {
  return entry.venue || entry.event?.venue || "";
}
function displayUrl(entry) {
  // A user-set URL always wins; otherwise prefer a scraped Tickets link (see
  // findTicketsUrl() in content.js — a more useful booking link than the FB
  // event page itself); otherwise fall back to the captured page URL, but
  // only when it points at a specific page (not the bare facebook.com root).
  return entry.url || entry.event?.url || specificPageUrl(entry.pageUrl) || "";
}

// The captured page URL is only useful as a link if it names a specific page /
// post / event. Captured from the feed it's just "https://facebook.com" — treat
// that (any facebook.com root, with or without a trailing slash/query) as blank.
function specificPageUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname.replace(/\/+$/, "") === "") {
      return "";
    }
    return url;
  } catch {
    return url; // not parseable — leave it as-is rather than dropping it
  }
}

// Fill the venue autocomplete from the currently-loaded entries (Pawb-backed
// and local). De-duplicated case-insensitively, sorted.
function populateVenueSuggestions(captures) {
  const byLower = new Map(); // lowercase -> first-seen spelling
  const add = (v) => {
    const name = (v || "").trim();
    if (name && !byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
  };
  for (const entry of captures) add(displayVenue(entry));

  const sorted = [...byLower.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  venueDatalist.replaceChildren(
    ...sorted.map((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      return opt;
    })
  );
}

function thumbTooltip(entry) {
  const time = formatTime(eventTimeKey(entry));
  const head = [displayTitle(entry), displayVenue(entry)].filter(Boolean).join(" — ");
  const endKey = eventEndDateKey(entry);
  const until = endKey ? `until ${formatDateKey(endKey)}` : "";
  return (
    [head, time, until].filter(Boolean).join(" · ") ||
    entry.caption ||
    entry.pageTitle ||
    ""
  );
}

// The poster's event date (assignment > structured > OCR), as YYYY-MM-DD, or ""
// if only the capture date is known — so the picker starts on the parsed date
// when there is one and blank otherwise.
function eventDateKey(entry) {
  if (isDateString(entry.assignedDate)) return entry.assignedDate;
  const structured = new Date(entry.event?.startDate);
  if (entry.event?.startDate && !Number.isNaN(structured.getTime())) {
    return structured.toISOString().slice(0, 10);
  }
  if (isDateString(entry.ocrDate)) return entry.ocrDate;
  return "";
}

// The event's end date (multi-day events) as YYYY-MM-DD, or "" for single-day.
// Precedence: user override > structured event end date. No OCR/capture fallback
// — absence means single-day.
function eventEndDateKey(entry) {
  if (isDateString(entry.assignedEndDate)) return entry.assignedEndDate;
  const s = entry.event?.endDate;
  const structured = new Date(s);
  if (s && !Number.isNaN(structured.getTime())) {
    return structured.toISOString().slice(0, 10);
  }
  return "";
}

// The poster's start time as 24-hour "HH:MM", or "" if unknown. Precedence
// mirrors the date: user override > structured event time > OCR-parsed time.
function eventTimeKey(entry) {
  if (isTimeString(entry.assignedTime)) return entry.assignedTime;
  const structured = structuredStartTime(entry);
  if (structured) return structured;
  if (isTimeString(entry.ocrTime)) return entry.ocrTime;
  return "";
}

// Pull HH:MM straight out of a structured startDate string (e.g.
// "2026-08-15T19:00:00+10:00") rather than via Date(), which would shift it
// into the viewer's timezone — we want the event's own local time.
function structuredStartTime(entry) {
  const s = entry.event?.startDate;
  const m = typeof s === "string" && /t(\d{2}):(\d{2})/i.exec(s);
  return m ? `${m[1]}:${m[2]}` : null;
}

// "19:30" -> "7:30 PM"; "20:00" -> "8 PM". For tooltips only.
function formatTime(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return "";
  let h = +m[1];
  const min = m[2];
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return min === "00" ? `${h} ${ap}` : `${h}:${min} ${ap}`;
}

// Split the combined start field's "YYYY-MM-DDTHH:MM" into its stored parts.
// Midnight is treated as "no time": datetime-local always carries a time, so a
// poster with an unknown time shows T00:00 — saving that as a real 00:00 would
// wrongly surface "12 AM" everywhere. A genuine midnight start isn't
// representable here, an acceptable trade for not inventing times.
function splitStart(value) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value || "");
  if (!m) return { date: null, time: null };
  const time = `${m[2]}:${m[3]}`;
  return { date: m[1], time: time === "00:00" ? null : time };
}

// Edit mode: show the poster above, dock the form below; both close on
// save/cancel.
function openEditor(entry, { isNewCapture = false } = {}) {
  editingId = entry.id;
  editingIsNewCapture = isNewCapture;
  editorTitle.value = displayTitle(entry);
  editorVenue.value = displayVenue(entry);
  // Start date+time in one field. Default an unknown date to today (rather than
  // leaving it blank) so a new capture starts on a real date; datetime-local
  // needs a time component, so fall back to midnight when the time is unknown.
  const startDate = eventDateKey(entry) || todayKey();
  const startTime = eventTimeKey(entry) || "00:00";
  editorStart.value = `${startDate}T${startTime}`;
  editorEndDate.value = eventEndDateKey(entry);
  editorEndDate.min = startDate; // can't end before it starts
  editorDtinfo.value = entry.dtinfo || "";
  editorUrl.value = displayUrl(entry);

  // Recurring events' dates come from WordPress's recurrence rules, not a
  // literal stored date — editing them here would overwrite the pattern's
  // origin date with today's computed next-occurrence date. Disable date
  // editing for those; everything else stays editable.
  editorStart.disabled = !!entry.recurring;
  editorEndDate.disabled = !!entry.recurring;
  editorRecurringNote.hidden = !entry.recurring;

  showDuplicateWarning(entry);

  lightboxImg.src = imageSrc(entry);
  editorForm.hidden = false;
  lightboxEl.classList.add("editing");
  lightboxEl.hidden = false;
  editorTitle.focus();
}

// If this poster was flagged as a likely duplicate, warn with the title (if
// any) and date of the matched poster.
function showDuplicateWarning(entry) {
  const dup = entry.duplicateOf ? entriesById.get(entry.duplicateOf) : null;
  if (!dup) {
    editorDupWarning.hidden = true;
    return;
  }
  const title = displayTitle(dup);
  const date = formatDateKey(dateKey(dup));
  editorDupWarning.textContent = title
    ? `⚠ Possible duplicate of “${title}” (${date}).`
    : `⚠ Possible duplicate — already saved (${date}).`;
  editorDupWarning.hidden = false;
}

function closeEditor() {
  editorForm.hidden = true;
  lightboxEl.classList.remove("editing");
  lightboxEl.hidden = true;
  lightboxImg.removeAttribute("src");
  editingId = null;
  editingIsNewCapture = false;
}

// Cancel/Escape: close the editor, and if it was showing a capture that was
// just taken and never saved, discard it entirely rather than leaving an
// empty (title/venue-less) local entry behind — it was never asked for.
async function cancelEditor() {
  const discardId = editingIsNewCapture ? editingId : null;
  closeEditor();
  if (!discardId) return;
  await removeLocalEntry(discardId);
  if (selectedId === discardId) selectedId = null;
  if (clipboardId === discardId) clipboardId = null;
  await render();
}

function setFocusedDate(key) {
  focusedDate = key;
  for (const el of catalogEl.querySelectorAll(".date-group.focused")) {
    el.classList.remove("focused");
  }
  const section = catalogEl.querySelector(`.date-group[data-date="${CSS.escape(key)}"]`);
  if (section) section.classList.add("focused");
}

function toggleFilter(toState) {
  filterInvalid = !!(toState == null ? !filterInvalid : toState);
  render();
  filterBtn.classList.toggle("active", filterInvalid);
  filterBtn.setAttribute("aria-pressed", String(filterInvalid));
}

function wireControls() {
  // The add-date form is always visible; default its picker to today.
  if (!addDateInput.value) addDateInput.value = new Date().toISOString().slice(0, 10);
  addDateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isDateString(addDateInput.value)) addDate(addDateInput.value);
  });

  // Expand every month section so the whole catalog is visible at once.
  expandBtn.addEventListener("click", expandAllMonths);

  // Filter toggle: narrow the view to items not yet on Pawb.
  filterBtn.addEventListener("click", () => toggleFilter());

  turnOffFilterBtn.addEventListener("click", () => toggleFilter(false));

  // Clicking the overlay dismisses a plain enlarge, but not while editing
  // (only Save/Cancel close the editor there).
  lightboxEl.addEventListener("click", (e) => {
    if (editingId) return;
    if (e.target === lightboxEl || e.target === lightboxImg || e.target.classList.contains("lightbox-image")) {
      closeLightbox();
    }
  });

  // Metadata editor.
  editorForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!editingId) return;
    const entry = entriesById.get(editingId);
    if (!entry) {
      closeEditor();
      return;
    }
    // The single start field is "YYYY-MM-DDTHH:MM"; split it back into the
    // separately-stored date (grouping key) and time (display-only) values.
    const { date, time } = splitStart(editorStart.value);
    const end = editorEndDate.value;
    const fields = {
      title: editorTitle.value,
      venue: editorVenue.value,
      dtinfo: editorDtinfo.value,
      url: editorUrl.value,
    };
    if (!entry.recurring) {
      fields.assignedDate = isDateString(date) ? date : null;
      fields.assignedTime = isTimeString(time) ? time : null;
      // Only keep an end date that's a real date after the start; anything else
      // (blank, or on/before the start) means single-day.
      fields.assignedEndDate =
        isDateString(end) && isDateString(date) && end > date ? end : null;
    }
    closeEditor();
    syncEntry(entry, fields);
  });
  editorCancel.addEventListener("click", cancelEditor);
  // Keep the end date from preceding the start as the start is edited.
  editorStart.addEventListener("change", () => {
    editorEndDate.min = splitStart(editorStart.value).date || "";
  });

  document.addEventListener("keydown", onKeydown);

  // Swallow image drops that miss a date group so the panel never navigates
  // away to the dropped image's URL. Valid drops are handled by the group's own
  // listener (which runs first, in the target phase) before this fires.
  document.addEventListener("dragover", (e) => {
    if (!draggingActive && isImageDrag(e.dataTransfer)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!draggingActive && isImageDrag(e.dataTransfer)) e.preventDefault();
  });
}

function onKeydown(e) {
  // Escape closes the editor even while an input is focused.
  if (e.key === "Escape" && editingId) {
    cancelEditor();
    return;
  }

  // Otherwise don't hijack typing in form fields.
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "c" && selectedId) {
    clipboardId = selectedId;
    showHint("Copied. Click a date group and press Ctrl/Cmd+V to move it there.");
  } else if (mod && e.key.toLowerCase() === "v" && clipboardId) {
    if (focusedDate && focusedDate !== "unknown") {
      moveEntry(clipboardId, focusedDate);
    } else {
      showHint("Click a date group first to choose where to paste.");
    }
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    const entry = entriesById.get(selectedId);
    if (entry) confirmDelete(entry);
  } else if (e.key === "Escape") {
    closeLightbox();
    clipboardId = null;
    selectedId = null;
    focusedDate = null;
    hintEl.hidden = true;
    for (const el of catalogEl.querySelectorAll(".selected, .focused")) {
      el.classList.remove("selected", "focused");
    }
  }
}

// --- Writing to Pawb / holding locally ---------------------------------------

// The single entry point for saving any field change (editor save, drag-move,
// retry). A Pawb-backed entry writes straight through; a local entry that has
// become valid (title + venue) is created on Pawb immediately and dropped
// from local storage; otherwise it just stays local, updated in place.
async function syncEntry(entry, fields) {
  if (entry.wpId) {
    await updateRemoteEntry(entry, fields);
  } else {
    const merged = { ...entry, ...fields };
    if (isUploadable(merged)) {
      try {
        await createRemoteEntry(merged);
        await removeLocalEntry(entry.id);
        await refreshPawbTabs();
      } catch (err) {
        console.warn("create on Pawb failed, keeping locally", err);
        await patchLocalEntry(entry.id, normalizeBlanks(fields));
        showStatus("Couldn't reach Pawb — kept locally, will retry.");
      }
    } else {
      await patchLocalEntry(entry.id, normalizeBlanks(fields));
    }
  }
  await render();
}

// Blank strings -> null, same normalization the server used to apply.
function normalizeBlanks(fields) {
  const patch = {};
  for (const [k, v] of Object.entries(fields)) {
    patch[k] = typeof v === "string" && v.trim() === "" ? null : v;
  }
  return patch;
}

// POST /events/<id> — update an existing Pawb event's editable fields.
async function updateRemoteEntry(entry, fields) {
  try {
    const body = new URLSearchParams();
    if ("title" in fields) body.set("title", fields.title || "");
    if ("venue" in fields) body.set("venue", fields.venue || "");
    if ("dtinfo" in fields) body.set("dtinfo", fields.dtinfo || "");
    if ("url" in fields) body.set("bookinglink", fields.url || "");
    if ("assignedDate" in fields || "assignedTime" in fields) {
      const date = fields.assignedDate ?? eventDateKey(entry);
      const time = fields.assignedTime ?? eventTimeKey(entry);
      body.set("dtstart", time ? `${date} ${time}` : date);
    }
    if ("assignedEndDate" in fields) {
      body.set("dtend", fields.assignedEndDate || "");
    }
    const res = await pawbFetch(`/events/${entry.wpId}`, { method: "POST", body });
    if (res.status === 404) {
      // Someone else already deleted it — nothing to save, just say so; the
      // next refresh will naturally drop it from the list.
      showStatus("This poster was removed elsewhere.");
      return;
    }
    if (!res.ok) throw new Error(`Pawb responded ${res.status}`);
    await refreshPawbTabs();
  } catch (err) {
    console.warn("update failed", err);
    showStatus("Couldn't save to Pawb — try again.");
  }
}

// POST /events — create a brand-new Pawb event with the poster image.
async function createRemoteEntry(entry) {
  const src = imageSrc(entry);
  if (!src) throw new Error("no image to upload");
  const imgRes = await fetch(src);
  if (!imgRes.ok) throw new Error(`image fetch responded ${imgRes.status}`);
  const blob = await imgRes.blob();

  const form = new FormData();
  form.append("title", uploadTitle(entry));
  const start = uploadStart(entry);
  if (start) form.append("dtstart", start);
  const end = eventEndDateKey(entry);
  if (end) form.append("dtend", end);
  const venue = displayVenue(entry);
  if (venue) form.append("venue", venue);
  // Free-text date/time note (user-entered only; no scraped fallback).
  const dtinfo = (entry.dtinfo || "").trim();
  if (dtinfo) form.append("dtinfo", dtinfo);
  // Send the event's URL (user override, else the captured page URL) as the
  // booking / more-info link when there is one.
  const link = displayUrl(entry);
  if (link) form.append("bookinglink", link);
  const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  form.append("picture", blob, `${entry.id}.${ext}`);

  const res = await pawbFetch("/events", { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`create responded ${res.status} ${detail.slice(0, 200)}`);
  }
  return await res.json();
}

// The event's title for creation; falls back to the caption, then a
// placeholder, since Pawb requires a title.
function uploadTitle(entry) {
  return (
    displayTitle(entry) ||
    (entry.caption && entry.caption.trim().slice(0, 100)) ||
    "Untitled event"
  );
}

// "YYYY-MM-DD" (plus " HH:MM" when a start time is known), using the date the
// poster is filed under. "" for undated ("unknown") events — Pawb then
// defaults them to today.
function uploadStart(entry) {
  const key = dateKey(entry);
  if (key === "unknown") return "";
  const time = eventTimeKey(entry);
  return time ? `${key} ${time}` : key;
}

async function moveEntry(id, date) {
  const entry = entriesById.get(id);
  if (!entry) return;
  focusedDate = date;
  openMonthFor(date);
  await syncEntry(entry, { assignedDate: date });
}

// Retry creating a local entry on Pawb (e.g. after a create failed offline).
async function retrySync(entry) {
  await syncEntry(entry, {});
}

function confirmDelete(entry) {
  // Likely-duplicates are expected to be culled on sight, so skip the prompt
  // for them; everything else confirms before removal.
  if (entry.duplicateOf) {
    deleteEntry(entry.id);
    return;
  }
  const label = displayTitle(entry) || (entry.caption && entry.caption.trim().slice(0, 60)) || "this poster";
  if (window.confirm(`Delete "${label}"?\nThis removes it from the catalog.`)) {
    deleteEntry(entry.id);
  }
}

async function deleteEntry(id) {
  const entry = entriesById.get(id);
  if (entry?.wpId) {
    try {
      const res = await pawbFetch(`/events/${entry.wpId}`, { method: "DELETE" });
      // 404 is fine — someone else already removed it.
      if (!res.ok && res.status !== 404) throw new Error(`Pawb responded ${res.status}`);
      await refreshPawbTabs();
    } catch (err) {
      console.warn("delete failed", err);
      showStatus("Couldn't reach Pawb — try again.");
      return; // don't hide it locally; it's still live on Pawb
    }
  } else {
    await removeLocalEntry(id);
  }
  closeEditor(); // also hides the lightbox / clears edit state
  if (selectedId === id) selectedId = null;
  if (clipboardId === id) clipboardId = null;
  await render();
}

async function addDate(date) {
  await addLocalDate(date);
  openMonthFor(date);
  await render();
}

async function removeDate(date) {
  await removeLocalDate(date);
  if (focusedDate === date) focusedDate = null;
  await render();
}

// A poster can only go to Pawb once it has both a title and a venue (the
// effective values, falling back to scraped data). Incomplete ones stay
// local, flagged red on their state indicator.
function isUploadable(entry) {
  return Boolean(displayTitle(entry).trim() && displayVenue(entry).trim());
}

// Open every currently-rendered month section (and remember it, so the state
// survives the next re-render).
function expandAllMonths() {
  for (const el of catalogEl.querySelectorAll(".month")) {
    el.classList.remove("collapsed");
    monthState.set(el.dataset.month, true);
  }
}

// Reload any browser tab currently showing the events listing (the /pawb
// section of gigiau.uk) so a freshly created/edited/deleted poster appears.
// Best-effort: relies on the site's host permission for tab URLs; failures
// are non-fatal.
async function refreshPawbTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://gigiau.uk/*" });
    for (const tab of tabs) {
      let path;
      try {
        path = new URL(tab.url).pathname.replace(/\/+$/, "");
      } catch {
        continue;
      }
      if (path === "/pawb" || path.startsWith("/pawb/")) {
        await chrome.tabs.reload(tab.id);
      }
    }
  } catch (err) {
    console.warn("could not refresh the gigiau.uk tab(s):", err);
  }
}

// --- Local-storage fallbacks ---------------------------------------------

async function patchLocalEntry(id, patch) {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const entry = local.find((e) => e.id === id);
  if (entry) {
    Object.assign(entry, patch);
    await chrome.storage.local.set({ [STORAGE_KEY]: local });
  }
}

async function removeLocalEntry(id) {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const next = local.filter((e) => e.id !== id);
  if (next.length !== local.length) {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  }
}

async function storeLocalCapture(entry) {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  local.unshift(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: local });
}

async function addLocalDate(date) {
  const { [CREATED_DATES_KEY]: local = [] } = await chrome.storage.local.get(
    CREATED_DATES_KEY
  );
  if (!local.includes(date)) {
    await chrome.storage.local.set({ [CREATED_DATES_KEY]: [...local, date] });
  }
}

async function removeLocalDate(date) {
  const { [CREATED_DATES_KEY]: local = [] } = await chrome.storage.local.get(
    CREATED_DATES_KEY
  );
  await chrome.storage.local.set({
    [CREATED_DATES_KEY]: local.filter((d) => d !== date),
  });
}

// --- Prune stale local items ----------------------------------------------

// Today as a local YYYY-MM-DD (matches how users think about "out of date",
// and comparable against the string date keys).
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Drop stale LOCAL (not-yet-on-Pawb) items whose event date has passed, and
// any now-stale empty user-created dates. Runs once when the panel opens.
// Never touches Pawb itself: a Pawb-backed event simply stops appearing in
// GET /events once its own end date passes (server-side date filtering), so
// there's nothing to delete for those.
async function pruneOutdated() {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const today = todayKey();

  const outdated = local.filter((e) => {
    // Judge by the end date for multi-day events, else the start date, so an
    // event still running today isn't removed. "unknown" has no date to judge.
    const key = eventEndDateKey(e) || dateKey(e);
    return key !== "unknown" && key < today;
  });
  for (const entry of outdated) await removeLocalEntry(entry.id);

  const { [CREATED_DATES_KEY]: createdDates = [] } = await chrome.storage.local.get(
    CREATED_DATES_KEY
  );
  if (!createdDates.length) return;

  // A created date might still hold a live Pawb event, so check against the
  // full merged list, not just what's left locally.
  const captures = await loadCaptures();
  const liveKeys = new Set(captures.map(dateKey));
  for (const date of createdDates) {
    if (date < today && !liveKeys.has(date)) await removeLocalDate(date);
  }
}

// --- Capture by drop -----------------------------------------------------

// Turn an image dropped onto a date group into a local capture pinned to
// that date (no title, so it's always held locally until edited).
async function addDroppedImage(dataTransfer, date) {
  try {
    const imageDataUrl = await readDroppedImage(dataTransfer);
    if (!imageDataUrl) {
      showStatus("Couldn't read an image from that drop.");
      return;
    }
    await saveDroppedCapture(imageDataUrl, date);
  } catch (err) {
    showStatus(`Drop failed: ${err.message || err}`);
  }
}

// Resolve a drop into an image data URL: a dropped file directly, or the bytes
// of an image dragged from a page (fetched here — the panel is an extension
// page with host permissions for every origin, so it isn't CORS-blocked).
async function readDroppedImage(dataTransfer) {
  const file = [...(dataTransfer.files || [])].find((f) =>
    f.type.startsWith("image/")
  );
  if (file) return await blobToDataUrl(file);

  const url = imageUrlFromDrag(dataTransfer);
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image fetch responded ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) throw new Error("that link wasn't an image");
    return await blobToDataUrl(blob);
  }
  return null;
}

// Pull an image URL out of a page drag (uri-list, then an <img> in the HTML
// fragment, then a bare URL in plain text).
function imageUrlFromDrag(dt) {
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const first = uriList
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (first) return first;
  }
  const html = dt.getData("text/html");
  if (html) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    if (m) return m[1];
  }
  const plain = dt.getData("text/plain");
  if (plain && /^https?:\/\//i.test(plain.trim())) return plain.trim();
  return null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("could not read image"));
    reader.readAsDataURL(blob);
  });
}

async function saveDroppedCapture(imageDataUrl, date) {
  const entry = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    assignedDate: date,
    imageDataUrl,
  };
  await storeLocalCapture(entry);
  focusedDate = date;
  openMonthFor(date);
  await render();
}

// --- Helpers ---------------------------------------------------------------

function imageSrc(entry) {
  // entry.imageSrc is Pawb's own media URL for a synced entry.
  return entry.imageSrc || entry.imageDataUrl || entry.imageUrl || "";
}

function showStatus(text) {
  statusEl.textContent = text;
  statusEl.hidden = false;
  setTimeout(() => {
    statusEl.hidden = true;
  }, 6000);
}

function showHint(text) {
  hintEl.textContent = text;
  hintEl.hidden = false;
}
