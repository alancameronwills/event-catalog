// Lambda configuration, from the environment variables set by template.yaml.

export const config = {
  capturesTable: process.env.CAPTURES_TABLE,
  datesTable: process.env.DATES_TABLE,
  venuesTable: process.env.VENUES_TABLE,
  imagesBucket: process.env.IMAGES_BUCKET,
  apiToken: process.env.API_TOKEN,
  dupThreshold: Number(process.env.DUP_THRESHOLD) || 10,
  region: process.env.AWS_REGION,

  // Reject request bodies larger than this (data URLs can be a few MB). API
  // Gateway/Function URL payloads are already capped at 6MB, so this mostly
  // guards against pathological input.
  maxBodyBytes: 30 * 1024 * 1024,

  // Only /tmp is writable in Lambda; Tesseract's language data is cached
  // there per-container (re-downloaded on a cold start, kept across warm
  // invocations of the same container).
  ocrCacheDir: "/tmp/ocr-cache",
  ocrEnabled: process.env.OCR !== "0",
};
