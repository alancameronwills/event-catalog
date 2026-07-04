// Local HTTP server for the Event Poster Catalog.
//
// Zero-dependency (Node built-ins only). Receives captures from the browser
// extension, stores images on disk, and serves the index + images back for the
// side-panel UI.
//
//   POST   /captures        { imageDataUrl, caption, event, pageUrl, ... }
//   GET    /captures        -> index array (newest first)
//   DELETE /captures/:id    -> remove a capture and its image
//   GET    /images/<path>   -> stored image bytes
//   GET    /health          -> { ok: true }

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config, paths } from "./config.js";
import {
  init,
  readIndex,
  addCapture,
  updateCapture,
  deleteCapture,
  readDates,
  addDate,
  removeDate,
  readVenues,
  backfillHashes,
  backfillImages,
  backfillVenues,
  isDateString,
  isTimeString,
} from "./store.js";

const IMAGE_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === "OPTIONS") return end(res, 204);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") return sendJson(res, 200, { ok: true });
    if (route === "GET /captures") return sendJson(res, 200, await readIndex());
    if (route === "POST /captures") return await handleCreate(req, res);
    if (route === "GET /dates") return sendJson(res, 200, await readDates());
    if (route === "GET /venues") return sendJson(res, 200, await readVenues());
    if (route === "POST /dates") return await handleAddDate(req, res);
    if (route === "POST /backfill-images") return sendJson(res, 200, await backfillImages());

    if (req.method === "PATCH" && url.pathname.startsWith("/captures/")) {
      return await handleUpdate(req, res, decodeURIComponent(url.pathname.slice("/captures/".length)));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/captures/")) {
      return await handleDelete(res, decodeURIComponent(url.pathname.slice("/captures/".length)));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/dates/")) {
      return await handleDeleteDate(res, decodeURIComponent(url.pathname.slice("/dates/".length)));
    }
    if (req.method === "GET" && url.pathname.startsWith("/images/")) {
      return await handleImage(res, url.pathname.slice("/images/".length));
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
  }
});

async function handleCreate(req, res) {
  const body = await readBody(req);
  let capture;
  try {
    capture = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if (!capture || typeof capture !== "object") {
    return sendJson(res, 400, { error: "expected a capture object" });
  }
  const entry = await addCapture(capture);
  const { imageBytes, ...clean } = entry; // don't echo internal byte count
  console.log(`captured ${entry.id} -> ${entry.imageFile || "(no image)"}`);
  return sendJson(res, 201, clean);
}

async function handleUpdate(req, res, id) {
  const body = await readBody(req);
  let patch;
  try {
    patch = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if ("assignedDate" in patch && patch.assignedDate !== null && !isDateString(patch.assignedDate)) {
    return sendJson(res, 400, { error: "assignedDate must be YYYY-MM-DD or null" });
  }
  if ("assignedTime" in patch && patch.assignedTime !== null && !isTimeString(patch.assignedTime)) {
    return sendJson(res, 400, { error: "assignedTime must be HH:MM or null" });
  }
  const updated = await updateCapture(id, patch);
  if (!updated) return sendJson(res, 404, { error: "not found" });
  const { imageBytes, ...clean } = updated;
  return sendJson(res, 200, clean);
}

async function handleDelete(res, id) {
  const removed = await deleteCapture(id);
  if (!removed) return sendJson(res, 404, { error: "not found" });
  return sendJson(res, 200, { deleted: id });
}

async function handleAddDate(req, res) {
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }
  if (!isDateString(payload?.date)) {
    return sendJson(res, 400, { error: "date must be YYYY-MM-DD" });
  }
  await addDate(payload.date);
  return sendJson(res, 201, { date: payload.date });
}

async function handleDeleteDate(res, date) {
  await removeDate(date);
  return sendJson(res, 200, { deleted: date });
}

async function handleImage(res, relPath) {
  // Resolve within imagesDir and reject any path traversal.
  const target = path.resolve(paths.imagesDir, relPath);
  if (target !== paths.imagesDir && !target.startsWith(paths.imagesDir + path.sep)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "Content-Type": IMAGE_CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(target).pipe(res);
  } catch {
    sendJson(res, 404, { error: "image not found" });
  }
}

// --- helpers -------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function end(res, status) {
  res.writeHead(status);
  res.end();
}

await init();
server.listen(config.port, config.host, () => {
  console.log(`Event Catalog server listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  // Hash any pre-existing captures in the background so duplicate detection
  // works against the whole catalog. Non-blocking.
  backfillHashes()
    .then((n) => n && console.log(`backfilled perceptual hashes for ${n} capture(s)`))
    .catch((err) => console.warn("hash backfill failed:", err.message));
  // Seed the venue-suggestion registry from any venues already in the index.
  backfillVenues().catch((err) => console.warn("venue backfill failed:", err.message));
});
