// Lambda handler for the shared Event Poster Catalog API, invoked via a
// Function URL (see template.yaml) — no API Gateway in front of it. CORS and
// the OPTIONS preflight are handled automatically by the Function URL's Cors
// config, so this only needs to answer the real methods.
//
//   GET    /health
//   GET    /captures
//   POST   /captures
//   PATCH  /captures/:id
//   DELETE /captures/:id
//   GET    /dates
//   POST   /dates
//   DELETE /dates/:date
//   GET    /venues
//
// Auth: every request must carry the shared secret as an X-Api-Token header
// (checked against API_TOKEN). This is the only access control — there's no
// per-user identity, just one token every installed extension shares.

import { config } from "./config.mjs";
import {
  readIndex,
  addCapture,
  updateCapture,
  deleteCapture,
  readDates,
  addDate,
  removeDate,
  readVenues,
  isDateString,
  isTimeString,
} from "./store.mjs";

export async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || "GET";
    const path = event.rawPath || "/";

    if (method === "GET" && path === "/health") return json(200, { ok: true });

    if (!authorized(event)) return json(401, { error: "missing or invalid X-Api-Token" });

    if (method === "GET" && path === "/captures") return json(200, await readIndex());
    if (method === "POST" && path === "/captures") return handleCreate(event);
    if (method === "GET" && path === "/dates") return json(200, await readDates());
    if (method === "GET" && path === "/venues") return json(200, await readVenues());
    if (method === "POST" && path === "/dates") return handleAddDate(event);

    if (method === "PATCH" && path.startsWith("/captures/")) {
      return handleUpdate(event, decodeURIComponent(path.slice("/captures/".length)));
    }
    if (method === "DELETE" && path.startsWith("/captures/")) {
      return handleDelete(decodeURIComponent(path.slice("/captures/".length)));
    }
    if (method === "DELETE" && path.startsWith("/dates/")) {
      return handleDeleteDate(decodeURIComponent(path.slice("/dates/".length)));
    }

    return json(404, { error: "not found" });
  } catch (err) {
    console.error("request error:", err);
    return json(500, { error: String(err.message || err) });
  }
}

function authorized(event) {
  const header = event.headers?.["x-api-token"];
  return Boolean(config.apiToken) && header === config.apiToken;
}

function body(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

async function handleCreate(event) {
  let capture;
  try {
    capture = JSON.parse(body(event));
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!capture || typeof capture !== "object") return json(400, { error: "expected a capture object" });
  const entry = await addCapture(capture);
  console.log(`captured ${entry.id} -> ${entry.imageFile || "(no image)"}`);
  return json(201, entry);
}

async function handleUpdate(event, id) {
  let patch;
  try {
    patch = JSON.parse(body(event));
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if ("assignedDate" in patch && patch.assignedDate !== null && !isDateString(patch.assignedDate)) {
    return json(400, { error: "assignedDate must be YYYY-MM-DD or null" });
  }
  if ("assignedTime" in patch && patch.assignedTime !== null && !isTimeString(patch.assignedTime)) {
    return json(400, { error: "assignedTime must be HH:MM or null" });
  }
  if ("assignedEndDate" in patch && patch.assignedEndDate !== null && !isDateString(patch.assignedEndDate)) {
    return json(400, { error: "assignedEndDate must be YYYY-MM-DD or null" });
  }
  if ("uploadState" in patch && patch.uploadState !== null && !["initial", "omit", "uploaded"].includes(patch.uploadState)) {
    return json(400, { error: "uploadState must be initial, omit, uploaded, or null" });
  }
  const updated = await updateCapture(id, patch);
  if (!updated) return json(404, { error: "not found" });
  return json(200, updated);
}

async function handleDelete(id) {
  const removed = await deleteCapture(id);
  if (!removed) return json(404, { error: "not found" });
  return json(200, { deleted: id });
}

async function handleAddDate(event) {
  let payload;
  try {
    payload = JSON.parse(body(event));
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!isDateString(payload?.date)) return json(400, { error: "date must be YYYY-MM-DD" });
  await addDate(payload.date);
  return json(201, { date: payload.date });
}

async function handleDeleteDate(date) {
  await removeDate(date);
  return json(200, { deleted: date });
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}
