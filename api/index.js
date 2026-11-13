// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json)
import { handleApi } from "../lib/app.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const route = url.searchParams.get("route") || url.pathname.replace(/^\/api\/?/, "");
  url.searchParams.delete("route");
  return handleApi(req, res, route, url.searchParams);
}
