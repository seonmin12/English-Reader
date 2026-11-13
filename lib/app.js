// English Reader — shared app logic (used by the local server and the Vercel function)
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
const WORDS_FILE = path.join(DATA_DIR, "words.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

// ---------- News feeds ----------
const FEEDS = {
  tech: [
    { source: "The Guardian", url: "https://www.theguardian.com/uk/technology/rss" },
    { source: "BBC", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  ],
  business: [
    { source: "The Guardian", url: "https://www.theguardian.com/uk/business/rss" },
    { source: "BBC", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  ],
  world: [
    { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
    { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { source: "NPR", url: "https://feeds.npr.org/1004/rss.xml" },
  ],
  europe: [
    { source: "The Guardian", url: "https://www.theguardian.com/world/europe-news/rss" },
    { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/europe/rss.xml" },
  ],
};

const parser = new Parser({ timeout: 10000, headers: { "User-Agent": UA } });
const feedCache = new Map(); // cat -> { at, items }
const FEED_TTL = 10 * 60 * 1000;

function stripHtml(s = "") {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function getFeed(cat) {
  const hit = feedCache.get(cat);
  if (hit && Date.now() - hit.at < FEED_TTL) return hit.items;
  const lists = await Promise.allSettled(
    FEEDS[cat].map(async (f) => {
      const feed = await parser.parseURL(f.url);
      return feed.items.map((it) => ({
        source: f.source,
        title: stripHtml(it.title),
        link: it.link,
        summary: stripHtml(it.contentSnippet || it.content || it.summary || "").slice(0, 280),
        date: it.isoDate || it.pubDate || null,
      }));
    })
  );
  const seen = new Set();
  const items = lists
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    // skip live blogs, videos, galleries, quizzes: poor reading material
    .filter((it) => it.link && !/\/(live|video|videos|gallery|picture|audio|sounds|av)\//.test(it.link))
    .filter((it) => (seen.has(it.link) ? false : seen.add(it.link)))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 60);
  feedCache.set(cat, { at: Date.now(), items });
  return items;
}

// ---------- Article extraction ----------
const articleCache = new Map();

function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h.startsWith("[")) return false;
  return true;
}

async function getArticle(url) {
  if (articleCache.has(url)) return articleCache.get(url);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, redirect: "follow" });
  if (!res.ok) throw new Error(`기사 페이지를 불러오지 못했어요 (HTTP ${res.status})`);
  const html = await res.text();
  const { document: doc } = parseHTML(html);
  const parsed = new Readability(doc).parse();
  if (!parsed) throw new Error("본문을 찾지 못했어요. 다른 기사를 시도해 보세요.");

  // Rebuild as plain blocks (no raw HTML is sent to the browser)
  const { document: frag } = parseHTML(`<!doctype html><html><body>${parsed.content}</body></html>`);
  const body = frag.body;
  const blocks = [];
  body.querySelectorAll("h2, h3, p, li, blockquote").forEach((el) => {
    if (el.closest("figure, figcaption")) return;
    if (el.tagName === "P" && el.closest("li, blockquote")) return;
    const text = el.textContent.replace(/\s+/g, " ").trim();
    if (text.length < 2) return;
    const type = /^H/.test(el.tagName) ? "h" : el.tagName === "LI" ? "li" : el.tagName === "BLOCKQUOTE" ? "quote" : "p";
    blocks.push({ type, text });
  });
  // drop leading junk like "ByDaniel Thomas", "BBC News", "Share", image credits
  const junk = new Set([parsed.byline, parsed.siteName, parsed.title].filter(Boolean).map((x) => x.trim().toLowerCase()));
  while (blocks.length && (junk.has(blocks[0].text.toLowerCase()) || /^by\s?[A-Z]/.test(blocks[0].text) || blocks[0].text.split(" ").length < 6)) blocks.shift();
  if (blocks.filter((b) => b.type === "p").length < 2) throw new Error("본문이 너무 짧아요 (유료 기사이거나 영상 기사일 수 있어요).");

  const article = {
    url,
    title: (parsed.title || "").trim(),
    byline: (parsed.byline || "").trim(),
    site: parsed.siteName || new URL(url).hostname.replace(/^www\./, ""),
    blocks,
  };
  articleCache.set(url, article);
  return article;
}

// ---------- Word lookup ----------
const lookupCache = new Map();

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
  if (!res.ok) return null;
  return res.json();
}

async function translateKo(text, withAlts = false) {
  if (!text) return withAlts ? { text: null, alts: [] } : null;
  if (process.env.DEEPL_API_KEY) {
    const key = process.env.DEEPL_API_KEY;
    const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
    const res = await fetch(`https://${host}/v2/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [text], source_lang: "EN", target_lang: "KO" }),
    });
    if (res.ok) {
      const t = (await res.json()).translations?.[0]?.text ?? null;
      return withAlts ? { text: t, alts: [] } : t;
    }
  }
  const data = await getJson(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|ko`
  );
  let t = data?.responseData?.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH/i.test(t)) t = null;
  if (!withAlts) return t;
  const alts = [...new Set((data?.matches || []).map((m) => String(m.translation || "").trim()))]
    .filter((a) => a && a !== t && !(t && a.includes(t)) && !/[.!?]$/.test(a) && a.length <= 14 && /[가-힣]/.test(a) && !/[“"0-9]/.test(a))
    .slice(0, 3);
  return { text: t, alts };
}

// Guess dictionary base forms: "rallied" -> rally, "running" -> run, "taxes" -> tax
function candidates(word) {
  const w = word.toLowerCase();
  const base = [];
  if (w.length >= 5 && w.endsWith("ied")) base.push(w.slice(0, -3) + "y");
  if (w.length >= 5 && w.endsWith("ed")) { if (/(.)\1ed$/.test(w)) base.push(w.slice(0, -3)); base.push(w.slice(0, -2), w.slice(0, -1)); }
  if (w.length >= 6 && w.endsWith("ing")) { if (/(.)\1ing$/.test(w)) base.push(w.slice(0, -4)); base.push(w.slice(0, -3), w.slice(0, -3) + "e"); }
  const after = [];
  if (w.endsWith("ies")) after.push(w.slice(0, -3) + "y");
  if (w.endsWith("es")) after.push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) after.push(w.slice(0, -1));
  if (w.length >= 6 && w.endsWith("ly")) after.push(w.slice(0, -2));
  return [...new Set([...base, w, ...after])].filter((x) => x.length > 2 || x === w);
}

async function freeLookup(word) {
  const isPhrase = /\s/.test(word);
  // Query all base-form candidates and the raw-word translation in parallel
  const cands = isPhrase ? [] : candidates(word);
  const [results, trWord] = await Promise.all([
    Promise.all(cands.map((c) => getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(c)}`).catch(() => null))),
    translateKo(word.toLowerCase(), true),
  ]);
  const entry = results.find((d) => Array.isArray(d) && d.length) || null;
  const lemma = entry?.[0]?.word || word.toLowerCase();
  const tr = lemma === word.toLowerCase() ? trWord : await translateKo(lemma, true);

  // Group senses by part of speech; the POS with the most senses is the main one
  const byPos = new Map();
  let phonetic = null, audio = null;
  for (const e of entry || []) {
    phonetic ||= e.phonetic || e.phonetics?.find((p) => p.text)?.text || null;
    audio ||= e.phonetics?.find((p) => p.audio)?.audio || null;
    for (const m of e.meanings || []) {
      const list = byPos.get(m.partOfSpeech) || [];
      for (const d of m.definitions || []) list.push({ pos: m.partOfSpeech, definition: d.definition, example: d.example || null });
      if (m.synonyms?.length && list.length) list[list.length - 1].synonyms ||= m.synonyms.slice(0, 5);
      byPos.set(m.partOfSpeech, list);
    }
  }
  const groups = [...byPos.values()].sort((a, b) => b.length - a.length);
  const senses = groups.flatMap((g) => g.slice(0, 3));
  return {
    mode: "free",
    word,
    lemma,
    phonetic,
    audio,
    meaningKo: tr.text,
    altKo: [...new Set([...(tr.alts || []), ...(tr !== trWord && trWord.text && trWord.text !== tr.text ? [trWord.text] : [])])].slice(0, 3),
    pos: groups[0]?.[0]?.pos || null,
    senses: senses.slice(0, 8),
  };
}

let anthropic = null;
async function claudeLookup(word, sentence) {
  if (!anthropic) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropic = new Anthropic();
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["lemma", "phonetic", "pos", "meaningKo", "contextNote", "otherMeanings", "examples", "collocations", "sentenceKo", "cefr"],
    properties: {
      lemma: { type: "string", description: "Dictionary base form (or the phrase as-is)" },
      phonetic: { type: "string", description: "IPA, e.g. /ˈɪn.sənt/" },
      pos: { type: "string", description: "Part of speech in Korean + English, e.g. '동사 (verb)'" },
      meaningKo: { type: "string", description: "Short Korean meaning that fits THIS sentence" },
      contextNote: { type: "string", description: "One Korean sentence explaining the nuance here" },
      otherMeanings: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["pos", "meaningKo"],
          properties: { pos: { type: "string" }, meaningKo: { type: "string" } },
        },
      },
      examples: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["en", "ko"],
          properties: { en: { type: "string" }, ko: { type: "string" } },
        },
      },
      collocations: { type: "array", items: { type: "string" } },
      sentenceKo: { type: "string", description: "Natural Korean translation of the whole sentence" },
      cefr: { type: "string", description: "Estimated CEFR level of the word/sense: A1..C2" },
    },
  };

  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system:
      "You are an English-Korean learner's dictionary for a Korean reader at CEFR B2–C1 reading news. " +
      "Give the meaning that fits the given sentence first. Korean must be natural and concise. " +
      "Give 2 short example sentences in a news/business register, 0–3 other common meanings, and 2–4 common collocations.",
    messages: [
      { role: "user", content: `Word or phrase: "${word}"\nSentence: "${sentence || "(none)"}"` },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this lookup");
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from Claude");
  const data = JSON.parse(text);

  // Pronunciation audio still comes from the free dictionary when available
  let audio = null;
  if (!/\s/.test(data.lemma)) {
    const d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(data.lemma)}`).catch(() => null);
    audio = Array.isArray(d) ? d[0]?.phonetics?.find((p) => p.audio)?.audio || null : null;
  }
  return { mode: "claude", word, audio, ...data };
}

async function lookup(word, sentence) {
  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  const key = `${useClaude ? "c" : "f"}|${word.toLowerCase()}|${useClaude ? sentence : ""}`;
  if (lookupCache.has(key)) return lookupCache.get(key);
  let result;
  if (useClaude) {
    try {
      result = await claudeLookup(word, sentence);
    } catch (err) {
      console.error("Claude lookup failed, using free dictionary:", err.message);
      result = { ...(await freeLookup(word)), notice: "Claude 조회에 실패해서 무료 사전으로 보여드려요." };
    }
  } else {
    result = await freeLookup(word);
  }
  lookupCache.set(key, result);
  return result;
}


// ---------- Wordbook storage ----------
// On Vercel: Upstash Redis (REST). Locally: data/words.json.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const WORDS_KEY = "english-reader:words";

async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`단어장 저장소 오류: ${data.error || res.status}`);
  return data.result;
}

async function readWords() {
  if (REDIS_URL) {
    const raw = await redis(["GET", WORDS_KEY]);
    return raw ? JSON.parse(raw) : [];
  }
  if (process.env.VERCEL) throw new Error("단어장 저장소(Upstash Redis)가 연결되지 않았어요. Vercel 대시보드에서 Storage → Upstash Redis를 연결해 주세요.");
  try { return JSON.parse(await fs.readFile(WORDS_FILE, "utf8")); } catch { return []; }
}
async function writeWords(words) {
  if (REDIS_URL) return redis(["SET", WORDS_KEY, JSON.stringify(words)]);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WORDS_FILE, JSON.stringify(words, null, 2));
}

// ---------- Password login ----------
// APP_PASSWORD set → every API call needs a signed session cookie.
// On Vercel with no APP_PASSWORD, the API refuses to run (fail closed).
const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.AUTH_SECRET || crypto.createHash("sha256").update(`er:${PASSWORD}`).digest("hex");
const COOKIE = "er_session";
const SESSION_DAYS = 30;

function sign(exp) {
  return crypto.createHmac("sha256", SECRET).update(String(exp)).digest("base64url");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthed(req) {
  if (!PASSWORD) return !process.env.VERCEL;
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const [exp, sig] = v.split(".");
  return Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}
function sessionCookie(req, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.VERCEL ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- HTTP helpers ----------
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error("too large"); }
  return raw ? JSON.parse(raw) : {};
}

// ---------- API router ----------
// `route` is the part after /api/, e.g. "feed", "lookup"
export async function handleApi(req, res, route, query) {
  try {
    if (route === "session") {
      return send(res, 200, { authed: isAuthed(req), needsPassword: Boolean(PASSWORD), configured: Boolean(PASSWORD) || !process.env.VERCEL });
    }
    if (route === "login" && req.method === "POST") {
      const { password } = await readBody(req);
      if (!PASSWORD) return send(res, 400, { error: "서버에 APP_PASSWORD가 설정되지 않았어요." });
      if (!safeEqual(password || "", PASSWORD)) {
        await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
        return send(res, 401, { error: "비밀번호가 틀렸어요." });
      }
      const exp = Date.now() + SESSION_DAYS * 864e5;
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, `${exp}.${sign(exp)}`, SESSION_DAYS * 86400) });
    }
    if (route === "logout") {
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
    }

    if (!isAuthed(req)) {
      if (!PASSWORD && process.env.VERCEL) return send(res, 503, { error: "APP_PASSWORD 환경변수를 먼저 설정해 주세요." });
      return send(res, 401, { error: "로그인이 필요해요." });
    }

    if (route === "config") {
      return send(res, 200, { claude: Boolean(process.env.ANTHROPIC_API_KEY), deepl: Boolean(process.env.DEEPL_API_KEY) });
    }
    if (route === "feed") {
      const cat = query.get("cat") || "tech";
      if (!FEEDS[cat]) return send(res, 400, { error: "unknown category" });
      return send(res, 200, { items: await getFeed(cat) });
    }
    if (route === "article") {
      const target = query.get("url");
      if (!isPublicHttpUrl(target)) return send(res, 400, { error: "올바른 기사 URL이 아니에요." });
      return send(res, 200, await getArticle(target));
    }
    if (route === "lookup" && req.method === "POST") {
      const { word, sentence } = await readBody(req);
      const w = String(word || "").trim().slice(0, 80);
      if (!w) return send(res, 400, { error: "word required" });
      return send(res, 200, await lookup(w, String(sentence || "").slice(0, 600)));
    }
    if (route === "translate" && req.method === "POST") {
      const { text } = await readBody(req);
      return send(res, 200, { ko: await translateKo(String(text || "").slice(0, 600)) });
    }
    if (route === "words") {
      if (req.method === "GET") return send(res, 200, await readWords());
      if (req.method === "POST") {
        const item = await readBody(req);
        const words = await readWords();
        const key = (item.lemma || item.word || "").toLowerCase();
        const existing = words.find((w) => (w.lemma || w.word).toLowerCase() === key);
        if (existing) { existing.count = (existing.count || 1) + 1; existing.contexts = [...new Set([...(existing.contexts || []), item.sentence].filter(Boolean))].slice(-5); }
        else words.unshift({ ...item, id: Date.now().toString(36), savedAt: new Date().toISOString(), count: 1, contexts: [item.sentence].filter(Boolean), box: 0 });
        await writeWords(words);
        return send(res, 200, words);
      }
      if (req.method === "PATCH") {
        const { id, box } = await readBody(req);
        const words = await readWords();
        const w = words.find((x) => x.id === id);
        if (w && Number.isInteger(box)) w.box = box;
        await writeWords(words);
        return send(res, 200, words);
      }
      if (req.method === "DELETE") {
        const id = query.get("id");
        const words = (await readWords()).filter((w) => w.id !== id);
        await writeWords(words);
        return send(res, 200, words);
      }
    }
    return send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message || "server error" });
  }
}
