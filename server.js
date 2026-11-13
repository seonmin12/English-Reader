// Local dev server: serves public/ and routes /api/* to lib/app.js
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi, send } from "./lib/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const PUBLIC_DIR = path.join(here, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname.slice(5), url.searchParams);

  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "forbidden" });
  const data = await fs.readFile(full).catch(() => null);
  if (!data) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  res.end(data);
});

server.listen(PORT, () => {
  console.log(`English Reader → http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? "사전: Claude (문맥 기반)" : "사전: 무료 모드 (Free Dictionary + MyMemory)");
  console.log(process.env.APP_PASSWORD ? "로그인: 비밀번호 필요" : "로그인: 없음 (로컬 전용)");
});
