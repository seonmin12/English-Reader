const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { bookmarks: [], cat: "tech", words: [], article: null, sentences: [], config: {} };

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) { showLogin(); throw new Error("로그인이 필요해요."); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Views ----------
function show(view) {
  for (const v of ["feed", "reader", "words"]) $(`#view-${v}`).hidden = v !== view;
  if (view !== "reader") player.stop();
  $("#tabs").style.visibility = view === "feed" ? "visible" : "hidden";
  hidePopup();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (!go) return;
  if (go === "feed") { history.pushState({}, "", "/"); show("feed"); }
  if (go === "words") { history.pushState({ view: "words" }, "", "#words"); renderWords(); show("words"); }
});
window.addEventListener("popstate", () => {
  if (location.hash === "#words") { renderWords(); show("words"); }
  else if (location.hash.startsWith("#read=")) openArticle(decodeURIComponent(location.hash.slice(6)), false);
  else show("feed");
});

// ---------- Feed ----------
function timeAgo(d) {
  if (!d) return "";
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}

const STAR = (on) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>`;
const isBookmarked = (url) => state.bookmarks.some((b) => b.url === url);

async function toggleBookmark(item) {
  const url = item.link || item.url;
  if (isBookmarked(url)) {
    state.bookmarks = await api(`/api/bookmarks?url=${encodeURIComponent(url)}`, { method: "DELETE" });
  } else {
    state.bookmarks = await api("/api/bookmarks", {
      method: "POST",
      body: { url, title: item.title, site: item.source || item.site, summary: item.summary },
    });
  }
  updateBookmarkUi();
}
function updateBookmarkUi() {
  document.querySelectorAll("#feed [data-bm]").forEach((b) => {
    const on = isBookmarked(b.dataset.bm);
    b.innerHTML = STAR(on);
    b.classList.toggle("on", on);
    b.title = on ? "저장 취소" : "나중에 읽기";
  });
  const rb = $("#btn-bm");
  if (rb && state.article) {
    const on = isBookmarked(state.article.url);
    rb.innerHTML = `${STAR(on)}<span>${on ? "저장됨" : "나중에 읽기"}</span>`;
    rb.classList.toggle("on", on);
  }
  $("#saved-count").textContent = state.bookmarks.length ? state.bookmarks.length : "";
}

async function loadFeed(cat) {
  state.cat = cat;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.cat === cat));
  const list = $("#feed");
  list.innerHTML = `<div class="loading"><span class="spinner"></span>기사를 불러오는 중…</div>`;
  try {
    let items;
    if (cat === "saved") {
      state.bookmarks = await api("/api/bookmarks");
      items = state.bookmarks.map((b) => ({ link: b.url, title: b.title, source: b.site, summary: b.summary, date: b.savedAt, saved: true }));
      if (!items.length) { list.innerHTML = `<div class="empty">저장한 기사가 없어요.<br>기사 카드나 읽기 화면의 ☆를 누르면 여기에 모여요.</div>`; return; }
    } else {
      ({ items } = await api(`/api/feed?cat=${cat}`));
    }
    if (!items.length) { list.innerHTML = `<div class="empty">기사가 없어요.</div>`; return; }
    list.innerHTML = items.map((it, i) => `
      <li data-i="${i}">
        <div class="src"><span>${esc(it.source)}</span><span>·</span><span>${it.saved ? "저장 " : ""}${esc(timeAgo(it.date))}</span>
          <button class="bm" data-bm="${esc(it.link)}" aria-label="나중에 읽기"></button></div>
        <h3>${esc(it.title)}</h3>
        ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
      </li>`).join("");
    updateBookmarkUi();
    list.onclick = async (e) => {
      const bm = e.target.closest("[data-bm]");
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      const item = items[li.dataset.i];
      if (bm) {
        e.stopPropagation();
        bm.disabled = true;
        await toggleBookmark(item).catch((err) => alert(err.message));
        bm.disabled = false;
        if (cat === "saved" && !isBookmarked(item.link)) li.remove();
        return;
      }
      openArticle(item.link);
    };
  } catch (err) {
    list.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  }
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cat]");
  if (b) loadFeed(b.dataset.cat);
});
$("#url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = $("#url-input").value.trim();
  if (url) openArticle(url);
});

// ---------- Reader ----------
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}
function estimateLevel(text) {
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().split(/\s+/).length > 2);
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (!sentences.length || !words.length) return null;
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
  const cefr = grade < 7 ? "B1" : grade < 10 ? "B2" : grade < 13 ? "C1" : "C2";
  return { cefr, words: words.length, minutes: Math.max(1, Math.round(words.length / 200)) };
}

// split paragraph into sentences, then into clickable word spans
function renderTextInto(el, text) {
  const parts = text.match(/[^.!?]+(?:[.!?]+["'”’)]*\s*|$)/g) || [text];
  for (const sentence of parts) {
    const sIdx = state.sentences.push(sentence.trim()) - 1;
    const tokens = sentence.split(/([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])/);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (i % 2 === 1) {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = t;
        span.dataset.s = sIdx;
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(t));
      }
    }
  }
}

async function openArticle(url, push = true) {
  show("reader");
  if (push) history.pushState({}, "", `#read=${encodeURIComponent(url)}`);
  const art = $("#article");
  $("#reader-meta").textContent = "";
  art.innerHTML = `<div class="loading"><span class="spinner"></span>본문을 정리하는 중…</div>`;
  try {
    const a = await api(`/api/article?url=${encodeURIComponent(url)}`);
    state.article = a;
    state.sentences = [];
    art.innerHTML = "";
    const h1 = document.createElement("h1");
    renderTextInto(h1, a.title);
    art.appendChild(h1);
    const by = document.createElement("div");
    by.className = "byline";
    by.textContent = [a.site, a.byline].filter(Boolean).join(" · ");
    art.appendChild(by);
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.textContent = "단어를 클릭하면 뜻이 나와요. 여러 단어(숙어·구동사)는 드래그해서 선택하세요.";
    art.appendChild(tip);

    let ul = null;
    for (const b of a.blocks) {
      if (b.type === "li") {
        if (!ul) { ul = document.createElement("ul"); art.appendChild(ul); }
        const li = document.createElement("li");
        renderTextInto(li, b.text);
        ul.appendChild(li);
        continue;
      }
      ul = null;
      const el = document.createElement(b.type === "h" ? "h2" : b.type === "quote" ? "blockquote" : "p");
      renderTextInto(el, b.text);
      art.appendChild(el);
    }
    const src = document.createElement("p");
    src.className = "source-link";
    src.innerHTML = `원문: <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.site)}</a>`;
    art.appendChild(src);

    updateBookmarkUi();
    const lv = estimateLevel(a.blocks.map((b) => b.text).join(" "));
    $("#reader-meta").innerHTML = lv ? `<span class="level">≈ ${lv.cefr}</span>${lv.words.toLocaleString()} words · ${lv.minutes}분` : "";
    markSaved();
    player.reset();
  } catch (err) {
    art.innerHTML = `<div class="error">${esc(err.message)}<br><br><a href="${esc(url)}" target="_blank" rel="noopener">원문 사이트에서 보기</a></div>`;
  }
}

function savedSet() {
  const s = new Set();
  for (const w of state.words) { s.add((w.lemma || "").toLowerCase()); s.add((w.word || "").toLowerCase()); }
  return s;
}
function markSaved() {
  const s = savedSet();
  document.querySelectorAll("#article .w").forEach((el) => el.classList.toggle("saved", s.has(el.textContent.toLowerCase().replace(/’/g, "'"))));
}

// ---------- Lookup popup ----------
const popup = $("#popup");
let activeEl = null;
let lookupSeq = 0;

function hidePopup() {
  popup.hidden = true;
  activeEl?.classList.remove("active");
  activeEl = null;
}
function placePopup(rect) {
  if (window.innerWidth <= 640) return; // bottom sheet on phones
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  let left = rect.left + window.scrollX + rect.width / 2 - pw / 2;
  left = Math.max(16 + window.scrollX, Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - 16));
  let top = rect.bottom + window.scrollY + 8;
  if (rect.bottom + ph + 16 > window.innerHeight && rect.top - ph - 8 > 0) top = rect.top + window.scrollY - ph - 8;
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

// ---------- Text-to-speech (browser voices, free) ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const RATES = [0.8, 0.9, 1, 1.15, 1.3];

// macOS/iOS ship joke voices (Bubbles, Zarvox…) — keep them out of the list
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Rocko|Grandma|Grandpa|Eddy|Flo|Reed|Sandy|Shelley)\b/i;
const GOOD = /(Samantha|Daniel|Karen|Moira|Serena|Ava|Allison|Susan|Tom|Evan|Zoe|Nathan|Kate|Oliver|Arthur|Martha|Google)/i;
function englishVoices() {
  return speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name));
}
function pickVoice() {
  const voices = englishVoices();
  const saved = store.get("er-voice", "");
  if (saved) { const v = voices.find((x) => x.name === saved); if (v) return v; }
  // prefer higher-quality voices when the device has them
  const score = (v) =>
    (/premium|enhanced|natural|neural/i.test(v.name) ? 4 : 0) + (GOOD.test(v.name) ? 2 : 0) +
    (/en[-_](GB|US)/i.test(v.lang) ? 1 : 0) + (v.localService ? 0.5 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] || null;
}
function makeUtterance(text, rate) {
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
  u.rate = rate;
  return u;
}
function speak(text, rate = 0.9) {
  player.stop();
  speechSynthesis.cancel();
  speechSynthesis.speak(makeUtterance(text, rate));
}

const player = {
  idx: 0,
  playing: false,
  token: 0,
  rate: Number(store.get("er-rate", "1")) || 1,
  bar: null,

  init() {
    this.bar = $("#player");
    this.bar.addEventListener("click", (e) => {
      const act = e.target.closest("[data-p]")?.dataset.p;
      if (act === "toggle") this.playing ? this.pause() : this.play();
      if (act === "prev") this.jump(-1);
      if (act === "next") this.jump(1);
      if (act === "rate") this.cycleRate();
    });
    $("#voice-select").addEventListener("change", (e) => {
      store.set("er-voice", e.target.value);
      if (this.playing) this.play(this.idx);
    });
    const fill = () => {
      const sel = $("#voice-select");
      const cur = pickVoice()?.name;
      sel.innerHTML = englishVoices().map((v) => `<option value="${esc(v.name)}" ${v.name === cur ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("");
      sel.hidden = !sel.options.length;
    };
    fill();
    speechSynthesis.addEventListener?.("voiceschanged", fill);
    this.render();
  },
  reset() { this.stop(); this.idx = 0; this.render(); },
  render() {
    if (!this.bar) return;
    $("[data-p=toggle]", this.bar).innerHTML = this.playing ? "❚❚ 일시정지" : "▶ 기사 듣기";
    $("[data-p=rate]", this.bar).textContent = `${this.rate}×`;
    const total = state.sentences.length;
    $("#player-pos", this.bar).textContent = total ? `${Math.min(this.idx + 1, total)} / ${total}` : "";
  },
  highlight() {
    document.querySelectorAll("#article .w.speaking").forEach((el) => el.classList.remove("speaking"));
    if (!this.playing) return;
    const spans = document.querySelectorAll(`#article .w[data-s="${this.idx}"]`);
    spans.forEach((el) => el.classList.add("speaking"));
    const first = spans[0];
    if (first) {
      const r = first.getBoundingClientRect();
      if (r.top < 70 || r.bottom > window.innerHeight - 120) first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  },
  play(from = this.idx) {
    if (!state.sentences.length) return;
    this.idx = Math.max(0, Math.min(from, state.sentences.length - 1));
    this.playing = true;
    const token = ++this.token;
    speechSynthesis.cancel();
    const next = () => {
      if (token !== this.token || !this.playing) return;
      if (this.idx >= state.sentences.length) { this.playing = false; this.idx = 0; this.highlight(); this.render(); return; }
      const text = state.sentences[this.idx];
      this.highlight();
      this.render();
      if (!/[A-Za-z]/.test(text)) { this.idx++; return next(); }
      const u = makeUtterance(text, this.rate);
      u.onend = () => { if (token === this.token) { this.idx++; next(); } };
      u.onerror = (e) => { if (token === this.token && e.error !== "interrupted" && e.error !== "canceled") { this.idx++; next(); } };
      speechSynthesis.speak(u);
    };
    next();
  },
  pause() { this.playing = false; this.token++; speechSynthesis.cancel(); this.highlight(); this.render(); },
  stop() { if (this.playing) this.pause(); },
  jump(d) { const was = this.playing; this.idx = Math.max(0, Math.min(this.idx + d, state.sentences.length - 1)); was ? this.play(this.idx) : this.render(); },
  cycleRate() {
    this.rate = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length] || 1;
    store.set("er-rate", String(this.rate));
    if (this.playing) this.play(this.idx); else this.render();
  },
};

async function lookup(word, sentence, rect) {
  const seq = ++lookupSeq;
  popup.hidden = false;
  popup.innerHTML = `<button class="close" aria-label="닫기">×</button><div class="head"><span class="word">${esc(word)}</span></div><div class="note"><span class="spinner"></span>찾는 중…</div>`;
  placePopup(rect);
  try {
    // core (meaning) and more (examples, translation) run in parallel; meaning shows first
    const coreP = fetchPart(word, sentence, "core");
    const moreP = state.config.claude ? fetchPart(word, sentence, "more") : null;
    moreP?.catch(() => {});
    const r = await coreP;
    if (seq !== lookupSeq) return;
    renderPopup(r, sentence);
    placePopup(rect);
    if (r.mode === "claude" && moreP) {
      moreP.then((m) => {
        if (seq !== lookupSeq) return;
        Object.assign(r, m, { mode: "claude" });
        const slot = $("#more-slot", popup);
        if (slot) slot.innerHTML = moreHtml(r);
      }).catch(() => {
        const slot = $("#more-slot", popup);
        if (seq === lookupSeq && slot) slot.innerHTML = `<div class="notice">예문과 해석을 불러오지 못했어요.</div>`;
      });
    }
  } catch (err) {
    if (seq !== lookupSeq) return;
    popup.innerHTML = `<button class="close" aria-label="닫기">×</button><div class="head"><span class="word">${esc(word)}</span></div><div class="error" style="padding:10px 0;text-align:left">${esc(err.message)}</div>`;
  }
}

const partCache = new Map();
function fetchPart(word, sentence, part) {
  const key = `${part}|${word.toLowerCase()}|${sentence}`;
  if (!partCache.has(key)) {
    const p = api("/api/lookup", { method: "POST", body: { word, sentence, part } });
    p.catch(() => partCache.delete(key));
    partCache.set(key, p);
  }
  return partCache.get(key);
}

function moreHtml(r) {
  let h = "";
  if (r.contextNote) h += `<div class="note">${esc(r.contextNote)}</div>`;
  if (r.otherMeanings?.length) h += `<div class="sec"><h4>다른 뜻</h4>${r.otherMeanings.map((m) => `<div class="sense"><span class="pos">${esc(m.pos)}</span>${esc(m.meaningKo)}</div>`).join("")}</div>`;
  if (r.examples?.length) h += `<div class="sec"><h4>예문</h4>${r.examples.map((x) => `<div class="sense"><div class="ex">${esc(x.en)}</div><div class="exko">${esc(x.ko)}</div></div>`).join("")}</div>`;
  if (r.collocations?.length) h += `<div class="sec"><h4>자주 쓰는 표현</h4><div class="chips">${r.collocations.map((c) => `<span>${esc(c)}</span>`).join("")}</div></div>`;
  if (r.sentenceKo) h += `<div class="sec"><h4>문장 해석</h4><div class="sent-ko">${esc(r.sentenceKo)}</div></div>`;
  return h;
}

function renderPopup(r, sentence) {
  const head = `
    <button class="close" aria-label="닫기">×</button>
    <div class="head">
      <span class="word">${esc(r.lemma || r.word)}</span>
      ${r.phonetic ? `<span class="ipa">${esc(r.phonetic)}</span>` : ""}
      <button class="icon" data-act="speak" title="발음 듣기"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg></button>
      ${r.cefr ? `<span class="cefr">${esc(r.cefr)}</span>` : ""}
    </div>
    ${r.lemma && r.word && r.lemma.toLowerCase() !== r.word.toLowerCase() ? `<div class="note">본문 형태: ${esc(r.word)}</div>` : ""}`;

  let body = "";
  if (r.mode === "claude") {
    body += `<div class="ko">${r.pos ? `<span class="pos">${esc(r.pos)}</span>` : ""}${esc(r.meaningKo)}</div>`;
    body += `<div id="more-slot">${r.examples ? moreHtml(r) : `<div class="note"><span class="spinner"></span>예문·해석 불러오는 중…</div>`}</div>`;
  } else {
    body += `<div class="ko">${r.pos ? `<span class="pos">${esc(r.pos)}</span>` : ""}${esc(r.meaningKo || "(한글 뜻을 찾지 못했어요)")}</div>`;
    if (r.altKo?.length) body += `<div class="note">다른 번역: ${esc(r.altKo.join(" · "))}</div>`;
    if (r.senses?.length) {
      body += `<div class="sec"><h4>영영 풀이 · 예문</h4>${r.senses.map((s) => `
        <div class="sense"><span class="pos">${esc(s.pos)}</span>${esc(s.definition)}
          ${s.example ? `<div class="ex">“${esc(s.example)}”</div>` : ""}
          ${s.synonyms?.length ? `<div class="exko">유의어: ${esc(s.synonyms.join(", "))}</div>` : ""}
        </div>`).join("")}</div>`;
    } else if (/\s/.test(r.word)) {
      body += `<div class="note">여러 단어 표현은 무료 모드에서 번역만 보여드려요.</div>`;
    }
    body += `<div class="sec"><h4>문장 해석</h4><div id="sent-ko"><button class="icon" style="width:auto;padding:0 12px" data-act="translate">이 문장 번역 보기</button></div></div>`;
  }
  if (r.notice) body += `<div class="notice">${esc(r.notice)}</div>`;

  const key = (r.lemma || r.word).toLowerCase();
  const already = savedSet().has(key);
  const listen = sentence ? `<div class="listen">
      <button data-act="say-sentence">🔈 문장 듣기</button>
      <button data-act="say-slow">🐢 천천히</button>
      ${state.lookupS != null ? `<button data-act="read-from">▶ 여기서부터 기사 읽기</button>` : ""}
    </div>` : "";
  const actions = listen + `<div class="actions"><button class="primary" data-act="save" ${already ? "disabled" : ""}>${already ? "✓ 단어장에 있음" : "☆ 단어장에 저장"}</button></div>`;
  popup.innerHTML = head + body + actions;

  popup.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (e.target.closest(".close")) return hidePopup();
    if (act === "say-sentence") speak(sentence, player.rate);
    if (act === "say-slow") speak(sentence, 0.7);
    if (act === "read-from") { hidePopup(); player.play(state.lookupS); }
    if (act === "speak") {
      if (r.audio) new Audio(r.audio).play().catch(() => speak(r.lemma || r.word));
      else speak(r.lemma || r.word);
    }
    if (act === "translate") {
      const box = $("#sent-ko", popup);
      box.innerHTML = `<span class="spinner"></span>`;
      const { ko } = await api("/api/translate", { method: "POST", body: { text: sentence } }).catch(() => ({ ko: null }));
      box.innerHTML = `<div class="sent-ko">${esc(ko || "번역을 가져오지 못했어요.")}</div>`;
    }
    if (act === "save") {
      const btn = e.target.closest("button");
      btn.disabled = true;
      state.words = await api("/api/words", {
        method: "POST",
        body: {
          word: r.word,
          lemma: r.lemma || r.word,
          pos: r.pos || null,
          meaningKo: r.meaningKo || null,
          definition: r.senses?.[0]?.definition || r.contextNote || null,
          sentence,
          source: state.article ? { title: state.article.title, url: state.article.url, site: state.article.site } : null,
        },
      });
      btn.textContent = "✓ 저장했어요";
      updateCount();
      markSaved();
    }
  };
}

// click on a word
$("#article").addEventListener("click", (e) => {
  const sel = window.getSelection();
  if (sel && sel.toString().trim().includes(" ")) return; // handled by mouseup (phrase)
  const w = e.target.closest(".w");
  if (!w) return;
  e.stopPropagation();
  activeEl?.classList.remove("active");
  activeEl = w;
  w.classList.add("active");
  state.lookupS = Number(w.dataset.s);
  lookup(w.textContent.replace(/’/g, "'"), state.sentences[w.dataset.s] || "", w.getBoundingClientRect());
});

// drag-select a phrase (mouse on desktop, long-press + drag handles on phones)
let selTimer = null;
document.addEventListener("selectionchange", () => {
  if (!matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(selTimer);
  selTimer = setTimeout(phraseFromSelection, 700);
});
$("#article").addEventListener("mouseup", () => phraseFromSelection());
function phraseFromSelection() {
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim().replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (!text || text.split(" ").length < 2 || text.split(" ").length > 8) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.parentElement?.closest(".w") || range.startContainer.nextSibling;
    const sIdx = startEl?.dataset?.s;
    activeEl?.classList.remove("active");
    activeEl = null;
    if (!$("#article").contains(range.commonAncestorContainer)) return;
    state.lookupS = sIdx != null ? Number(sIdx) : null;
    lookup(text.replace(/’/g, "'"), sIdx != null ? state.sentences[sIdx] : "", range.getBoundingClientRect());
  }, 0);
}

document.addEventListener("click", (e) => {
  if (!popup.hidden && !popup.contains(e.target) && !e.target.closest(".w")) {
    if (window.getSelection()?.toString().trim()) return;
    hidePopup();
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePopup(); });
matchMedia("(max-width: 640px)").addEventListener("change", hidePopup); // layout switched (rotate/resize)

// ---------- Wordbook ----------
function updateCount() { $("#word-count").textContent = state.words.length; }

function highlight(sentence, word) {
  if (!sentence) return "";
  const s = esc(sentence);
  const w = esc(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`\\b(${w})\\b`, "i"), "<b>$1</b>");
}

function renderWords() {
  const q = $("#wb-filter").value.trim().toLowerCase();
  const list = $("#wordlist");
  const items = state.words.filter((w) => !q || `${w.lemma} ${w.word} ${w.meaningKo}`.toLowerCase().includes(q));
  if (!state.words.length) {
    list.innerHTML = `<div class="empty">아직 저장한 단어가 없어요.<br>기사를 읽다가 단어를 클릭하고 ☆ 단어장에 저장을 눌러 보세요.</div>`;
    return;
  }
  list.innerHTML = items.map((w) => `
    <li>
      <div><span class="wl-word">${esc(w.lemma || w.word)}</span> ${w.pos ? `<span class="pos" style="font-size:12px;color:var(--accent)">${esc(w.pos)}</span>` : ""}</div>
      <button class="del" data-id="${esc(w.id)}" title="삭제">✕</button>
      <div class="wl-ko">${esc(w.meaningKo || "")}</div>
      ${(w.contexts || []).slice(-1).map((c) => `<div class="wl-ctx">${highlight(c, w.word)}</div>`).join("")}
      <div class="wl-src">${w.source ? `${esc(w.source.site)} · ` : ""}${new Date(w.savedAt).toLocaleDateString("ko-KR")}${w.count > 1 ? ` · ${w.count}번 찾아봄` : ""}</div>
    </li>`).join("");
}
$("#wb-filter").addEventListener("input", renderWords);
$("#wordlist").addEventListener("click", async (e) => {
  const id = e.target.closest(".del")?.dataset.id;
  if (!id) return;
  state.words = await api(`/api/words?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  updateCount();
  renderWords();
});

$("#btn-csv").addEventListener("click", () => {
  const rows = [["word", "pos", "meaning_ko", "sentence", "source", "saved_at"]];
  for (const w of state.words) rows.push([w.lemma || w.word, w.pos || "", w.meaningKo || "", (w.contexts || []).slice(-1)[0] || "", w.source?.url || "", w.savedAt]);
  const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `wordbook-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
});

// Flashcards (Leitner boxes: lower box = shown first)
$("#btn-quiz").addEventListener("click", () => {
  const quiz = $("#quiz");
  if (!quiz.hidden) { quiz.hidden = true; return; }
  if (!state.words.length) return;
  const deck = [...state.words].sort((a, b) => (a.box || 0) - (b.box || 0) || Math.random() - 0.5).slice(0, 15);
  let i = 0, flipped = false;
  quiz.hidden = false;
  const draw = () => {
    if (i >= deck.length) {
      quiz.innerHTML = `<div class="q-word">끝! 🎉</div><div class="q-ctx">${deck.length}개 복습했어요.</div><div class="q-btns"><button class="primary" data-q="close">닫기</button></div>`;
      return;
    }
    const w = deck[i];
    const ctx = (w.contexts || []).slice(-1)[0];
    quiz.innerHTML = `
      <div class="q-progress">${i + 1} / ${deck.length}</div>
      <div class="q-word">${esc(w.lemma || w.word)}</div>
      ${ctx ? `<div class="q-ctx">${highlight(ctx, w.word)}</div>` : ""}
      ${flipped ? `<div class="q-ans">${w.pos ? `<span class="pos" style="font-size:13px;color:var(--accent)">${esc(w.pos)}</span> ` : ""}${esc(w.meaningKo || "")}</div>` : ""}
      <div class="q-btns">
        ${flipped
          ? `<button data-q="again">다시 볼래요</button><button class="primary" data-q="know">알아요</button>`
          : `<button class="primary" data-q="flip">뜻 보기</button>`}
      </div>`;
  };
  quiz.onclick = async (e) => {
    const q = e.target.closest("[data-q]")?.dataset.q;
    if (!q) return;
    if (q === "close") { quiz.hidden = true; renderWords(); return; }
    if (q === "flip") { flipped = true; return draw(); }
    const w = deck[i];
    const box = q === "know" ? Math.min((w.box || 0) + 1, 5) : 0;
    state.words = await api("/api/words", { method: "PATCH", body: { id: w.id, box } });
    i++; flipped = false; draw();
  };
  draw();
});

$("#btn-bm").addEventListener("click", async (e) => {
  if (!state.article) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  await toggleBookmark({ url: state.article.url, title: state.article.title, site: state.article.site }).catch((err) => alert(err.message));
  btn.disabled = false;
});

// ---------- Login ----------
function showLogin() {
  document.body.classList.add("locked");
  $("#view-login").hidden = false;
  hidePopup();
  setTimeout(() => $("#login-pw").focus(), 50);
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-err").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#login-pw").value } });
    $("#login-pw").value = "";
    $("#view-login").hidden = true;
    document.body.classList.remove("locked");
    start();
  } catch (err) {
    $("#login-err").textContent = err.message;
  }
});
$("#btn-logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
});

// ---------- Boot ----------
if ("speechSynthesis" in window) player.init();
else document.getElementById("player").hidden = true;
async function start() {
  state.config = await api("/api/config").catch(() => ({}));
  $("#mode-note").textContent = state.config.claude
    ? "사전 모드: Claude — 문장 문맥에 맞는 뜻을 보여드려요."
    : "사전 모드: 무료 (영영사전 + 기계번역). ANTHROPIC_API_KEY를 설정하면 문맥에 맞는 한글 뜻이 나와요.";
  state.words = await api("/api/words").catch(() => []);
  state.bookmarks = await api("/api/bookmarks").catch(() => []);
  updateBookmarkUi();
  updateCount();
  loadFeed(state.cat);
  if (location.hash === "#words") { renderWords(); show("words"); }
  else if (location.hash.startsWith("#read=")) openArticle(decodeURIComponent(location.hash.slice(6)), false);
}

(async () => {
  const session = await api("/api/session").catch(() => ({ authed: false, needsPassword: true }));
  $("#btn-logout").hidden = !session.needsPassword;
  if (!session.authed) return showLogin();
  start();
})();
