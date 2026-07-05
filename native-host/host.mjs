// Native messaging host for the Event Poster Catalog extension.
//
// Chrome launches this (via event_catalog_host.bat) when the side panel finds
// the local server offline. Protocol: Chrome sends one message, we make sure
// `node server.js` is running, we reply, we exit.
//
// Native messaging framing on stdin/stdout: a 4-byte little-endian length
// prefix followed by that many bytes of UTF-8 JSON. We don't care about the
// message contents — any message means "ensure the server is up". The server
// itself refuses a second bind on the port, so a redundant launch is harmless.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "..", "server");
const serverEntry = path.join(serverDir, "server.js");

// Write a framed JSON message back to Chrome.
function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// Launch the server detached so it keeps running after this host exits.
// stdio is ignored (no console); the server refuses a duplicate port bind.
function startServer() {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

let done = false;
function handle() {
  if (done) return;
  done = true;
  try {
    startServer();
    send({ ok: true });
  } catch (err) {
    send({ ok: false, error: String((err && err.message) || err) });
  }
  // Let the tiny reply flush, then exit so Chrome sees a clean disconnect.
  setTimeout(() => process.exit(0), 150);
}

// Read one full framed message, then act. If Chrome closes stdin first (e.g.
// sendNativeMessage with an empty-ish payload), still launch on 'end'.
const chunks = [];
let expected = null;
process.stdin.on("data", (chunk) => {
  chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (expected === null && buf.length >= 4) expected = buf.readUInt32LE(0);
  if (expected !== null && buf.length >= 4 + expected) handle();
});
process.stdin.on("end", handle);
