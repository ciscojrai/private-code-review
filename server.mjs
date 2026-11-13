/**
 * Private Code Review — minimal server (NEAR HACKATHON).
 *
 * Two endpoints + static files. No framework, no keys committed, no network
 * required to boot.
 *
 *   GET  /api/engine   -> { model, keyPresent, ... }
 *   POST /api/review   -> { review, tier, tierLabel, receiptUrl, ... }
 *
 * The heavy lifting is in mission/server/: the attested inference worker
 * (near-inference.mjs), the review service (review.mjs), and the attestation
 * bridge (attestation.mjs).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewDiff } from "./mission/server/review.mjs";
import { teeStatus } from "./mission/server/near-inference.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 8787);

// Minimal .env loader (no dependency). Only sets vars that are not already set.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv(path.join(ROOT, ".env"));

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

function readBody(req, res, done) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 2_000_000) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    try {
      done(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"), res);
    } catch {
      json(res, 400, { error: "Body was not JSON." });
    }
  });
}

function staticFile(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return json(res, 404, { error: "Not found" });
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/engine") {
    return json(res, 200, teeStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/review") {
    return readBody(req, res, (body) => {
      const diff = String(body?.diff || "");
      if (!diff.trim()) return json(res, 400, { error: "Paste a diff to review." });
      return reviewDiff(diff)
        .then((result) => json(res, 200, result))
        .catch((error) => json(res, 500, { error: error.message || "Review failed." }));
    });
  }

  if (req.method === "GET") return staticFile(res, url.pathname);
  return json(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Private Code Review listening on http://127.0.0.1:${PORT}`);
  console.log(process.env.NEARAI_API_KEY
    ? "NEAR AI key present — verified (provider_tee) tier enabled."
    : "No NEARAI_API_KEY — will fall back (unverified).");
});
