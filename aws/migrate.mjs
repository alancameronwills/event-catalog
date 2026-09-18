#!/usr/bin/env node
// One-off migration: push the local server/data catalog (index.json,
// dates.json, venues.json, images/) into the deployed AWS backend. Run once
// after `sam deploy` to bring existing captures into the shared catalog.
// Safe to re-run — every item is just overwritten by its id/date/nameLower,
// so nothing gets duplicated.
//
// Uses the AWS SDK directly (not the API) since it's simpler and cheaper to
// write straight to DynamoDB/S3 for a bulk one-off than to replay 63+ HTTP
// requests through the Lambda — and it skips re-running hash/OCR, which the
// local data already has.
//
// Config: set CAPTURES_TABLE, DATES_TABLE, VENUES_TABLE, IMAGES_BUCKET,
// AWS_REGION as env vars, or create .deployed-config.json next to this file
// (gitignored) with the same keys in camelCase — see README.md.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.LOCAL_DATA_DIR || path.resolve(here, "..", "server", "data");

const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

const CONFIG = await loadConfig();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: CONFIG.region }));
const s3 = new S3Client({ region: CONFIG.region });

async function loadConfig() {
  const fromEnv = {
    capturesTable: process.env.CAPTURES_TABLE,
    datesTable: process.env.DATES_TABLE,
    venuesTable: process.env.VENUES_TABLE,
    imagesBucket: process.env.IMAGES_BUCKET,
    region: process.env.AWS_REGION,
  };
  if (Object.values(fromEnv).every(Boolean)) return fromEnv;

  try {
    const raw = await fs.readFile(path.join(here, ".deployed-config.json"), "utf8");
    const file = JSON.parse(raw);
    const merged = {
      capturesTable: fromEnv.capturesTable || file.capturesTable,
      datesTable: fromEnv.datesTable || file.datesTable,
      venuesTable: fromEnv.venuesTable || file.venuesTable,
      imagesBucket: fromEnv.imagesBucket || file.imagesBucket,
      region: fromEnv.region || file.region,
    };
    if (Object.values(merged).every(Boolean)) return merged;
    throw new Error("incomplete config");
  } catch (err) {
    console.error(
      "Missing config. Set CAPTURES_TABLE, DATES_TABLE, VENUES_TABLE, IMAGES_BUCKET, AWS_REGION env vars,\n" +
        "or create aws/.deployed-config.json (see README.md) with the `sam deploy` stack outputs.\n" +
        `(${err.message})`
    );
    process.exit(1);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
  } catch {
    return fallback;
  }
}

async function migrateCaptures() {
  const entries = await readJson("index.json", []);
  console.log(`Migrating ${entries.length} capture(s)...`);
  let ok = 0;
  let failed = 0;
  for (const e of entries) {
    try {
      let imageKey = null;
      if (e.imageFile) {
        const bytes = await fs.readFile(path.join(dataDir, "images", e.imageFile));
        const ext = path.extname(e.imageFile).slice(1).toLowerCase();
        imageKey = e.imageFile; // same "<date>/<id>.<ext>" layout as the new bucket expects
        await s3.send(
          new PutObjectCommand({
            Bucket: CONFIG.imagesBucket,
            Key: imageKey,
            Body: bytes,
            ContentType: MIME_BY_EXT[ext] || "application/octet-stream",
          })
        );
      }
      const { imageFile, imageBytes, ...rest } = e;
      await ddb.send(
        new PutCommand({
          TableName: CONFIG.capturesTable,
          Item: { ...rest, gsi1pk: "CAPTURE", imageKey },
        })
      );
      ok++;
    } catch (err) {
      failed++;
      console.warn(`  capture ${e.id} failed:`, err.message);
    }
  }
  console.log(`Captures: ${ok} migrated, ${failed} failed.`);
}

async function migrateDates() {
  const dates = await readJson("dates.json", []);
  for (const date of dates) {
    await ddb.send(new PutCommand({ TableName: CONFIG.datesTable, Item: { date, createdAt: new Date().toISOString() } }));
  }
  console.log(`Dates: ${dates.length} migrated.`);
}

async function migrateVenues() {
  const venues = await readJson("venues.json", []);
  let count = 0;
  for (const name of venues) {
    if (!name || !name.trim()) continue;
    await ddb.send(
      new PutCommand({
        TableName: CONFIG.venuesTable,
        Item: { nameLower: name.trim().toLowerCase(), name: name.trim() },
      })
    );
    count++;
  }
  console.log(`Venues: ${count} migrated.`);
}

await migrateCaptures();
await migrateDates();
await migrateVenues();
console.log("Done.");
