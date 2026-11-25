const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const BOT_TOKEN = process.env.BOT_TOKEN || "";
// Render avtomatik beradi: RENDER_EXTERNAL_URL
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const PORT = process.env.PORT || 3000;
// Audio qo'sha oladigan odamlar (Telegram ID, vergul bilan ajratiladi)
const ADMIN_IDS = (process.env.ADMIN_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
// Ixtiyoriy: ma'lumotlar Render qayta ishga tushganda o'chib ketmasligi uchun GitHub Gist
const GIST_ID = process.env.GIST_ID || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const USE_GIST = !!(GIST_ID && GITHUB_TOKEN);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const MAX_BYTES = 20 * 1024 * 1024; // Telegram botlar 20 MB gacha faylni yuklab olishi mumkin
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 32)
  : "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const isAdmin = (id) => ADMIN_IDS.includes(String(id));

/* ------------------------------------------------------------------ *
 *  Kolleksiya (treklar ro'yxati)
 *  Audio faylning o'zi Telegram'da turadi, bizda faqat file_id saqlanadi.
 * ------------------------------------------------------------------ */
let library = []; // [{id, fileId, thumbId, title, artist, duration, mime, size, addedAt}]
let gistReady = !USE_GIST;
let saveChain = Promise.resolve();

function readLocal() {
  try {
    const a = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function writeLocal() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(library));
  } catch (e) {
    console.error("data.json yozilmadi:", e.message);
  }
}

async function gh(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "funk-miniapp",
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}
async function gistRead() {
  const g = await gh("GET", `https://api.github.com/gists/${GIST_ID}`);
  const f = g.files && g.files["tracks.json"];
  if (!f) throw new Error("Gist ichida tracks.json fayli yo'q");
  let content = f.content;
  if (f.truncated) content = await (await fetch(f.raw_url)).text();
  const arr = JSON.parse(content || "[]");
  return Array.isArray(arr) ? arr : [];
}
function mergeRemote(remote) {
  const map = new Map(remote.map((t) => [t.id, t]));
  for (const t of library) map.set(t.id, t);
  library = [...map.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

async function loadLibrary() {
  library = readLocal();
  if (!USE_GIST) return;
  for (let i = 0; i < 3; i++) {
    try {
      library = await gistRead();
      gistReady = true;
      console.log("Kolleksiya Gist'dan o'qildi");
      return;
    } catch (e) {
      console.error("Gist o'qilmadi:", e.message);
      await sleep(2000);
    }
  }
  // O'qib bo'lmasa, mavjud ma'lumotni ustidan yozib yubormaslik uchun Gist'ga yozmaymiz
  console.error("Gist hozircha o'qilmayapti, har daqiqada qayta uriniladi");
  const timer = setInterval(async () => {
    try {
      mergeRemote(await gistRead());
      gistReady = true;
      clearInterval(timer);
      await saveLibrary();
    } catch {}
  }, 60000);
}

function saveLibrary() {
  saveChain = saveChain.then(async () => {
    writeLocal();
    if (USE_GIST && gistReady) {
      try {
        await gh("PATCH", `https://api.github.com/gists/${GIST_ID}`, {
          files: { "tracks.json": { content: JSON.stringify(library) } },
        });
      } catch (e) {
        console.error("Gist yozilmadi:", e.message);
      }
    }
  });
  return saveChain;
}

/* ------------------------------------------------------------------ *
 *  Telegram yordamchilari
 * ------------------------------------------------------------------ */
async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

const pathCache = new Map(); // fileId -> {p, exp}
async function filePath(fileId, force) {
  const c = pathCache.get(fileId);
  if (!force && c && c.exp > Date.now()) return c.p;
  const r = await tg("getFile", { file_id: fileId });
  if (!r.ok || !r.result || !r.result.file_path) throw new Error(r.description || "getFile xato");
  pathCache.set(fileId, { p: r.result.file_path, exp: Date.now() + 50 * 60 * 1000 });
  return r.result.file_path;
}

// Telegram faylini brauzerga uzatish (Range bilan, ya'ni surib o'tkazish ishlaydi)
async function proxy(req, res, fileId, mime, maxAge) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let up;
    try {
      const p = await filePath(fileId, attempt > 0);
      const headers = {};
      if (req.headers.range) headers.Range = req.headers.range;
      up = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${p}`, { headers });
    } catch {
      if (attempt === 0) continue;
      return res.sendStatus(502);
    }
    if (up.status === 416) return res.sendStatus(416);
    if (!up.ok) {
      if (attempt === 0) continue;
      return res.sendStatus(up.status === 404 ? 404 : 502);
    }
    res.status(up.status);
    for (const h of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", `public, max-age=${maxAge}`);
    const body = Readable.fromWeb(up.body);
    req.on("close", () => body.destroy());
    body.on("error", () => res.end());
    body.pipe(res);
    return;
  }
}

/* ------------------------------------------------------------------ *
 *  API
 * ------------------------------------------------------------------ */
app.get("/health", (req, res) => res.send("ok"));

app.get("/api/tracks", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    tracks: library.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      duration: t.duration,
      cover: t.thumbId ? `/cover/${encodeURIComponent(t.id)}` : null,
      audio: `/stream/${encodeURIComponent(t.id)}`,
    })),
  });
});

app.get("/stream/:id", (req, res) => {
  const t = library.find((x) => x.id === req.params.id);
  if (!t) return res.sendStatus(404);
  proxy(req, res, t.fileId, t.mime || "audio/mpeg", 3600);
});

app.get("/cover/:id", (req, res) => {
  const t = library.find((x) => x.id === req.params.id);
  if (!t || !t.thumbId) return res.sendStatus(404);
  proxy(req, res, t.thumbId, "image/jpeg", 86400);
});

/* ------------------------------------------------------------------ *
 *  Bot
 * ------------------------------------------------------------------ */
const openBtn = () => ({ text: "🎧 Pleyerni ochish", web_app: { url: BASE_URL } });

function nameNoExt(n) {
  return (n || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_+/g, " ").trim();
}
function trackFromAudio(a) {
  const thumb = a.thumbnail || a.thumb;
  return {
    id: a.file_unique_id,
    fileId: a.file_id,
    thumbId: thumb ? thumb.file_id : "",
    title: (a.title || nameNoExt(a.file_name) || "Nomsiz trek").slice(0, 120),
    artist: (a.performer || "").slice(0, 120),
    duration: a.duration || 0,
    mime: a.mime_type && /^audio\//.test(a.mime_type) ? a.mime_type : "audio/mpeg",
    size: a.file_size || 0,
    addedAt: Date.now(),
  };
}

function listView() {
  if (!library.length) {
    return {
      text: "Kolleksiya hozircha bo'sh. Menga audio fayl yuboring, u pleyerda paydo bo'ladi.",
      reply_markup: { inline_keyboard: [[openBtn()]] },
    };
  }
  const shown = library.slice(0, 40);
  const text =
    `<b>Kolleksiya: ${library.length} ta trek</b>\n\n` +
    shown.map((t, i) => `${i + 1}. ${esc(t.title)}${t.artist ? " - " + esc(t.artist) : ""}`).join("\n") +
    (library.length > shown.length ? `\n\n...va yana ${library.length - shown.length} ta` : "");
  const rows = [];
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(shown.slice(i, i + 5).map((t, j) => ({ text: `🗑 ${i + j + 1}`, callback_data: `dl:${t.id}` })));
  }
  rows.push([openBtn()]);
  return { text, reply_markup: { inline_keyboard: rows } };
}

function adminHelp(uid) {
  return ADMIN_IDS.length
    ? "Audio qo'shish faqat admin uchun."
    : `Hozircha admin belgilanmagan.\nSizning ID raqamingiz: <code>${uid}</code>\nRender → Environment bo'limida <code>ADMIN_ID</code> nomi bilan shu raqamni kiriting.`;
}

async function onMessage(m) {
  if (!m.chat || m.chat.type !== "private") return;
  const chatId = m.chat.id;
  const uid = m.from && m.from.id;
  const text = (m.text || "").trim();
  const say = (t, extra) => tg("sendMessage", { chat_id: chatId, text: t, parse_mode: "HTML", ...extra });

  const audio = m.audio || (m.document && /^audio\//.test(m.document.mime_type || "") ? m.document : null);
  if (audio) {
    if (!isAdmin(uid)) return say(adminHelp(uid));
    if (audio.file_size && audio.file_size > MAX_BYTES) {
      return say("Bu fayl 20 MB dan katta. Telegram botlar bunday faylni yuklab ola olmaydi, kichikroq (masalan 128-192 kbps) variantini yuboring.");
    }
    const t = trackFromAudio(audio);
    const i = library.findIndex((x) => x.id === t.id);
    const existed = i >= 0;
    if (existed) library[i] = { ...t, addedAt: library[i].addedAt };
    else library.unshift(t);
    await saveLibrary();
    return say(
      `${existed ? "🔄 Yangilandi" : "✅ Qo'shildi"}: <b>${esc(t.title)}</b>${t.artist ? "\n" + esc(t.artist) : ""}\nKolleksiyada ${library.length} ta trek.`,
      { reply_markup: { inline_keyboard: [[openBtn()], [{ text: "🗑 O'chirish", callback_data: `del:${t.id}` }]] } }
    );
  }

  if (text.startsWith("/id")) return say(`Sizning ID raqamingiz: <code>${uid}</code>`);
  if (text.startsWith("/list")) {
    if (!isAdmin(uid)) return say(adminHelp(uid));
    const v = listView();
    return say(v.text, { reply_markup: v.reply_markup });
  }
  if (text.startsWith("/start") || text.startsWith("/help") || text) {
    const lines = ["❄️ <b>Funk pleyer</b>", "Treklarni tanlab eshitish uchun pastdagi tugmani bosing."];
    if (isAdmin(uid)) lines.push("Treklar qo'shish uchun menga audio fayl yuboring. Ro'yxatni ko'rish va o'chirish: /list");
    else if (!ADMIN_IDS.length) lines.push("\n" + adminHelp(uid));
    return say(lines.join("\n"), { reply_markup: { inline_keyboard: [[openBtn()]] } });
  }
}

async function onCallback(q) {
  const msg = q.message;
  if (!isAdmin(q.from.id)) {
    return tg("answerCallbackQuery", { callback_query_id: q.id, text: "Faqat admin o'chira oladi", show_alert: true });
  }
  const m = /^(del|dl):(.+)$/.exec(q.data || "");
  if (!m) return tg("answerCallbackQuery", { callback_query_id: q.id });
  const idx = library.findIndex((t) => t.id === m[2]);
  let removed = null;
  if (idx >= 0) {
    removed = library.splice(idx, 1)[0];
    await saveLibrary();
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: removed ? "O'chirildi" : "Topilmadi" });
  if (!msg) return;
  if (m[1] === "dl") {
    const v = listView();
    await tg("editMessageText", {
      chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", text: v.text, reply_markup: v.reply_markup,
    });
  } else {
    await tg("editMessageText", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      parse_mode: "HTML",
      text: removed ? `🗑 O'chirildi: <b>${esc(removed.title)}</b>` : "Bu trek avval o'chirilgan.",
      reply_markup: { inline_keyboard: [] },
    });
  }
}

app.post("/webhook", (req, res) => {
  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  const u = req.body || {};
  const job = u.callback_query ? onCallback(u.callback_query) : u.message ? onMessage(u.message) : null;
  if (job) job.catch((e) => console.error("webhook xato:", e));
});

app.listen(PORT, async () => {
  console.log("Server ishga tushdi, port:", PORT);
  await loadLibrary();
  console.log(`Kolleksiya: ${library.length} ta trek. Adminlar: ${ADMIN_IDS.length || "belgilanmagan"}`);
  if (!USE_GIST) console.log("GIST_ID/GITHUB_TOKEN yo'q: Render qayta ishga tushganda ro'yxat o'chib ketadi");
  if (BOT_TOKEN && BASE_URL) {
    const r = await tg("setWebhook", {
      url: `${BASE_URL}/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });
    console.log("Webhook:", JSON.stringify(r));
    await tg("setChatMenuButton", {
      menu_button: { type: "web_app", text: "Funk", web_app: { url: BASE_URL } },
    });
    await tg("setMyCommands", {
      commands: [
        { command: "start", description: "Pleyerni ochish" },
        { command: "list", description: "Kolleksiya va o'chirish (admin)" },
        { command: "id", description: "Mening ID raqamim" },
      ],
    });
  } else {
    console.log("BOT_TOKEN yoki BASE_URL yo'q: webhook o'rnatilmadi");
  }
});
