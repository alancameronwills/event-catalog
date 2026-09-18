# Shared AWS backend

Replaces the local `server/` for anyone who wants one catalog shared between
several people/machines (Windows and Mac alike) instead of one catalog per
machine. A single Lambda function, invoked via a Function URL (no API
Gateway), backed by DynamoDB (the index) and S3 (images). Everything is
pay-per-use — DynamoDB is on-demand billing and Lambda only costs anything
while it's actually handling a request — so an idle catalog costs nothing
between captures.

This is a different design from `server/`+`native-host/` (one local server
per machine, no sharing). Those still exist and still work standalone for
local dev/offline use, but the extension talks to this backend by default —
see "Wiring up the extension" below.

## Architecture

- **`ApiFunction`** (Lambda, Node 24, `src/index.mjs`) — single handler for
  every route (`GET/POST /captures`, `PATCH/DELETE /captures/:id`,
  `GET/POST /dates`, `DELETE /dates/:date`, `GET /venues`, `GET /health`).
  Ported from `server/{server,store,hash,ocr}.js`; same perceptual-hash
  duplicate detection and Tesseract OCR-on-capture, same date/venue/time
  parsing.
- **Function URL**, not API Gateway — simpler and avoids API Gateway's 30s
  integration timeout (a cold Tesseract start plus OCR can flirt with that).
  CORS is wide open (`AllowOrigins: ["*"]`) because every unpacked extension
  install has a different `chrome-extension://` origin; the real access
  control is the app-level token below, not CORS.
- **Auth**: every request (except `/health`) must carry `X-Api-Token:
  <shared secret>`. One token for everyone — there's no per-user identity.
  Checked in `index.mjs`, not IAM/SigV4, so any HTTP client works.
- **`CapturesTable`** (DynamoDB, on-demand) — PK `id`. A `ByCapturedAt` GSI
  (PK `gsi1pk="CAPTURE"` constant, SK `capturedAt`) gives "all captures,
  newest first" as one `Query`, and doubles as the feed duplicate-detection
  scans for existing hashes.
- **`DatesTable`** / **`VenuesTable`** (DynamoDB, on-demand) — small
  supporting tables, same idea as `dates.json`/`venues.json` locally.
- **`ImagesBucket`** (S3) — poster images, keyed `<date>/<id>.<ext>` like the
  local `images/` folder. Public-read (`s3:GetObject` only, bucket listing
  stays blocked) so the panel can use the S3 URL directly with no signing —
  posters are public marketing material scraped from public pages anyway, and
  the local server never gated `/images/*` either. Object keys embed a random
  id, so nothing is enumerable. `GET /captures` returns each entry's URL as
  `imageSrc`.

## One-time deploy

Needs the [AWS CLI](https://docs.aws.amazon.com/cli/) and [SAM
CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
configured with credentials for the target account.

```sh
cd aws
sam build
sam deploy --stack-name event-catalog --resolve-s3 --capabilities CAPABILITY_IAM \
  --parameter-overrides ApiToken=$(openssl rand -hex 32) DuplicateThreshold=10
```

`sam build` needs no Docker: `src/.npmrc` forces `npm install` to fetch the
Linux x64 `sharp` binary regardless of which OS you're building on (Lambda
always runs on Amazon Linux). First deploy will prompt to confirm the
changeset unless you add `--no-confirm-changeset`.

Note the **`ApiUrl`** output (the Function URL) and the table/bucket name
outputs — you'll need the URL for the extension and all of them for
`migrate.mjs`. Keep the `ApiToken` value somewhere safe (a password manager);
it's `NoEcho` in CloudFormation so it won't show up in the console, and this
repo never stores it in a tracked file.

Optional convenience: copy the outputs into `.deployed-config.json` next to
this README (gitignored — never commit it):

```json
{
  "region": "eu-west-2",
  "apiUrl": "https://xxxx.lambda-url.eu-west-2.on.aws/",
  "capturesTable": "event-catalog-CapturesTable-XXXX",
  "datesTable": "event-catalog-DatesTable-XXXX",
  "venuesTable": "event-catalog-VenuesTable-XXXX",
  "imagesBucket": "event-catalog-images-<account>-<region>"
}
```

`migrate.mjs` reads this file if the equivalent env vars aren't set.

## Migrating an existing local catalog

If you (or whoever's been using the Windows/Mac local-server version) has
existing captures in `server/data/`, bring them into the shared catalog once:

```sh
cd aws
npm install
node migrate.mjs
```

Reads `server/data/index.json` / `dates.json` / `venues.json` / `images/`
directly, uploads images to S3 and writes items to DynamoDB via the AWS SDK
(not through the API — simpler for a bulk one-off, and it skips re-running
hash/OCR since the local data already has them). Safe to re-run: every item
is keyed by its id/date/nameLower, so nothing duplicates.

## Wiring up the extension

`extension/background.js` and `extension/sidepanel/sidepanel.js` each have an
`API_URL` constant — set both to the `ApiUrl` output. The panel prompts once
for the shared `ApiToken` (stored in `chrome.storage.local`, this browser
only) the first time it makes a request; a wrong/expired token gets forgotten
on a 401 so the next call re-prompts. `background.js` has no UI to prompt
with — if a capture happens before the panel has ever set the token, it falls
back to `chrome.storage.local` like an offline capture would, same as before.

Give every user the same `ApiUrl` and `ApiToken` (e.g. over a password
manager or secure chat) — that's the entire "invite" flow, no accounts to
create.

## Operating it

- **Logs**: CloudWatch Logs, log group `/aws/lambda/<ApiFunction's name>`
  (`aws lambda list-functions` to find the exact name — SAM appends a suffix).
- **Cost**: with on-demand DynamoDB + Lambda-only-while-running, a catalog
  that's idle costs $0. At low personal-scale usage this comfortably sits
  inside the AWS free tier for Lambda/DynamoDB; S3 storage for a few hundred
  poster images is a few cents a month.
- **Redeploying after a code change**: `sam build && sam deploy` (same
  command as above, parameters are remembered via `samconfig.toml` if you let
  `sam deploy --guided` write one — this repo's `.gitignore` keeps that file
  local since it can end up holding the token).
- **Rotating the token**: `sam deploy --parameter-overrides ApiToken=<new>`,
  then update it in every user's browser (they'll get a 401 and be re-prompted
  automatically — just tell them the new value).
- **Tearing down**: `sam delete --stack-name event-catalog` (empties and
  deletes the S3 bucket, tables, and function).

## Files

| File | Role |
| --- | --- |
| `template.yaml` | SAM template: Lambda, Function URL, DynamoDB tables, S3 bucket |
| `src/index.mjs` | Route handler + auth check |
| `src/store.mjs` | DynamoDB + S3 persistence (replaces `server/store.js`) |
| `src/hash.mjs` | Perceptual hash (identical to `server/hash.js`) |
| `src/ocr.mjs` | Tesseract OCR + date/time parsing (adapted for `/tmp`) |
| `src/config.mjs` | Env-var config |
| `src/.npmrc` | Forces Linux x64 `sharp` regardless of build host OS |
| `migrate.mjs` | One-off: push `server/data/` into this backend |
