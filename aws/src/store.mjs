// Persistence for the shared catalog: DynamoDB for the index/dates/venues,
// S3 for image bytes. Functional port of server/store.js's public API, with
// the on-disk JSON file + serialized-write model swapped for a table a Lambda
// can hit concurrently from multiple users.
//
// Every capture also gets a `gsi1pk = "CAPTURE"` attribute so the ByCapturedAt
// GSI (partition key gsi1pk, sort key capturedAt) can return "all captures,
// newest first" with one Query — see template.yaml.

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.mjs";
import { perceptualHash, hammingDistance } from "./hash.mjs";
import { extractText, parseEventDate, parseEventTime } from "./ocr.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function isDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isTimeString(value) {
  if (typeof value !== "string") return false;
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return !!m && +m[1] <= 23 && +m[2] <= 59;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  const data = match[3];
  const buffer = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");
  return { mime, buffer, ext: MIME_EXT[mime] || "bin" };
}

// The date an entry belongs to, as YYYY-MM-DD — same precedence as the local
// server: explicit assignedDate > structured event date > OCR date > capture
// date. Also used as the S3 key prefix.
function effectiveDate(entry) {
  if (isDateString(entry.assignedDate)) return entry.assignedDate;
  const structured = new Date(entry.event?.startDate);
  if (entry.event?.startDate && !Number.isNaN(structured.getTime())) {
    return structured.toISOString().slice(0, 10);
  }
  if (isDateString(entry.ocrDate)) return entry.ocrDate;
  const d = new Date(entry.capturedAt || Date.now());
  const day = Number.isNaN(d.getTime()) ? new Date() : d;
  return day.toISOString().slice(0, 10);
}

function imageSrc(imageKey) {
  if (!imageKey) return null;
  return `https://${config.imagesBucket}.s3.${config.region}.amazonaws.com/${imageKey}`;
}

// Strip internal-only fields before handing an entry back to a client.
function toPublic(entry) {
  if (!entry) return entry;
  const { gsi1pk, imageKey, ...rest } = entry;
  return { ...rest, imageFile: imageKey || null, imageSrc: imageSrc(imageKey) };
}

// --- Captures --------------------------------------------------------------

// All captures, newest first, via the ByCapturedAt GSI (paginated internally
// so callers always get the full catalog in one array, matching the local
// server's GET /captures contract).
export async function readIndex() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: config.capturesTable,
        IndexName: "ByCapturedAt",
        KeyConditionExpression: "gsi1pk = :p",
        ExpressionAttributeValues: { ":p": "CAPTURE" },
        ScanIndexForward: false, // newest first
        ExclusiveStartKey,
      })
    );
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map(toPublic);
}

// Closest existing entry within the duplicate threshold, or null. Compares
// against every capture that has a hash — cheap at personal-catalog scale.
async function findDuplicate(hash, excludeId) {
  if (!hash) return null;
  let best = null;
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: config.capturesTable,
        IndexName: "ByCapturedAt",
        KeyConditionExpression: "gsi1pk = :p",
        ExpressionAttributeValues: { ":p": "CAPTURE" },
        ProjectionExpression: "id, #h",
        ExpressionAttributeNames: { "#h": "hash" },
        ExclusiveStartKey,
      })
    );
    for (const other of res.Items || []) {
      if (other.id === excludeId || !other.hash) continue;
      const distance = hammingDistance(hash, other.hash);
      if (distance <= config.dupThreshold && (!best || distance < best.distance)) {
        best = { id: other.id, distance };
      }
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return best;
}

export async function addCapture(capture) {
  const id = capture.id || randomUUID();
  const capturedAt = capture.capturedAt || new Date().toISOString();

  const entry = {
    id,
    gsi1pk: "CAPTURE",
    capturedAt,
    assignedDate: isDateString(capture.assignedDate) ? capture.assignedDate : null,
    eventDate: capture.event?.startDate || null,
    imageKey: null,
    imageUrl: capture.imageUrl || null,
    caption: capture.caption || "",
    event: capture.event || null,
    pageUrl: capture.pageUrl || null,
    pageTitle: capture.pageTitle || null,
    title: null,
    venue: null,
    url: null,
    dtinfo: null,
    assignedTime: isTimeString(capture.assignedTime) ? capture.assignedTime : null,
    assignedEndDate: isDateString(capture.assignedEndDate) ? capture.assignedEndDate : null,
    hash: null,
    ocrText: null,
    ocrDate: null,
    ocrTime: null,
    duplicateOf: null,
    duplicateDistance: null,
    uploadState: null,
  };

  const decoded = parseDataUrl(capture.imageDataUrl);
  if (decoded) {
    entry.hash = await perceptualHash(decoded.buffer);

    const text = await extractText(decoded.buffer);
    if (text) {
      entry.ocrText = text.slice(0, 5000);
      entry.ocrTime = parseEventTime(text);
      if (!entry.assignedDate && !entry.event?.startDate) {
        entry.ocrDate = parseEventDate(text, capturedAt);
      }
    }

    const folder = effectiveDate(entry);
    const key = `${folder}/${id}.${decoded.ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: config.imagesBucket,
        Key: key,
        Body: decoded.buffer,
        ContentType: decoded.mime,
      })
    );
    entry.imageKey = key;
  }

  if (entry.hash) {
    const match = await findDuplicate(entry.hash, id);
    if (match) {
      entry.duplicateOf = match.id;
      entry.duplicateDistance = match.distance;
    }
  }

  await ddb.send(new PutCommand({ TableName: config.capturesTable, Item: entry }));
  await recordVenue(entry.event?.venue);

  return toPublic(entry);
}

export async function updateCapture(id, patch) {
  const existing = await ddb.send(new GetCommand({ TableName: config.capturesTable, Key: { id } }));
  const entry = existing.Item;
  if (!entry) return null;

  if ("assignedDate" in patch) {
    entry.assignedDate =
      patch.assignedDate === null || isDateString(patch.assignedDate) ? patch.assignedDate : entry.assignedDate;
    if (entry.imageKey) {
      entry.imageKey = await moveImage(entry.imageKey, effectiveDate(entry), id);
    }
  }

  const MAX = { title: 300, venue: 300, url: 2000, dtinfo: 500 };
  let venueToRecord = null;
  for (const field of ["title", "venue", "url", "dtinfo"]) {
    if (field in patch) {
      const value = patch[field];
      entry[field] = value == null || String(value).trim() === "" ? null : String(value).trim().slice(0, MAX[field]);
    }
  }
  if ("venue" in patch && entry.venue) venueToRecord = entry.venue;

  if ("assignedTime" in patch) {
    const t = patch.assignedTime;
    entry.assignedTime = t == null || String(t).trim() === "" ? null : isTimeString(t) ? t : entry.assignedTime;
  }

  if ("assignedEndDate" in patch) {
    const d = patch.assignedEndDate;
    entry.assignedEndDate = d == null || String(d).trim() === "" ? null : isDateString(d) ? d : entry.assignedEndDate;
  }

  if ("uploadState" in patch) {
    const s = patch.uploadState;
    entry.uploadState = s === "omit" || s === "uploaded" ? s : null;
  }

  await ddb.send(new PutCommand({ TableName: config.capturesTable, Item: entry }));
  if (venueToRecord) await recordVenue(venueToRecord);
  return toPublic(entry);
}

export async function deleteCapture(id) {
  const existing = await ddb.send(new GetCommand({ TableName: config.capturesTable, Key: { id } }));
  if (!existing.Item) return null;
  await ddb.send(new DeleteCommand({ TableName: config.capturesTable, Key: { id } }));
  if (existing.Item.imageKey) {
    await s3.send(new DeleteObjectCommand({ Bucket: config.imagesBucket, Key: existing.Item.imageKey })).catch(() => {});
  }
  return toPublic(existing.Item);
}

// Move an S3 object into <newFolder>/, returning the new key. Best-effort: on
// any failure the original key is kept.
async function moveImage(key, newFolder, id) {
  const currentFolder = key.slice(0, key.lastIndexOf("/"));
  if (currentFolder === newFolder) return key;
  const ext = key.slice(key.lastIndexOf("."));
  const newKey = `${newFolder}/${id}${ext}`;
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: config.imagesBucket,
        CopySource: `/${config.imagesBucket}/${key}`,
        Key: newKey,
      })
    );
    await s3.send(new DeleteObjectCommand({ Bucket: config.imagesBucket, Key: key }));
    return newKey;
  } catch (err) {
    console.warn(`could not move image ${key} -> ${newKey}:`, err.message);
    return key;
  }
}

// --- User-created dates ------------------------------------------------

export async function readDates() {
  const res = await ddb.send(new ScanCommand({ TableName: config.datesTable }));
  return (res.Items || []).map((i) => i.date).filter(isDateString).sort();
}

export async function addDate(date) {
  if (!isDateString(date)) return null;
  await ddb.send(new PutCommand({ TableName: config.datesTable, Item: { date, createdAt: new Date().toISOString() } }));
  return date;
}

export async function removeDate(date) {
  await ddb.send(new DeleteCommand({ TableName: config.datesTable, Key: { date } }));
  return date;
}

// --- Venue suggestions ---------------------------------------------------

export async function readVenues() {
  const res = await ddb.send(new ScanCommand({ TableName: config.venuesTable }));
  return (res.Items || [])
    .map((i) => i.name)
    .filter(Boolean)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

async function recordVenue(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return;
  const nameLower = trimmed.toLowerCase();
  // First-seen spelling wins: only set `name` if this id doesn't exist yet.
  await ddb
    .send(
      new UpdateCommand({
        TableName: config.venuesTable,
        Key: { nameLower },
        UpdateExpression: "SET #n = if_not_exists(#n, :name)",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":name": trimmed },
      })
    )
    .catch((err) => console.warn("recordVenue failed:", err.message));
}
