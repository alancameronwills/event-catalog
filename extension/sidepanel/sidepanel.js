// Side panel: renders the catalog grouped by date.
//
// Items are grouped by a stable YYYY-MM-DD key. Users can create empty dates
// and move items between dates by dragging, or by copy/paste (select an item,
// Ctrl/Cmd+C, focus a date group, Ctrl/Cmd+V). Moving reassigns the item's
// date on the server (which also relocates the image file on disk).

const STORAGE_KEY = "captures";
const CREATED_DATES_KEY = "createdDates";
const SERVER_URL = "http://127.0.0.1:3777";

const catalogEl = document.getElementById("catalog");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const addDateBtn = document.getElementById("add-date-btn");
const addDateForm = document.getElementById("add-date-form");
const addDateInput = document.getElementById("add-date-input");
const addDateCancel = document.getElementById("add-date-cancel");
const lightboxEl = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const editorForm = document.getElementById("editor-form");
const editorDupWarning = document.getElementById("editor-dup-warning");
const editorTitle = document.getElementById("editor-title");
const editorVenue = document.getElementById("editor-venue");
const editorDate = document.getElementById("editor-date");
const editorTime = document.getElementById("editor-time");
const editorUrl = document.getElementById("editor-url");
const editorCancel = document.getElementById("editor-cancel");

// Interaction state.
let selectedId = null; // highlighted item
let clipboardId = null; // item picked up with Ctrl/Cmd+C
let focusedDate = null; // group targeted for paste
let draggingActive = false;
let entriesById = new Map(); // id -> entry, refreshed each render
let editingId = null; // poster whose metadata is open in the editor
const monthState = new Map(); // "YYYY-MM"|"unknown" -> open? (persists re-renders)

document.addEventListener("DOMContentLoaded", async () => {
  // Opening the catalog is the moment to clear out events that have already
  // passed (see pruneOutdated); then draw what's left.
  await pruneOutdated();
  render();
  wireControls();
});

// Re-render when a capture is added, and surface status messages.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_ADDED") {
    // Open the editor immediately on a fresh capture so details can be added
    // while the poster is in view. Make sure its month is expanded first.
    if (message.entry) openMonthFor(dateKey(message.entry));
    render().then(() => {
      if (message.entry) openEditor(message.entry);
    });
  } else if (message.type === "CAPTURE_ERROR") {
    showStatus(`Capture failed: ${message.message}`);
  } else if (message.type === "SERVER_OFFLINE") {
    showStatus(message.message);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[CREATED_DATES_KEY])) {
    render();
  }
});

// --- Data loading --------------------------------------------------------

// The server is the source of truth; fall back to local storage when offline.
async function loadCaptures() {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  try {
    const res = await fetch(`${SERVER_URL}/captures`);
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const remote = await res.json();
    const remoteIds = new Set(remote.map((e) => e.id));
    const pending = local.filter((e) => e.pending && !remoteIds.has(e.id));
    return [...pending, ...remote];
  } catch {
    return local;
  }
}

async function loadCreatedDates() {
  const { [CREATED_DATES_KEY]: local = [] } = await chrome.storage.local.get(
    CREATED_DATES_KEY
  );
  try {
    const res = await fetch(`${SERVER_URL}/dates`);
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const remote = await res.json();
    return [...new Set([...remote, ...local])];
  } catch {
    return local;
  }
}

// --- Rendering -----------------------------------------------------------

async function render() {
  const [captures, createdDates] = await Promise.all([
    loadCaptures(),
    loadCreatedDates(),
  ]);

  entriesById = new Map(captures.map((e) => [e.id, e]));

  countEl.textContent = captures.length
    ? `${captures.length} ${captures.length === 1 ? "capture" : "captures"}`
    : "";

  // Drop previously-rendered content (top-level month sections and the
  // always-visible "unknown" group).
  for (const el of catalogEl.querySelectorAll(":scope > .month, :scope > .date-group")) {
    el.remove();
  }

  // Group items by stable date key, then ensure created (possibly empty) dates
  // each have a group.
  const groups = new Map();
  for (const entry of captures) {
    const key = dateKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const createdSet = new Set(createdDates);
  for (const date of createdDates) {
    if (!groups.has(date)) groups.set(date, []);
  }

  if (groups.size === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

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

// --- Month grouping ------------------------------------------------------

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
// "unknown". Mirrors effectiveDate() on the server.
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
  img.alt = entry.event?.name || "Event poster";
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
    deleteEntry(entry.id); // explicit button click — no confirm needed
  });
  fig.appendChild(del);

  if (entry.duplicateOf) {
    const badge = document.createElement("span");
    badge.className = "dup-badge";
    badge.textContent = "dup?";
    badge.title =
      entry.duplicateDistance != null
        ? `Possible duplicate of an existing poster (similarity distance ${entry.duplicateDistance})`
        : "Possible duplicate of an existing poster";
    fig.appendChild(badge);
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

// --- Interactions --------------------------------------------------------

function selectThumb(id) {
  selectedId = id;
  for (const el of catalogEl.querySelectorAll(".thumb.selected")) {
    el.classList.remove("selected");
  }
  const fig = catalogEl.querySelector(`.thumb[data-id="${CSS.escape(id)}"]`);
  if (fig) fig.classList.add("selected");
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

// --- Metadata editor -----------------------------------------------------

// Effective values fall back to scraped data so the editor shows useful
// defaults and tooltips read naturally.
function displayTitle(entry) {
  return entry.title || entry.event?.name || "";
}
function displayVenue(entry) {
  return entry.venue || entry.event?.venue || "";
}
function displayUrl(entry) {
  return entry.url || entry.pageUrl || "";
}

function thumbTooltip(entry) {
  const time = formatTime(eventTimeKey(entry));
  const head = [displayTitle(entry), displayVenue(entry)].filter(Boolean).join(" — ");
  return (
    [head, time].filter(Boolean).join(" · ") ||
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

// Edit mode: show the poster above, dock the form below; both close on
// save/cancel.
function openEditor(entry) {
  editingId = entry.id;
  editorTitle.value = displayTitle(entry);
  editorVenue.value = displayVenue(entry);
  editorDate.value = eventDateKey(entry);
  editorTime.value = eventTimeKey(entry);
  editorUrl.value = displayUrl(entry);
  showDuplicateWarning(entry);

  lightboxImg.src = imageSrc(entry);
  editorForm.hidden = false;
  lightboxEl.classList.add("editing");
  lightboxEl.hidden = false;
  editorTitle.focus();
}

// If this poster was flagged as a likely duplicate, warn with the title (if
// any) and date of the matched (first-found) poster.
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
}

async function saveMetadata(id, fields) {
  try {
    const res = await fetch(`${SERVER_URL}/captures/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
  } catch {
    // Offline: normalize the way the server would (blanks -> null).
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      patch[k] = typeof v === "string" && v.trim() === "" ? null : v;
    }
    await patchLocalEntry(id, patch);
    showStatus("Server offline — details saved locally.");
  }
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

function wireControls() {
  addDateBtn.addEventListener("click", () => {
    addDateForm.hidden = false;
    if (!addDateInput.value) addDateInput.value = new Date().toISOString().slice(0, 10);
    addDateInput.focus();
  });
  addDateCancel.addEventListener("click", () => {
    addDateForm.hidden = true;
  });
  addDateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (isDateString(addDateInput.value)) {
      addDate(addDateInput.value);
      addDateForm.hidden = true;
    }
  });

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
    const id = editingId;
    const date = editorDate.value;
    const time = editorTime.value;
    saveMetadata(id, {
      title: editorTitle.value,
      venue: editorVenue.value,
      url: editorUrl.value,
      assignedDate: isDateString(date) ? date : null,
      assignedTime: isTimeString(time) ? time : null,
    });
    closeEditor();
  });
  editorCancel.addEventListener("click", closeEditor);

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
    closeEditor();
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

// --- Mutations -----------------------------------------------------------

async function moveEntry(id, date) {
  try {
    const res = await fetch(`${SERVER_URL}/captures/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedDate: date }),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
  } catch {
    await patchLocalEntry(id, { assignedDate: date });
    showStatus("Server offline — move saved locally.");
  }
  focusedDate = date;
  openMonthFor(date);
  await render();
}

function confirmDelete(entry) {
  const label =
    entry.event?.name ||
    (entry.caption && entry.caption.trim().slice(0, 60)) ||
    "this poster";
  if (window.confirm(`Delete "${label}"?\nThis removes it from the catalog.`)) {
    deleteEntry(entry.id);
  }
}

async function deleteEntry(id) {
  try {
    const res = await fetch(`${SERVER_URL}/captures/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    // 404 is fine — it may have only existed locally (pending capture).
    if (!res.ok && res.status !== 404) throw new Error(`server responded ${res.status}`);
  } catch {
    showStatus("Server offline — removed locally.");
  }
  await removeLocalEntry(id);
  closeEditor(); // also hides the lightbox / clears edit state
  if (selectedId === id) selectedId = null;
  if (clipboardId === id) clipboardId = null;
  await render();
}

async function addDate(date) {
  try {
    const res = await fetch(`${SERVER_URL}/dates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
  } catch {
    await addLocalDate(date);
    showStatus("Server offline — date saved locally.");
  }
  openMonthFor(date);
  await render();
}

async function removeDate(date) {
  try {
    const res = await fetch(`${SERVER_URL}/dates/${encodeURIComponent(date)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
  } catch {
    // fall through to local removal below
  }
  await removeLocalDate(date);
  if (focusedDate === date) focusedDate = null;
  await render();
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

// --- Prune past events ---------------------------------------------------

// Today as a local YYYY-MM-DD (matches how users think about "out of date",
// and comparable against the string date keys).
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Permanently delete captures whose effective date is before today, and drop
// any now-stale empty user-created dates. Runs once when the panel opens.
async function pruneOutdated() {
  const [captures, createdDates] = await Promise.all([
    loadCaptures(),
    loadCreatedDates(),
  ]);
  const today = todayKey();

  const outdated = captures.filter((e) => {
    const key = dateKey(e);
    return key !== "unknown" && key < today; // "unknown" has no date to judge
  });
  for (const entry of outdated) await purgeCapture(entry.id);

  // Remove empty created dates in the past; keep any that still hold a poster
  // (those posters were just deleted above, so recompute what survives).
  const removedIds = new Set(outdated.map((e) => e.id));
  const liveKeys = new Set(
    captures.filter((e) => !removedIds.has(e.id)).map(dateKey)
  );
  for (const date of createdDates) {
    if (date < today && !liveKeys.has(date)) await purgeDate(date);
  }
}

// Delete a capture from the server and local storage without touching the UI
// (prune runs before the first render).
async function purgeCapture(id) {
  try {
    const res = await fetch(`${SERVER_URL}/captures/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) throw new Error(`server responded ${res.status}`);
  } catch {
    // Offline (or already gone): still drop the local copy below.
  }
  await removeLocalEntry(id);
}

async function purgeDate(date) {
  try {
    await fetch(`${SERVER_URL}/dates/${encodeURIComponent(date)}`, { method: "DELETE" });
  } catch {
    // Offline: local removal below still applies.
  }
  await removeLocalDate(date);
}

// --- Capture by drop -----------------------------------------------------

// Turn an image dropped onto a date group into a capture pinned to that date.
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
// page with host permissions for Facebook/fbcdn, so it isn't CORS-blocked).
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

// POST a dropped capture with its date already pinned (assignedDate), so the
// server skips date parsing and files it under this date.
async function saveDroppedCapture(imageDataUrl, date) {
  const entry = {
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    assignedDate: date,
    imageDataUrl,
  };
  try {
    const res = await fetch(`${SERVER_URL}/captures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error(`server responded ${res.status}`);
  } catch {
    // Offline: keep it locally so nothing is lost (mirrors background.js).
    await storeLocalCapture({ ...entry, pending: true });
    showStatus("Server offline — poster saved locally.");
  }
  focusedDate = date;
  openMonthFor(date);
  await render();
}

async function storeLocalCapture(entry) {
  const { [STORAGE_KEY]: local = [] } = await chrome.storage.local.get(STORAGE_KEY);
  local.unshift(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: local });
}

// --- Helpers -------------------------------------------------------------

function imageSrc(entry) {
  if (entry.imageFile) return `${SERVER_URL}/images/${entry.imageFile}`;
  return entry.imageDataUrl || entry.imageUrl || "";
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
