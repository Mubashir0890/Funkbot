const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BOT_TOKEN = process.env.BOT_TOKEN;
const JAMENDO_CLIENT_ID = process.env.JAMENDO_CLIENT_ID;
// Render avtomatik beradi: RENDER_EXTERNAL_URL
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;

// --- Ping uchun (cron-job.org shu manzilga so'rov yuboradi) ---
app.get("/health", (req, res) => res.send("ok"));

// --- Funk treklarini Jamendo'dan olish ---
app.get("/api/tracks", async (req, res) => {
  try {
    if (!JAMENDO_CLIENT_ID) {
      return res.status(500).json({ error: "JAMENDO_CLIENT_ID sozlanmagan" });
    }
    const q = (req.query.q || "").toString().trim();
    const params = new URLSearchParams({
      client_id: JAMENDO_CLIENT_ID,
      format: "json",
      limit: "30",
      tags: "funk",
      order: "popularity_month",
      audioformat: "mp32",
      imagesize: "200",
    });
    if (q) params.set("search", q);

    const r = await fetch("https://api.jamendo.com/v3.0/tracks/?" + params);
    const data = await r.json();
    const tracks = (data.results || []).map((t) => ({
      id: t.id,
      name: t.name,
      artist: t.artist_name,
      image: t.image,
      audio: t.audio,
      duration: t.duration,
    }));
    res.json({ tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Treklarni olib bo'lmadi" });
  }
});

// --- Telegram webhook ---
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message;
    if (!msg) return;
    const chatId = msg.chat.id;

    await tg("sendMessage", {
      chat_id: chatId,
      text: "🎷 Funk musiqa olamiga xush kelibsiz!\nPleyerni ochish uchun tugmani bosing.",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🎶 Funk pleyerni ochish", web_app: { url: BASE_URL } }],
        ],
      },
    });
  } catch (e) {
    console.error("webhook xato:", e);
  }
});

app.listen(PORT, async () => {
  console.log("Server ishga tushdi, port:", PORT);
  if (BOT_TOKEN && BASE_URL) {
    const r = await tg("setWebhook", { url: `${BASE_URL}/webhook` });
    console.log("Webhook:", JSON.stringify(r));
    // Menyu tugmasi (chap pastdagi) ham Mini App'ni ochadi
    await tg("setChatMenuButton", {
      menu_button: { type: "web_app", text: "Funk 🎷", web_app: { url: BASE_URL } },
    });
  } else {
    console.log("BOT_TOKEN yoki BASE_URL yo'q: webhook o'rnatilmadi");
  }
});
