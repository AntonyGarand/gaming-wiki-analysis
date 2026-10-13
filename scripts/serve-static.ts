/**
 * serve-static.ts — tiny static file server with gzip for the dist/ build.
 *
 * Usage: npx tsx scripts/serve-static.ts          # → http://0.0.0.0:8080
 *        PORT=9000 npx tsx scripts/serve-static.ts
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as zlib from "zlib";

const ROOT = path.resolve(import.meta.dirname, "..", "dist");
const PORT = Number(process.env.PORT ?? 8080);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (!fs.existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
      file = path.join(file, "index.html");
    }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] ?? "application/octet-stream";
    const raw = fs.readFileSync(file);
    // gzip anything compressible and non-trivial
    const accept = req.headers["accept-encoding"] ?? "";
    if (accept.includes("gzip") && raw.length > 1024 && (type.startsWith("text/") || type.includes("json"))) {
      const gz = zlib.gzipSync(raw, { level: 6 });
      res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", "Cache-Control": "no-cache", "Vary": "Accept-Encoding" });
      res.end(gz);
    } else {
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(raw);
    }
  } catch (e) {
    res.writeHead(500); res.end((e as Error).message);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`static article → http://0.0.0.0:${PORT} (serving ${ROOT})`);
});
