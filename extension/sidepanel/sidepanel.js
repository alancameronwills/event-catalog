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
const editorUrl = document.getElementById("editor-url");
const editorCancel = document.getElementById("editor-cancel");

// Interaction state.
let selectedId = null; // highlighted item
let clipboardId = null; // item picked up with Ctrl/Cmd+C
let focusedDate = null; // group targeted for paste
let draggingActive = false;
let entriesById = new Map(); // id -> entry, refreshed each render
let editingId = null; // poster whose metadata is open in the editor

document.addEventListener("DOMContentLoaded", () => {
  render();
  wireControls();
});

// Re-render when a capture is added, and surface status messages.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CAPTURE_ADDED") {
    // Open the editor immediately on a fresh capture so details can be added
    // while the poster is in view.
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

  for (const group of catalogEl.querySelectorAll(".date-group")) group.remove();

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

  for (const key of sortedKeys(groups.keys())) {
    catalogEl.appendChild(renderGroup(key, groups.get(key), createdSet));
  }
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

// Valid dates newest first; "unknown" always last.
function sortedKeys(keys) {
  return [...keys].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return a < b ? 1 : a > b ? -1 : 0;
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
    if (!draggingActive) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    section.classList.add("drop-target");
  });
  section.addEventListener("dragleave", (e) => {
    if (!section.contains(e.relatedTarget)) section.classList.remove("drop-target");
  });
  section.addEventListener("drop", (e) => {
    e.preventDefault();
    section.classList.remove("drop-target");
    const id = e.dataTransfer.getData("text/plain");
    if (id) moveEntry(id, key);
  });
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
  return (
    [displayTitle(entry), displayVenue(entry)].filter(Boolean).join(" — ") ||
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

// Edit mode: show the poster above, dock the form below; both close on
// save/cancel.
function openEditor(entry) {
  editingId = entry.id;
  editorTitle.value = displayTitle(entry);
  editorVenue.value = displayVenue(entry);
  editorDate.value = eventDateKey(entry);
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
    saveMetadata(id, {
      title: editorTitle.value,
      venue: editorVenue.value,
      url: editorUrl.value,
      assignedDate: isDateString(date) ? date : null,
    });
    closeEditor();
  });
  editorCancel.addEventListener("click", closeEditor);

  document.addEventListener("keydown", onKeydown);
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
