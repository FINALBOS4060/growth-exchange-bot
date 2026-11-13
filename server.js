// server/index.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

// src/logic/growthLogic.ts
function buildFifoQueueWithDeferred(existingQueue, deferredTasks, newIncomingTasks) {
  const processedDeferred = deferredTasks.map((t) => ({
    ...t,
    isDeferred: true
  }));
  return [...existingQueue, ...processedDeferred, ...newIncomingTasks];
}
function processTaskBatchVerification(batchTasks, verificationLookup) {
  const verifiedTasks = [];
  const apiErrorTasks = [];
  const deferredTasks = [];
  let earnedCredits = 0;
  for (const task of batchTasks) {
    const result = verificationLookup[task.id];
    if (result && result.verified) {
      verifiedTasks.push({
        ...task,
        status: "VERIFIED"
      });
      earnedCredits += task.rewardCredits;
    } else if (result && result.isApiError) {
      apiErrorTasks.push({
        ...task,
        status: "CHECK_ERROR"
      });
      deferredTasks.push({
        ...task,
        status: "RECHECK"
      });
    } else {
      deferredTasks.push({
        ...task,
        status: "PENDING"
      });
    }
  }
  return {
    verifiedTasks,
    apiErrorTasks,
    deferredTasks,
    earnedCredits
  };
}
function calculateOrderAffordability(credits, requestedQuantity, unitCost) {
  if (requestedQuantity <= 0 || unitCost <= 0) {
    return { canAfford: false, totalCost: 0, shortage: 0 };
  }
  const totalCost = requestedQuantity * unitCost;
  const shortage = Math.max(0, totalCost - credits.available);
  return {
    canAfford: credits.available >= totalCost,
    totalCost,
    shortage
  };
}
function calculateRefundAmount(order) {
  if (order.status === "completed" || order.status === "cancelled") {
    return { refundableUnits: 0, refundCredits: 0 };
  }
  const unfulfilledQuantity = Math.max(
    0,
    order.requestedQuantity - order.verifiedQuantity - order.cancelledQuantity
  );
  // Bepul birliklar (admin grant / referal bonusi) uchun pul qaytarilmaydi.
  const paidUnits = Math.max(0, unfulfilledQuantity - Math.min(unfulfilledQuantity, Number(order.freeUnits) || 0));
  const refundCredits = paidUnits * order.unitCost;
  return {
    refundableUnits: unfulfilledQuantity,
    refundCredits
  };
}
function qualifyReferral(referral, hasCompletedVerifiedTask, bonusAmount = 300) {
  if (referral.bonusIssued) {
    return { isEligible: false, rewardCredits: 0 };
  }
  if (referral.isRegistered && hasCompletedVerifiedTask) {
    return {
      isEligible: true,
      rewardCredits: bonusAmount
    };
  }
  return {
    isEligible: false,
    rewardCredits: 0
  };
}
function generateControllerCode() {
  return Math.floor(1e5 + Math.random() * 9e5).toString();
}
function validateControllerCode(request, enteredCode, currentTime = /* @__PURE__ */ new Date()) {
  if (request.status !== "pending") {
    return { valid: false, reason: "Ushbu so'rov allaqachon yakunlangan yoki bekor qilingan." };
  }
  const expiresAt = new Date(request.expiresAt);
  if (currentTime > expiresAt) {
    return { valid: false, reason: "Kod muddati (5 daqiqa) tugagan. Yangi kod so'rang." };
  }
  if (request.code !== enteredCode.trim()) {
    return { valid: false, reason: "Kiritilgan 6 xonali kod noto'g'ri." };
  }
  return { valid: true };
}

// server/index.ts
var ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === void 0) process.env[m[1]] = m[2];
  }
} catch {
}
var TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
var API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
var ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
var ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
var DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
var DATABASE_URL = (process.env.DATABASE_URL || "").trim();
var PORT = Number(process.env.PORT || 3e3);
var HOST = process.env.IP || "0.0.0.0";
var defaultSettings = () => ({
  creditRewardTelegram: 100,
  creditRewardInstagram: 100,
  creditRewardReferral: 300,
  // 1 obunachi narxi (buyurtmada). 1 kredit = 1 obunachi.
  creditPerSubscriber: 1,
  // Yangi foydalanuvchi o'z kanalini ulaganda bir martalik sovg'a
  creditRewardChannelLink: 10,
  // Ro'yxatdan o'tish bonusi o'chirilgan (0) — sovg'a kanal ulanganda beriladi
  creditRewardSignup: 0,
  isInstagramEnabled: false,
  // Instagram'ni tekshirib bo'lmaydi (o'zi tasdiqlaydi) — admin /igon bilan yoqadi
  isBotPaused: false,
  isTelegramPaused: false,
  areOrdersFrozen: false,
  hourlyNotificationsEnabled: true,
  telegramBotToken: "",
  botUsername: "",
  botDisplayName: "Obuna 2X bot",
  botId: "",
  webhookUrl: "",
  webhookStatus: "polling",
  // Bir nechta bot tokeni bitta bazaga ulanadi (asosiy bot + ishchi botlar).
  // Har bir yozuv: { id, token, role: "main"|"worker", enabled, username, displayName, offset, ... }
  bots: [],
  // News bot (@Dunyo_Yangiliklari_Texno_bot) — /news sahifasidan boshqariladi
  news: {
    enabled: true,
    channel: "@Dunyo_Yangiliklari_Texno",
    times: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-4-hydrogen", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.1-flash-lite-preview", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-2.5-flash", "gemini-2.5-flash-lite", "antigravity-preview-latest"],
    apiKey: "",
    sent: [],
    history: [],
    lastPostAt: "",
    lastStatus: "",
    lastModel: "",
    lastError: ""
  }
});
var db = {
  seq: 0,
  offset: 0,
  users: {},
  channels: [],
  igProfiles: [],
  orders: [],
  tasks: [],
  transactions: [],
  complaints: [],
  referrals: [],
  sponsors: [],
  ctlRequests: [],
  verifyLog: [],
  adminUsers: [],
  auditLog: [],
  appeals: [],
  settings: defaultSettings(),
  lastExportAt: 0,
  lastBackupAt: 0,
  moderationFlags: [],
  lastHour: 0
};
function applyLoadedState(loaded) {
  if (!loaded || typeof loaded !== "object") return false;
  db = { ...db, ...loaded, settings: { ...defaultSettings(), ...loaded.settings || {} } };
  return true;
}
function loadFile() {
  try {
    return applyLoadedState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch {
    return false;
  }
}
db.settings.telegramBotToken = "";
// Saqlash qatlami: DATABASE_URL bo'lsa Postgres (Render'da fayl saqlanmaydi),
// bo'lmasa lokal fayl. Sxema bitta qatorli JSONB jadval — mantiq o'zgarmaydi.
var STORAGE = DATABASE_URL ? "postgres" : "file";
var dbPool = null;
var dbChain = Promise.resolve();
var saveTimer = null;
function pgConfig(url) {
  const u = new URL(url);
  const cfg = { connectionString: url, max: 2, connectionTimeoutMillis: 1e4, idleTimeoutMillis: 3e4 };
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (!isLocal && u.searchParams.get("sslmode") !== "disable") cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}
function persist() {
  if (!dbPool) return Promise.resolve();
  const payload = JSON.stringify(db);
  dbChain = dbChain.then(() => dbPool.query(
    "INSERT INTO app_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
    [payload]
  )).catch((e) => {
    console.error("Postgres saqlash xatosi:", e.message);
  });
  return dbChain;
}
// --- Kunlik zaxira nusxa (spec §18, §19) ---
async function backupNow(reason) {
  try {
    const payload = JSON.stringify(db);
    const stamp = new Date(Date.now() + 5 * 36e5).toISOString().replace(/[:.]/g, "-").slice(0, 16);
    if (dbPool) {
      await dbPool.query("CREATE TABLE IF NOT EXISTS app_backup (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), reason text, size integer, data jsonb NOT NULL)");
      await dbPool.query("INSERT INTO app_backup (reason, size, data) VALUES ($1, $2, $3::jsonb)", [String(reason || "kunlik"), payload.length, payload]);
      await dbPool.query("DELETE FROM app_backup WHERE created_at < now() - interval '14 days'");
      console.log("Zaxira nusxa olindi (postgres, " + Math.round(payload.length / 1024) + " KB)");
    } else {
      const dir = path.join(path.dirname(DATA_FILE), "backups");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "state-" + stamp + ".json"), payload);
      const files = fs.readdirSync(dir).filter((f) => f.startsWith("state-")).sort();
      for (const f of files.slice(0, Math.max(0, files.length - 7))) fs.unlinkSync(path.join(dir, f));
      console.log("Zaxira nusxa olindi (fayl, " + Math.round(payload.length / 1024) + " KB)");
    }
    db.lastBackupAt = Date.now();
    save();
    return true;
  } catch (e) {
    console.error("Zaxira nusxa xatosi:", e.message);
    return false;
  }
}
async function listBackups() {
  if (!dbPool) {
    const dir = path.join(path.dirname(DATA_FILE), "backups");
    try {
      return fs.readdirSync(dir).filter((f) => f.startsWith("state-")).sort().reverse().slice(0, 20).map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { at: st.mtime.toISOString(), sizeKb: Math.round(st.size / 1024), name: f };
      });
    } catch {
      return [];
    }
  }
  try {
    const r = await dbPool.query("SELECT created_at, size, reason FROM app_backup ORDER BY created_at DESC LIMIT 20");
    return r.rows.map((x) => ({ at: x.created_at, sizeKb: Math.round((x.size || 0) / 1024), reason: x.reason }));
  } catch {
    return [];
  }
}
// Har soatda bir marta: kunlik zaxira nusxa (o'sha kuni olinmagan bo'lsa).
function startBackupJob() {
  const run = async () => {
    const t = uzbNow();
    const dayStart = Date.parse(t.date + "T00:00:00Z");
    if (db.lastBackupAt && db.lastBackupAt >= dayStart) return;
    await backupNow("kunlik");
  };
  setInterval(run, 36e5);
  setTimeout(run, 6e4);
}
async function openStore() {
  if (!DATABASE_URL) {
    loadFile();
    console.log("Saqlash: fayl rejimi (" + DATA_FILE + ")");
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const pgMod = await import("pg");
      const pg = pgMod.default || pgMod;
      dbPool = new pg.Pool(pgConfig(DATABASE_URL));
      dbPool.on("error", (e) => console.error("Postgres pool xatosi:", e.message));
      await dbPool.query("CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
      const r = await dbPool.query("SELECT data FROM app_state WHERE id = 1");
      if (r.rows.length) {
        applyLoadedState(r.rows[0].data);
        console.log("Saqlash: Postgres (mavjud holat yuklandi)");
      } else {
        loadFile();
        await persist();
        console.log("Saqlash: Postgres (yangi jadval, boshlang'ich holat yozildi)");
      }
      STORAGE = "postgres";
      return;
    } catch (e) {
      if (dbPool) {
        try {
          await dbPool.end();
        } catch {
        }
        dbPool = null;
      }
      console.error(`Postgres ulanmadi (urinish ${attempt}/5):`, e.message);
      await new Promise((res) => setTimeout(res, attempt * 2e3));
    }
  }
  STORAGE = "file";
  console.error("DIQQAT: Postgres ishlamadi - vaqtincha fayl rejimi. Render'da bu ma'lumotlar restartda yo'qoladi!");
  loadFile();
}
function saveNow() {
  if (dbPool) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("Faylga saqlash xatosi", e);
  }
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
    persist();
  }, 500);
}
var S = () => db.settings;
// 1 obunachi necha kredit turadi (1:1 qoidasi).
function perSub() {
  const n = Number(S().creditPerSubscriber);
  return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
}
var nowStr = () => (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 16);
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
var nid = (p) => `${p}-${Date.now().toString(36)}${(++db.seq).toString(36)}`;
var isAdmin = (id) => ADMIN_IDS.includes(id);
// ---------------------------------------------------------------------------
// Bir nechta bot, bitta baza.
// @Obuna_2X_bot va unga qo'shilgan ishchi botlar bitta db obyektini, bitta
// foydalanuvchilar/kanallar/buyurtmalar to'plamini ishlatadi — farqi faqat
// Telegram'ga qaysi token orqali ulanishida.
// Joriy bot AsyncLocalStorage orqali uzatiladi: bir vaqtda ishlayotgan ikki
// botning so'rovlari bir-biriga aralashmaydi.
var botCtx = new AsyncLocalStorage();
function botsList() {
  const s = S();
  if (!Array.isArray(s.bots)) s.bots = [];
  return s.bots;
}
function primaryBot() {
  const l = botsList();
  return l.find((b) => b.id === "bot-main") || l[0] || null;
}
function botById(id) {
  return botsList().find((b) => b.id === id) || null;
}
function botName(b) {
  return b ? b.username ? "@" + b.username : b.displayName || (b.role === "main" ? "Asosiy bot" : "Ishchi bot") : "—";
}
function curBot() {
  return botCtx.getStore() || primaryBot() || { token: TOKEN };
}
async function tgWith(bot, method, params = {}, timeoutMs = 35e3) {
  const token = (bot && bot.token) || "";
  if (!token) return { ok: false, description: "Bot tokeni yo'q" };
  try {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e), network: true };
  }
}
var tg = (method, params = {}, timeoutMs = 35e3) => tgWith(curBot(), method, params, timeoutMs);
function msgExtra(extra = {}) {
  return { parse_mode: "HTML", disable_web_page_preview: true, ...extra };
}
function sendWith(bot, chat, text, extra = {}) {
  return tgWith(bot, "sendMessage", { chat_id: chat, text, ...msgExtra(extra) }, 35e3);
}
var send = (chat, text, extra = {}) => sendWith(curBot(), chat, text, extra);
var notify = (u, text, extra = {}) => {
  if (!u) return Promise.resolve();
  const b = botCtx.getStore() || (u.botId ? botById(u.botId) : null) || primaryBot();
  return sendWith(b, u.chatId, text, extra);
};
async function checkMember(chat, userId) {
  const r = await tg("getChatMember", { chat_id: chat, user_id: userId }, 15e3);
  if (r.ok) {
    const st = r.result.status;
    if (["member", "administrator", "creator"].includes(st)) return "member";
    if (st === "restricted") return r.result.is_member ? "member" : "not_member";
    return "not_member";
  }
  if (/user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return "not_member";
  return "error";
}
// --- Ko'p tillilik (spec §5) ---
// Barcha foydalanuvchi matnlari shu katalogda. Yangi matn qo'shsangiz uch tilga ham yozing.
var STR = {
  uz: {
    b_channels: "📢 Kanallarim",
    b_tasks: "📋 Vazifalar",
    b_orders: "🛒 Buyurtmalarim",
    b_instagram: "📸 Instagram",
    b_referrals: "👥 Referal tizimi",
    b_stats: "📊 Statistika",
    b_help: "🛟 Yordam",
    b_settings: "⚙️ Sozlamalar",
    ig_add: "➕ Profil qo‘shish",
    ig_tasks: "📋 Instagram vazifalar",
    verify_btn: "✅ Tekshirish",
    cancel_yes: "Ha, bekor qilish",
    cancel_no: "Yo‘q",
    disc_yes: "Ha, uzish",
    disc_no: "Yo‘q",
    start_new: "Assalomu alaykum, {name}! 👋\n\nBotga xush kelibsiz! Quyida qisqa yo‘riqnoma.",
    start_back: "Assalomu alaykum, {name}! 🚀\n\nBu Telegram va Instagram o‘zaro o‘sish platformasi.\nBoshqa kanallarga obuna bo‘lib kredit ishlang va o‘z kanalingizga obunachi buyurtma qiling.\n\n{balance}",
    guide: "📖 <b>Bot qanday ishlaydi</b>\n\nBot ikki ish uchun kerak:\n1) Boshqa kanallarga obuna bo‘lib <b>kredit</b> ishlaysiz\n2) Shu kredit bilan o‘z kanalingizga <b>obunachi</b> yig‘asiz\n\n💰 <b>Kredit</b> — bot ichidagi hisob birligi. 1 obunachi = {price} kredit. Pul emas.\n\n1️⃣ “📋 Vazifalar” → kanalga obuna bo‘ling → “✅ Obuna bo‘ldim”. Bot o‘zi tekshiradi, har biri uchun +{reward} kredit.\n2️⃣ Kanalingizni ulash: botni kanalga <b>administrator</b> qiling → “📢 Kanallarim” → “➕ Kanal qo‘shish” → manzilni yuboring.{bonus}\n3️⃣ “📢 Kanallarim” → kanal → nechta obunachi kerakligini yozing → tasdiqlang.\n4️⃣ “👥 Referal tizimi” — do‘stingiz bitta vazifa bajarsa, bonus sizga: +{ref} kredit.\n\nBatafsil: “🛟 Yordam”.",
    bonus_line: "\nBirinchi kanal uchun +{bonus} kredit sovg‘a.",
    bal: "💰 Balans: <b>{a}</b> kredit  •  🔒 Band: {r} kredit",
    tasks_none: "📋 <b>Hozircha vazifa yo‘q</b>\n\nSababi: hozir hech kim obunachi buyurtma qilmagan. Keyinroq yana urinib ko‘ring.\n\n{balance}",
    tasks_title: "📋 <b>Vazifalar: {n} ta kanal</b>\n\n1. Havoladan kanalga kiring\n2. Obuna bo‘ling\n3. “✅ Obuna bo‘ldim” tugmasini bosing — bot tekshiradi\n\nMuammo bo‘lsa: kanal yonidagi <b>⚠️N</b> tugmasi.\n\nHar bir obuna uchun: <b>+{reward} kredit</b>\n\n",
    tasks_btn_done: "✅ Obuna bo‘ldim",
    tasks_btn_refresh: "🔄 Yangilash",
    ch_title: "📢 <b>Kanallaringiz: {n} ta</b>\n\n{list}\n\n{balance}",
    ch_none: "Hali kanal ulanmagan. Ulash uchun:\n1. Botni kanalingizga <b>administrator</b> qiling\n2. “➕ Kanal qo‘shish” tugmasini bosing\n3. Kanal manzilini yuboring (masalan: @kanal_nomi)",
    ch_add: "➕ Kanal qo‘shish",
    ch_code_in: "🔑 Kod kiritish",
    ch_back: "⬅️ Orqaga",
    ch_buy: "🛒 Buyurtma berish",
    ch_unlink: "🗑 Kanalni uzish",
    ch_controller: "nazoratchi",
    ord_title: "🛒 <b>Buyurtmalaringiz: {n} ta</b>\n{balance}\n\n{list}",
    ord_none: "Hali buyurtma bermagansiz.\n\n“📢 Kanallarim” → kanalingizni tanlang → nechta obunachi kerakligini yozing.",
    ord_qty: "🛒 <b>{title}</b>\n\nNechta obunachi kerakligini yozing (10–10000).\n• Narx: {unit} kredit / 1 ta\n• {balance}\n• Shu kredit bilan ko‘pi bilan: {max} ta\n\nBekor qilish: /cancel",
    ord_summary: "📝 <b>Buyurtma xulosasi</b>\n\n• {title}\n• Miqdor: <b>{qty}</b> ta\n• Narx: {unit} × {qty} = <b>{total}</b> kredit\n• Buyurtmadan keyingi balans: {left} kredit\n\nTasdiqlasangiz kredit band qilinadi.",
    ord_yes: "✅ Tasdiqlash",
    ord_no: "❌ Bekor qilish",
    ord_created: "🛒 <b>Buyurtma qabul qilindi!</b>\n\n• {title}\n• Miqdor: {qty}\n• Narx: {total} kredit (band qilindi)\n\nObunachilar navbat bilan qo‘shiladi.",
    ord_cancelled: "❌ Buyurtma bekor qilindi. Kredit band qilinmadi.",
    ord_short: "❌ Kredit yetmayapti.\n\nKerak: {need} kredit\nSizda: {have} kredit\nYetmayapti: {lack} kredit\n\n📋 Vazifalarni bajarib kredit to‘plang.",
    stats_title: "📊 <b>Statistika</b>\n\n👤 {name}\n🆔 {id}\n\n💰 Balans: <b>{a}</b> kredit — ishlatsa bo‘ladigan\n🔒 Band: {r} kredit — faol buyurtmaga band\n💸 Sarflangan: {s} kredit\n↩️ Qaytarilgan: {ref} kredit\n✅ Bajarilgan vazifalar: {done} ta\n📢 Kanallar: {ch} ta\n🛒 Faol buyurtmalar: {ord} ta",
    ref_title: "👥 <b>Referal tizimi</b>\n\nDo‘stingiz shu havola bilan kirib <b>bitta vazifa</b> bajarsa, sizga <b>+{reward} kredit</b> bonus beriladi.\nBonus kanalingizga obunachi sifatida yo‘naltiriladi (1 obunachi = {unit} kredit).\n\nTaklif qilganlar: {n} ta • Yo‘naltirilgan bonuslar: {paid} ta{pending}\n\n🔗 Havolangiz:\nhttps://t.me/{bot}?start={code}",
    ref_pending: "\n\n🎁 Yo‘naltirilmagan bonus: <b>{amount} kredit</b>{hint}",
    ref_alloc: "🎁 Bonusni kanalga yo‘naltirish",
    set_title: "⚙️ <b>Sozlamalar</b>\n\n🌐 Til: {lang}\n\n🔔 <b>Bildirishnomalar</b>\nSoatlik hisobot: {hourly}\n• Yangi obunachilar: {sub}\n• Referal bonuslar: {ref}\n• Buyurtma holati: {ord}\n• Texnik xabarlar: {tech}\n\nKerakli bo‘limni bosing — yoqiladi yoki o‘chadi.",
    set_hourly_on: "🔕 Hisobotni o‘chirish",
    set_hourly_off: "🔔 Hisobotni yoqish",
    set_title: "⚙️ <b>Sozlamalar</b>\n\n👤 {name} · ID: <code>{id}</code>\n\n🌐 Til: {lang}\n💰 Balans: <b>{bal}</b> kredit\n\n🔔 <b>Bildirishnomalar</b>\n• Soatlik hisobot: {hourly}\n• Yangi obunachilar: {sub}\n• Referal bonuslar: {ref}\n• Buyurtma holati: {ord}\n• Texnik xabarlar: {tech}\n\nKerakli tugmani bosing — darhol saqlanadi.",
    set_rates_btn: "📊 Kredit qoidalari",
    set_info_btn: "👤 Ma’lumotlarim",
    set_support_btn: "🛟 Adminga murojaat",
    set_all_on: "🔔 Hammasini yoqish",
    set_all_off: "🔕 Hammasini o‘chirish",
    set_back: "⬅️ Orqaga",
    frozen: "🧊 Buyurtmalar vaqtincha muzlatilgan. Keyinroq urinib ko‘ring.",
    ord_qty_range: "Son 10 dan 10 000 gacha bo‘lishi kerak. Qaytadan yozing:",
    my_tickets_btn: "🗂 Murojaatlarim",
    my_tickets_title: "🗂 <b>Murojaatlarim</b>\n\n{tickets}",
    my_tickets_none: "Hali murojaat yubormaganmisiz.\nYuborish: Sozlamalar → “🛟 Adminga murojaat”.",
    my_tickets_item: "• <b>{ticket}</b> · {status}\n  {category}\n  {date}{answer}",
    my_tickets_answer: "\n  💬 Javob: {text}",
    st_new: "🆕 yangi",
    st_review: "🔍 ko‘rilmoqda",
    st_answered: "✅ javob berilgan",
    st_closed: "🔒 yopilgan",
    set_rates: "📊 <b>Kredit qoidalari</b>\n\n• 1 tasdiqlangan obuna = <b>{tg}</b> kredit\n• 1 obunachi buyurtmasi = <b>{per}</b> kredit\n• 1 faol referal = <b>{ref}</b> kredit\n• Birinchi kanal uchun sovg‘a = <b>{link}</b> kredit\n• Ro‘yxatdan o‘tish sovg‘asi = <b>{signup}</b> kredit\n\nKredit — pul emas, bot ichidagi hisob birligi. Qiymatlarni admin o‘zgartiradi.",
    set_info: "👤 <b>Ma’lumotlarim</b>\n\nIsm: {name}\nID: <code>{id}</code>\nUsername: {username}\nTil: {lang}\nRo‘yxatdan: {date}\n\n💰 Balans: <b>{a}</b> · 🔒 Band: {r}\n💸 Sarf: {s} · ↩️ Qaytim: {ref}\n\n📢 Kanallar: {ch} · 📸 Instagram: {ig}\n✅ Vazifalar: {done} · 🛒 Faol buyurtma: {ord}\n👥 Referallar: {refs} · 🛟 Murojaatlar: {tickets}\n\n🔗 Havolangiz:\nhttps://t.me/{bot}?start={code}",
    set_support_prompt: "🛟 <b>Adminga murojaat</b>\n\nMuammo yoki taklifingizni bitta xabar bilan yozing — javob shu chatga keladi.\n\nBekor qilish: /cancel",
    help: "🛟 <b>Yordam — qisqa qo‘llanma</b>\n\n📢 <b>Kanallarim</b> — kanal ulash, kanal statistikasi, obunachi buyurtish.\n📋 <b>Vazifalar</b> — 10 talik kanallar; obuna bo‘lib “✅ Obuna bo‘ldim” bosing.\n🛒 <b>Buyurtmalarim</b> — buyurtmalar holati; bekor qilsangiz kreditingiz qaytadi.\n📸 <b>Instagram</b> — profil ulash (rasmiy tekshiruv yo‘q, tasdiqlash o‘zingizga asoslanadi).\n👥 <b>Referal</b> — taklif havolasi va bonusni kanalga yo‘naltirish.\n📊 <b>Statistika</b> — balans, sarf, bajarilgan vazifalar.\n⚙️ <b>Sozlamalar</b> — til, bildirishnomalar, kredit qoidalari, ma’lumotlarim, adminga murojaat.\n\n<b>Qoidalar:</b> obuna haqiqiy tekshiriladi; obunadan chiqsangiz kredit qaytarib olinadi; soxta harakatda hisob bloklanadi; kanal uchun bot administrator bo‘lishi shart.",
    cmp_choose: "Muammo turini tanlang:",
    cmp_enter: "📝 <b>{cat}</b>\n\nMuammoni batafsil yozing. Bekor qilish: /cancel",
    cmp_ok: "🛟 Murojaat qabul qilindi!\nBilet: <b>{ticket}</b>\nAdminlar tez orada javob beradi.",
    langs: "🌐 Tilni tanlang:",
    lang_names: "O‘zbekcha"
  },
  ru: {
    b_channels: "📢 Мои каналы",
    b_tasks: "📋 Задания",
    b_orders: "🛒 Мои заказы",
    b_instagram: "📸 Instagram",
    b_referrals: "👥 Рефералы",
    b_stats: "📊 Статистика",
    b_help: "🛟 Помощь",
    b_settings: "⚙️ Настройки",
    ig_add: "➕ Добавить профиль",
    ig_tasks: "📋 Задания Instagram",
    verify_btn: "✅ Проверить",
    cancel_yes: "Да, отменить",
    cancel_no: "Нет",
    disc_yes: "Да, отключить",
    disc_no: "Нет",
    start_new: "Здравствуйте, {name}! 👋\n\nДобро пожаловать! Ниже короткая инструкция.",
    start_back: "Здравствуйте, {name}! 🚀\n\nЭто платформа взаимного роста в Telegram и Instagram.\nПодписывайтесь на другие каналы, зарабатывайте кредиты и заказывайте подписчиков себе.\n\n{balance}",
    guide: "📖 <b>Как работает бот</b>\n\n1) Подписывайтесь на каналы и получайте <b>кредиты</b>\n2) Тратьте кредиты на подписчиков для своего канала\n\n💰 <b>Кредит</b> — внутренняя единица. 1 подписчик = {price} кредитов. Это не деньги.\n\n1️⃣ “📋 Задания” → подпишитесь → “✅ Я подписался”. Бот проверит сам. За каждую подписку +{reward} кредитов.\n2️⃣ Добавление канала: сделайте бота <b>администратором</b> → “📢 Мои каналы” → “➕ Добавить канал” → отправьте адрес.{bonus}\n3️⃣ “📢 Мои каналы” → канал → укажите количество → подтвердите.\n4️⃣ “👥 Рефералы” — друг выполнит одно задание, бонус вам: +{ref} кредитов.\n\nПодробнее: “🛟 Помощь”.",
    bonus_line: "\nЗа первый канал +{bonus} кредитов.",
    bal: "💰 Баланс: <b>{a}</b> кредитов  •  🔒 Резерв: {r}",
    tasks_none: "📋 <b>Заданий пока нет</b>\n\nПричина: сейчас никто не заказывал подписчиков. Попробуйте позже.\n\n{balance}",
    tasks_title: "📋 <b>Задания: {n} каналов</b>\n\n1. Откройте канал по ссылке\n2. Подпишитесь\n3. Нажмите “✅ Я подписался” — бот проверит\n\nПроблема? Кнопка <b>⚠️N</b> рядом с каналом.\n\nЗа каждую подписку: <b>+{reward} кредитов</b>\n\n",
    tasks_btn_done: "✅ Я подписался",
    tasks_btn_refresh: "🔄 Обновить",
    ch_title: "📢 <b>Ваши каналы: {n}</b>\n\n{list}\n\n{balance}",
    ch_none: "Канал ещё не добавлен:\n1. Сделайте бота <b>администратором</b> канала\n2. Нажмите “➕ Добавить канал”\n3. Отправьте адрес (например: @kanal_nomi)",
    ch_add: "➕ Добавить канал",
    ch_code_in: "🔑 Ввести код",
    ch_back: "⬅️ Назад",
    ch_buy: "🛒 Заказать",
    ch_unlink: "🗑 Отключить канал",
    ch_controller: "контроллер",
    ord_title: "🛒 <b>Ваши заказы: {n}</b>\n{balance}\n\n{list}",
    ord_none: "Заказов пока нет.\n\n“📢 Мои каналы” → выберите канал → укажите количество.",
    ord_qty: "🛒 <b>{title}</b>\n\nСколько подписчиков нужно? (10–10000)\n• Цена: {unit} кредитов за 1\n• {balance}\n• Максимум на баланс: {max}\n\nОтмена: /cancel",
    ord_summary: "📝 <b>Проверьте заказ</b>\n\n• {title}\n• Количество: <b>{qty}</b>\n• Цена: {unit} × {qty} = <b>{total}</b> кредитов\n• Баланс после заказа: {left}\n\nПосле подтверждения кредиты будут зарезервированы.",
    ord_yes: "✅ Подтвердить",
    ord_no: "❌ Отмена",
    ord_created: "🛒 <b>Заказ принят!</b>\n\n• {title}\n• Количество: {qty}\n• Цена: {total} кредитов (резерв)\n\nПодписчики добавляются по очереди.",
    ord_cancelled: "❌ Заказ отменён. Кредиты не списаны.",
    ord_short: "❌ Недостаточно кредитов.\n\nНужно: {need}\nУ вас: {have}\nНе хватает: {lack}\n\n📋 Выполняйте задания, чтобы заработать кредиты.",
    stats_title: "📊 <b>Статистика</b>\n\n👤 {name}\n🆔 {id}\n\n💰 Баланс: <b>{a}</b>\n🔒 Резерв: {r}\n💸 Израсходовано: {s}\n↩️ Возвращено: {ref}\n✅ Выполнено заданий: {done}\n📢 Каналов: {ch}\n🛒 Активных заказов: {ord}",
    ref_title: "👥 <b>Рефералы</b>\n\nДруг зайдёт по вашей ссылке и выполнит <b>одно задание</b> — вы получите <b>+{reward} кредитов</b>.\nБонус направляется на ваш канал как подписчики (1 подписчик = {unit} кредитов).\n\nПриглашено: {n} • Бонусов направлено: {paid}{pending}\n\n🔗 Ваша ссылка:\nhttps://t.me/{bot}?start={code}",
    ref_pending: "\n\n🎁 Ненаправленный бонус: <b>{amount} кредитов</b>{hint}",
    ref_alloc: "🎁 Направить бонус на канал",
    set_title: "⚙️ <b>Настройки</b>\n\n🌐 Язык: {lang}\n\n🔔 <b>Уведомления</b>\nЕжечасный отчёт: {hourly}\n• Новые подписчики: {sub}\n• Реферальные бонусы: {ref}\n• Статус заказов: {ord}\n• Технические: {tech}",
    set_hourly_on: "🔕 Отключить отчёт",
    set_hourly_off: "🔔 Включить отчёт",
    set_title: "⚙️ <b>Настройки</b>\n\n👤 {name} · ID: <code>{id}</code>\n\n🌐 Язык: {lang}\n💰 Баланс: <b>{bal}</b> кредитов\n\n🔔 <b>Уведомления</b>\n• Ежечасный отчёт: {hourly}\n• Новые подписчики: {sub}\n• Реферальные бонусы: {ref}\n• Статус заказов: {ord}\n• Технические: {tech}\n\nНажмите нужную кнопку — сохраняется сразу.",
    set_rates_btn: "📊 Правила кредитов",
    set_info_btn: "👤 Мои данные",
    set_support_btn: "🛟 Написать админу",
    set_all_on: "🔔 Включить всё",
    set_all_off: "🔕 Отключить всё",
    set_back: "⬅️ Назад",
    frozen: "🧊 Заказы временно заморожены. Попробуйте позже.",
    ord_qty_range: "Количество должно быть от 10 до 10 000. Введите снова:",
    my_tickets_btn: "🗂 Мои обращения",
    my_tickets_title: "🗂 <b>Мои обращения</b>\n\n{tickets}",
    my_tickets_none: "Вы ещё не отправляли обращений.\nОтправить: Настройки → “🛟 Написать админу”.",
    my_tickets_item: "• <b>{ticket}</b> · {status}\n  {category}\n  {date}{answer}",
    my_tickets_answer: "\n  💬 Ответ: {text}",
    st_new: "🆕 новое",
    st_review: "🔍 на рассмотрении",
    st_answered: "✅ отвечено",
    st_closed: "🔒 закрыто",
    set_rates: "📊 <b>Правила кредитов</b>\n\n• 1 подтверждённая подписка = <b>{tg}</b> кредитов\n• 1 подписчик в заказе = <b>{per}</b> кредитов\n• 1 активный реферал = <b>{ref}</b> кредитов\n• Бонус за первый канал = <b>{link}</b> кредитов\n• Бонус за регистрацию = <b>{signup}</b> кредитов\n\nКредит — не деньги, а внутренняя единица бота. Значения меняет администратор.",
    set_info: "👤 <b>Мои данные</b>\n\nИмя: {name}\nID: <code>{id}</code>\nUsername: {username}\nЯзык: {lang}\nРегистрация: {date}\n\n💰 Баланс: <b>{a}</b> · 🔒 Резерв: {r}\n💸 Израсходовано: {s} · ↩️ Возвращено: {ref}\n\n📢 Каналов: {ch} · 📸 Instagram: {ig}\n✅ Заданий: {done} · 🛒 Активных заказов: {ord}\n👥 Рефералов: {refs} · 🛟 Обращений: {tickets}\n\n🔗 Ваша ссылка:\nhttps://t.me/{bot}?start={code}",
    set_support_prompt: "🛟 <b>Написать администратору</b>\n\nОпишите проблему или предложение одним сообщением — ответ придёт в этот чат.\n\nОтмена: /cancel",
    help: "🛟 <b>Помощь — краткое руководство</b>\n\n📢 <b>Мои каналы</b> — добавить канал, статистика, заказ подписчиков.\n📋 <b>Задания</b> — 10 каналов; подпишитесь и нажмите “✅ Я подписался”.\n🛒 <b>Мои заказы</b> — статус заказов; при отмене кредиты возвращаются.\n📸 <b>Instagram</b> — добавление профиля (официальной проверки нет).\n👥 <b>Рефералы</b> — ссылка и направление бонуса на канал.\n📊 <b>Статистика</b> — баланс, расход, задания.\n⚙️ <b>Настройки</b> — язык, уведомления, правила кредитов, мои данные, связь с админом.\n\n<b>Правила:</b> подписка проверяется; при отписке кредиты списываются; за обман аккаунт блокируется; бот должен быть администратором канала.",
    cmp_choose: "Выберите тип проблемы:",
    cmp_enter: "📝 <b>{cat}</b>\n\nОпишите проблему подробно. Отмена: /cancel",
    cmp_ok: "🛟 Обращение принято!\nТикет: <b>{ticket}</b>\nАдминистратор скоро ответит.",
    langs: "🌐 Выберите язык:",
    lang_names: "Русский"
  },
  en: {
    b_channels: "📢 My channels",
    b_tasks: "📋 Tasks",
    b_orders: "🛒 My orders",
    b_instagram: "📸 Instagram",
    b_referrals: "👥 Referrals",
    b_stats: "📊 Statistics",
    b_help: "🛟 Help",
    b_settings: "⚙️ Settings",
    ig_add: "➕ Add profile",
    ig_tasks: "📋 Instagram tasks",
    verify_btn: "✅ Check",
    cancel_yes: "Yes, cancel",
    cancel_no: "No",
    disc_yes: "Yes, disconnect",
    disc_no: "No",
    start_new: "Hello, {name}! 👋\n\nWelcome! Here is a short guide.",
    start_back: "Hello, {name}! 🚀\n\nThis is a Telegram and Instagram growth exchange.\nSubscribe to other channels to earn credits, then order subscribers for your own.\n\n{balance}",
    guide: "📖 <b>How the bot works</b>\n\n1) Subscribe to channels and earn <b>credits</b>\n2) Spend credits on subscribers for your channel\n\n💰 <b>Credit</b> — internal unit. 1 subscriber = {price} credits. Not money.\n\n1️⃣ “📋 Tasks” → subscribe → “✅ I subscribed”. The bot verifies. Each subscription gives +{reward} credits.\n2️⃣ Add channel: make the bot <b>administrator</b> → “📢 My channels” → “➕ Add channel” → send the address.{bonus}\n3️⃣ “📢 My channels” → channel → enter quantity → confirm.\n4️⃣ “👥 Referrals” — a friend completes one task, you get +{ref} credits.\n\nDetails: “🛟 Help”.",
    bonus_line: "\n+{bonus} credits for your first channel.",
    bal: "💰 Balance: <b>{a}</b> credits  •  🔒 Reserved: {r}",
    tasks_none: "📋 <b>No tasks yet</b>\n\nReason: nobody has ordered subscribers yet. Try again later.\n\n{balance}",
    tasks_title: "📋 <b>Tasks: {n} channels</b>\n\n1. Open the channel link\n2. Subscribe\n3. Press “✅ I subscribed” — the bot verifies\n\nProblem? Use the <b>⚠️N</b> button next to the channel.\n\nPer subscription: <b>+{reward} credits</b>\n\n",
    tasks_btn_done: "✅ I subscribed",
    tasks_btn_refresh: "🔄 Refresh",
    ch_title: "📢 <b>Your channels: {n}</b>\n\n{list}\n\n{balance}",
    ch_none: "No channel yet:\n1. Make the bot an <b>administrator</b>\n2. Press “➕ Add channel”\n3. Send the address (e.g. @my_channel)",
    ch_add: "➕ Add channel",
    ch_code_in: "🔑 Enter code",
    ch_back: "⬅️ Back",
    ch_buy: "🛒 Place order",
    ch_unlink: "🗑 Disconnect channel",
    ch_controller: "controller",
    ord_title: "🛒 <b>Your orders: {n}</b>\n{balance}\n\n{list}",
    ord_none: "No orders yet.\n\n“📢 My channels” → pick a channel → enter quantity.",
    ord_qty: "🛒 <b>{title}</b>\n\nHow many subscribers? (10–10000)\n• Price: {unit} credits each\n• {balance}\n• Maximum with this balance: {max}\n\nCancel: /cancel",
    ord_summary: "📝 <b>Order summary</b>\n\n• {title}\n• Quantity: <b>{qty}</b>\n• Price: {unit} × {qty} = <b>{total}</b> credits\n• Balance after order: {left}\n\nCredits are reserved after confirmation.",
    ord_yes: "✅ Confirm",
    ord_no: "❌ Cancel",
    ord_created: "🛒 <b>Order accepted!</b>\n\n• {title}\n• Quantity: {qty}\n• Price: {total} credits (reserved)\n\nSubscribers are added in queue order.",
    ord_cancelled: "❌ Order cancelled. No credits were reserved.",
    ord_short: "❌ Not enough credits.\n\nNeed: {need}\nYou have: {have}\nShortage: {lack}\n\n📋 Complete tasks to earn credits.",
    stats_title: "📊 <b>Statistics</b>\n\n👤 {name}\n🆔 {id}\n\n💰 Balance: <b>{a}</b>\n🔒 Reserved: {r}\n💸 Spent: {s}\n↩️ Refunded: {ref}\n✅ Completed tasks: {done}\n📢 Channels: {ch}\n🛒 Active orders: {ord}",
    ref_title: "👥 <b>Referrals</b>\n\nA friend joins by your link and completes <b>one task</b> — you get <b>+{reward} credits</b>.\nThe bonus is sent to your channel as subscribers (1 subscriber = {unit} credits).\n\nInvited: {n} • Bonuses sent: {paid}{pending}\n\n🔗 Your link:\nhttps://t.me/{bot}?start={code}",
    ref_pending: "\n\n🎁 Unallocated bonus: <b>{amount} credits</b>{hint}",
    ref_alloc: "🎁 Send bonus to a channel",
    set_title: "⚙️ <b>Settings</b>\n\n🌐 Language: {lang}\n\n🔔 <b>Notifications</b>\nHourly report: {hourly}\n• New subscribers: {sub}\n• Referral bonuses: {ref}\n• Order status: {ord}\n• Technical: {tech}",
    set_hourly_on: "🔕 Turn off report",
    set_hourly_off: "🔔 Turn on report",
    set_title: "⚙️ <b>Settings</b>\n\n👤 {name} · ID: <code>{id}</code>\n\n🌐 Language: {lang}\n💰 Balance: <b>{bal}</b> credits\n\n🔔 <b>Notifications</b>\n• Hourly report: {hourly}\n• New subscribers: {sub}\n• Referral bonuses: {ref}\n• Order status: {ord}\n• Technical: {tech}\n\nTap a button to change it — saved instantly.",
    set_rates_btn: "📊 Credit rules",
    set_info_btn: "👤 My data",
    set_support_btn: "🛟 Message admin",
    set_all_on: "🔔 Turn all on",
    set_all_off: "🔕 Turn all off",
    set_back: "⬅️ Back",
    frozen: "🧊 Orders are temporarily frozen. Try again later.",
    ord_qty_range: "Quantity must be between 10 and 10 000. Enter again:",
    my_tickets_btn: "🗂 My requests",
    my_tickets_title: "🗂 <b>My requests</b>\n\n{tickets}",
    my_tickets_none: "You have not sent any request yet.\nSend one: Settings → “🛟 Message admin”.",
    my_tickets_item: "• <b>{ticket}</b> · {status}\n  {category}\n  {date}{answer}",
    my_tickets_answer: "\n  💬 Reply: {text}",
    st_new: "🆕 new",
    st_review: "🔍 in review",
    st_answered: "✅ answered",
    st_closed: "🔒 closed",
    set_rates: "📊 <b>Credit rules</b>\n\n• 1 verified subscription = <b>{tg}</b> credits\n• 1 ordered subscriber = <b>{per}</b> credits\n• 1 active referral = <b>{ref}</b> credits\n• First channel bonus = <b>{link}</b> credits\n• Signup bonus = <b>{signup}</b> credits\n\nA credit is not money — it is the bot's internal unit. Values are changed by the administrator.",
    set_info: "👤 <b>My data</b>\n\nName: {name}\nID: <code>{id}</code>\nUsername: {username}\nLanguage: {lang}\nRegistered: {date}\n\n💰 Balance: <b>{a}</b> · 🔒 Reserved: {r}\n💸 Spent: {s} · ↩️ Refunded: {ref}\n\n📢 Channels: {ch} · 📸 Instagram: {ig}\n✅ Tasks: {done} · 🛒 Active orders: {ord}\n👥 Referrals: {refs} · 🛟 Requests: {tickets}\n\n🔗 Your link:\nhttps://t.me/{bot}?start={code}",
    set_support_prompt: "🛟 <b>Message the administrator</b>\n\nDescribe the problem or suggestion in one message — the reply arrives in this chat.\n\nCancel: /cancel",
    help: "🛟 <b>Help — quick guide</b>\n\n📢 <b>My channels</b> — add a channel, stats, order subscribers.\n📋 <b>Tasks</b> — 10 channels; subscribe and press “✅ I subscribed”.\n🛒 <b>My orders</b> — order status; credits are refunded on cancel.\n📸 <b>Instagram</b> — add a profile (no official verification).\n👥 <b>Referrals</b> — your link and bonus allocation.\n📊 <b>Statistics</b> — balance, spending, tasks.\n⚙️ <b>Settings</b> — language, notifications, credit rules, my data, contact admin.\n\n<b>Rules:</b> subscriptions are verified; unsubscribing revokes credits; cheating blocks the account; the bot must be a channel administrator.",
    cmp_choose: "Choose the problem type:",
    cmp_enter: "📝 <b>{cat}</b>\n\nDescribe the problem. Cancel: /cancel",
    cmp_ok: "🛟 Request accepted!\nTicket: <b>{ticket}</b>\nAn administrator will reply soon.",
    langs: "🌐 Choose a language:",
    lang_names: "English"
  }
};
function notifOn(u, key) {
  if (!u) return false;
  if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
  return u.notif[key] !== false;
}
function langOf(u) {
  const l = u && u.language;
  return STR[l] ? l : "uz";
}
function T(u, key, vars) {
  const pack = STR[langOf(u)] || STR.uz;
  let s = pack[key] != null ? pack[key] : STR.uz[key] != null ? STR.uz[key] : key;
  for (const k in vars || {}) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}
var MENU_KEYS = [["channels", "tasks"], ["orders", "instagram"], ["referrals", "stats"], ["help", "settings"]];
function menuFor(u) {
  return {
    reply_markup: {
      keyboard: MENU_KEYS.map((row) => row.map((k) => ({ text: T(u, "b_" + k) }))),
      resize_keyboard: true
    }
  };
}
var LABEL2KEY = {};
for (const l of Object.keys(STR)) {
  for (const k of ["channels", "tasks", "orders", "instagram", "referrals", "stats", "help", "settings"]) {
    LABEL2KEY[STR[l]["b_" + k]] = k;
  }
}

Object.assign(STR.uz, {
  "paused": "⏸ Vazifalar vaqtincha to‘xtatilgan. Keyinroq urinib ko‘ring.",
  "ig_off": "📸 Instagram bo‘limi hozircha o‘chirilgan.",
  "ig_note": "⚠️ Instagram’da tasdiqlash sizning so‘zingizga asoslanadi — admin tekshiradi.",
  "ch_detail": "📢 <b>{title}</b>\n@{username}\n🆔 <code>{cid}</code>\n\nSo‘ralgan: {req} ta\n✅ Tasdiqlangan: {ver} ta\n👥 Faol: {act} ta\n➖ Chiqqan: {unsub} ta\n⏳ Kutilmoqda: {pend} ta\n\n🔑 Nazoratchilar: {ctl}\n⚠️ Shikoyatlar: {cmp} ta\n\n🛒 <b>Buyurtma tarixi:</b>\n{hist}\n\n{balance}",
  "ch_add_steps": "📢 <b>Kanal ulash — 3 qadam</b>\n\n1. Kanalingizga botni <b>administrator</b> qiling\n2. Kanal manzilini yuboring, masalan: <code>@mening_kanalim</code>\n3. Bot kanalni tekshiradi va ulaydi\n\nBekor qilish: /cancel",
  "ch_added": "📢 <b>Kanal ulandi!</b>\n\n• {title} (@{username})\n• Bot admin huquqi: tasdiqlangan ✅",
  "ch_added_bonus": "\n\n🎁 Kanal ulaganingiz uchun <b>+{bonus} kredit</b> sovg‘a!\n💰 Balans: {bal} kredit",
  "verify_none": "Tekshiradigan vazifangiz yo‘q.\n\nAvval “📋 Vazifalar” tugmasini bosing.",
  "verify_ok": "✅ <b>Tekshirildi!</b>\n\n• Tasdiqlandi: <b>{ok} ta</b>\n• Mukofot: <b>+{reward} kredit</b>\n• Hozirgi balans: <b>{bal} kredit</b>",
  "choose_menu": "Kerakli amalni pastdagi menyudan tanlang.",
  "cancelled": "Bekor qilindi.",
  "lang_saved": "✅ Til o‘zgartirildi.",
  "ord_fifo_short": "🛒 <b>Buyurtma qabul qilindi!</b>\n\n• {title}\n• Miqdor: {qty}\n• Narx: {total} kredit (band qilindi)"
});
Object.assign(STR.ru, {
  "paused": "⏸ Задания временно приостановлены. Попробуйте позже.",
  "ig_off": "📸 Раздел Instagram пока отключён.",
  "ig_note": "⚠️ В Instagram подтверждение основано на вашем слове — проверяет администратор.",
  "ch_detail": "📢 <b>{title}</b>\n@{username}\n🆔 <code>{cid}</code>\n\nЗаказано: {req}\n✅ Подтверждено: {ver}\n👥 Активные: {act}\n➖ Отписались: {unsub}\n⏳ В ожидании: {pend}\n\n🔑 Контроллеры: {ctl}\n⚠️ Обращения: {cmp}\n\n🛒 <b>История заказов:</b>\n{hist}\n\n{balance}",
  "ch_add_steps": "📢 <b>Добавление канала — 3 шага</b>\n\n1. Сделайте бота <b>администратором</b>\n2. Отправьте адрес канала, например: <code>@moy_kanal</code>\n3. Бот проверит и добавит\n\nОтмена: /cancel",
  "ch_added": "📢 <b>Канал добавлен!</b>\n\n• {title} (@{username})\n• Права администратора: подтверждены ✅",
  "ch_added_bonus": "\n\n🎁 За добавление канала <b>+{bonus} кредитов</b>!\n💰 Баланс: {bal}",
  "verify_none": "Нет заданий для проверки.\n\nСначала нажмите “📋 Задания”.",
  "verify_ok": "✅ <b>Проверено!</b>\n\n• Подтверждено: <b>{ok}</b>\n• Награда: <b>+{reward} кредитов</b>\n• Баланс: <b>{bal}</b>",
  "choose_menu": "Выберите действие в меню ниже.",
  "cancelled": "Отменено.",
  "lang_saved": "✅ Язык изменён.",
  "ord_fifo_short": "🛒 <b>Заказ принят!</b>\n\n• {title}\n• Количество: {qty}\n• Цена: {total} кредитов (резерв)"
});
Object.assign(STR.en, {
  "paused": "⏸ Tasks are temporarily paused. Try later.",
  "ig_off": "📸 The Instagram module is currently off.",
  "ig_note": "⚠️ Instagram confirmation is based on your word — reviewed by an admin.",
  "ch_detail": "📢 <b>{title}</b>\n@{username}\n🆔 <code>{cid}</code>\n\nRequested: {req}\n✅ Verified: {ver}\n👥 Active: {act}\n➖ Unsubscribed: {unsub}\n⏳ Pending: {pend}\n\n🔑 Controllers: {ctl}\n⚠️ Complaints: {cmp}\n\n🛒 <b>Order history:</b>\n{hist}\n\n{balance}",
  "ch_add_steps": "📢 <b>Add a channel — 3 steps</b>\n\n1. Make the bot an <b>administrator</b>\n2. Send the channel address, e.g. <code>@my_channel</code>\n3. The bot verifies and adds it\n\nCancel: /cancel",
  "ch_added": "📢 <b>Channel added!</b>\n\n• {title} (@{username})\n• Admin rights: verified ✅",
  "ch_added_bonus": "\n\n🎁 <b>+{bonus} credits</b> for linking your channel!\n💰 Balance: {bal}",
  "verify_none": "No tasks to check.\n\nPress “📋 Tasks” first.",
  "verify_ok": "✅ <b>Checked!</b>\n\n• Verified: <b>{ok}</b>\n• Reward: <b>+{reward} credits</b>\n• Balance: <b>{bal}</b>",
  "choose_menu": "Choose an action from the menu below.",
  "cancelled": "Cancelled.",
  "lang_saved": "✅ Language changed.",
  "ord_fifo_short": "🛒 <b>Order accepted!</b>\n\n• {title}\n• Quantity: {qty}\n• Price: {total} credits (reserved)"
});

var TRMAP = {
 "Bu kanal allaqachon ulangan — qayta ulash shart emas.": {
  "ru": "Канал уже добавлен — повторно не нужно.",
  "en": "This channel is already added — no need to re-add."
 },
 "❌ Bu kanal boshqa foydalanuvchida ulangan.\n\nUning egasi sizga bir martalik kod bersa, “🔑 Kod kiritish” orqali nazoratchi bo‘lasiz.": {
  "ru": "❌ Канал добавлен другим пользователем.\n\nЕсли владелец даст вам одноразовый код, вы станете контроллером через “🔑 Ввести код”.",
  "en": "❌ This channel is registered by another user.\n\nIf the owner gives you a one-time code, you can become a controller via “🔑 Enter code”."
 }
,
 "Manzil noto‘g‘ri. Kanalingiz manzilini yuboring, masalan: <code>@mening_kanalim</code>\n\nBekor qilish: /cancel": {
  "ru": "Неверный адрес. Отправьте адрес канала, например: <code>@moy_kanal</code>\n\nОтмена: /cancel",
  "en": "Invalid address. Send your channel address, e.g. <code>@my_channel</code>\n\nCancel: /cancel"
 },
 "❌ Bu manzilda kanal topilmadi.\n\nKanal <b>ommaviy (public)</b> bo‘lishi va manzili @ bilan yozilishi kerak.": {
  "ru": "❌ Канал не найден.\n\nКанал должен быть <b>публичным</b>, адрес — с @.",
  "en": "❌ Channel not found.\n\nThe channel must be <b>public</b> and the address must start with @."
 },
 "❌ Bot bu kanalda <b>administrator</b> emas.\n\nKanal sozlamalari → Administratorlar → botni qo‘shib, qayta yuboring.": {
  "ru": "❌ Бот не <b>администратор</b> канала.\n\nНастройки канала → Администраторы → добавьте бота и отправьте снова.",
  "en": "❌ The bot is not an <b>administrator</b>.\n\nChannel settings → Administrators → add the bot and send again."
 },
 "❌ Siz bu kanalning administratori emassiz.\n\nFaqat o‘zingiz boshqaradigan kanalni ulash mumkin.": {
  "ru": "❌ Вы не администратор этого канала.\n\nМожно добавить только свой канал.",
  "en": "❌ You are not an administrator of this channel.\n\nYou can add only a channel you manage."
 },
 "Bu kanal allaqachon ulangan.": {
  "ru": "Этот канал уже добавлен.",
  "en": "This channel is already added."
 },
 "❌ Bu kanal boshqa foydalanuvchi nomida ulangan. Nazoratchi kodi orqali qo‘shiling.": {
  "ru": "❌ Канал добавлен другим пользователем. Используйте код контроллера.",
  "en": "❌ This channel is registered by another user. Join via controller code."
 },
 "📢 Botdan foydalanish uchun quyidagi homiy kanallarga obuna bo‘ling:": {
  "ru": "📢 Для использования бота подпишитесь на каналы спонсоров:",
  "en": "📢 Subscribe to the sponsor channels to use the bot:"
 },
 "✅ Rahmat! Endi botdan foydalanishingiz mumkin.": {
  "ru": "✅ Спасибо! Теперь можно пользоваться ботом.",
  "en": "✅ Thanks! You can use the bot now."
 },
 "⏸ Bot vaqtincha to‘xtatilgan. Keyinroq urinib ko‘ring.": {
  "ru": "⏸ Бот временно остановлен. Попробуйте позже.",
  "en": "⏸ The bot is temporarily paused. Try later."
 },
 "Buyurtma ma’lumoti eskirgan. Qaytadan boshlang: Kanallarim → kanal → miqdor.": {
  "ru": "Данные заказа устарели. Начните заново: Мои каналы → канал → количество.",
  "en": "Order data expired. Start again: My channels → channel → quantity."
 },
 "Buyurtmani bekor qilmoqchimisiz? Bajarilmagan qismi uchun kredit qaytariladi.": {
  "ru": "Отменить заказ? Кредиты за невыполненную часть вернутся.",
  "en": "Cancel this order? Credits for the unfulfilled part will be refunded."
 },
 "Ha, bekor qilish": {
  "ru": "Да, отменить",
  "en": "Yes, cancel"
 },
 "Yo‘q": {
  "ru": "Нет",
  "en": "No"
 },
 "❄️": {
  "ru": "❄️",
  "en": "❄️"
 },
 "📸 Instagram username yoki havolasini yuboring. Bekor qilish: /cancel": {
  "ru": "📸 Отправьте Instagram username или ссылку. Отмена: /cancel",
  "en": "📸 Send an Instagram username or link. Cancel: /cancel"
 },
 "Instagram username yoki havolasini yuboring. Masalan: <code>@my_brand</code>": {
  "ru": "Отправьте Instagram username или ссылку. Например: <code>@my_brand</code>",
  "en": "Send an Instagram username or link, e.g. <code>@my_brand</code>"
 },
 "Bu profil allaqachon ulangan.": {
  "ru": "Этот профиль уже добавлен.",
  "en": "This profile is already added."
 },
 "🔑 6 xonali kodni yuboring:": {
  "ru": "🔑 Отправьте 6-значный код:",
  "en": "🔑 Send the 6-digit code:"
 },
 "Kanal topilmadi.": {
  "ru": "Канал не найден.",
  "en": "Channel not found."
 },
 "Bu bonus allaqachon yo‘naltirilgan yoki topilmadi.": {
  "ru": "Бонус уже направлен или не найден.",
  "en": "The bonus was already allocated or not found."
 },
 "Buyurtma topilmadi yoki allaqachon yopilgan.": {
  "ru": "Заказ не найден или уже закрыт.",
  "en": "Order not found or already closed."
 },
 "Son 10 dan 10 000 gacha bo‘lishi kerak. Qaytadan yozing:": {
  "ru": "Число должно быть от 10 до 10 000. Введите снова:",
  "en": "The number must be between 10 and 10,000. Enter again:"
 },
 "📨 Apellyatsiyangiz allaqachon ko‘rib chiqilmoqda.": {
  "ru": "📨 Ваша апелляция уже рассматривается.",
  "en": "📨 Your appeal is already under review."
 },
 "📨 Apellyatsiya qabul qilindi. Admin ko‘rib chiqadi va javob yuboradi.": {
  "ru": "📨 Апелляция принята. Администратор рассмотрит и ответит.",
  "en": "📨 Appeal received. An administrator will review and reply."
 },
 "⛔ Hisobingiz bloklangan.\n\nApellyatsiya yuborish: /appeal <sabab/matn>": {
  "ru": "⛔ Ваш аккаунт заблокирован.\n\nАпелляция: /appeal <текст>",
  "en": "⛔ Your account is blocked.\n\nAppeal: /appeal <text>"
 },
 "📸 Instagram bo‘limi hozircha o‘chirilgan.": {
  "ru": "📸 Раздел Instagram пока отключён.",
  "en": "📸 The Instagram section is currently disabled."
 },
 "🧊 Buyurtmalar vaqtincha muzlatilgan.": {
  "ru": "🧊 Заказы временно заморожены.",
  "en": "🧊 Orders are temporarily frozen."
 },
 "❌ <b>Kredit yetmayapti</b>\n\nKerak: {need} kredit\nSizda: {have} kredit\nYetmayapti: {short} kredit\n\nKredit ishlash uchun “📋 Vazifalar” tugmasini bosing — har bir obuna uchun {reward} kredit beriladi.": {
  "ru": "❌ <b>Недостаточно кредитов</b>\n\nНужно: {need} кредитов\nУ вас: {have} кредитов\nНе хватает: {short} кредитов\n\nЧтобы заработать кредиты, нажмите «📋 Задания» — за каждую подписку начисляется {reward} кредитов.",
  "en": "❌ <b>Not enough credits</b>\n\nNeeded: {need} credits\nYou have: {have} credits\nShort by: {short} credits\n\nTo earn credits tap “📋 Tasks” — you get {reward} credits per subscription."
 },
 "↩️ <b>Buyurtma bekor qilindi</b>\n\nKelgan obunachilar saqlanadi ({verified} ta), bajarilmagan {unfulfilled} ta uchun <b>{refund} kredit</b> qaytarildi.\n{balance}": {
  "ru": "↩️ <b>Заказ отменён</b>\n\nПришедшие подписчики сохранены ({verified}), за невыполненные {unfulfilled} возвращено <b>{refund} кредитов</b>.\n{balance}",
  "en": "↩️ <b>Order cancelled</b>\n\nDelivered subscribers are kept ({verified}); <b>{refund} credits</b> refunded for the {unfulfilled} unfulfilled ones.\n{balance}"
 },
 "✅ Kod tasdiqlandi! Siz <b>{title}</b> kanalida nazoratchisiz.": {
  "ru": "✅ Код подтверждён! Вы контролёр канала <b>{title}</b>.",
  "en": "✅ Code confirmed! You are a controller of <b>{title}</b>."
 },
 "🗑 <b>{title}</b> kanalini botdan uzmoqchimisiz?\n\nFaol buyurtmalar bekor qilinadi va bajarilmagan qismining krediti qaytariladi.": {
  "ru": "🗑 Отключить канал <b>{title}</b> от бота?\n\nАктивные заказы будут отменены, кредиты за невыполненную часть вернутся.",
  "en": "🗑 Disconnect <b>{title}</b> from the bot?\n\nActive orders will be cancelled and credits for the unfulfilled part refunded."
 },
 "✅ <b>{title}</b> uzildi.": {
  "ru": "✅ <b>{title}</b> отключён.",
  "en": "✅ <b>{title}</b> disconnected."
 },
 "\n↩️ {refund} kredit qaytarildi.": {
  "ru": "\n↩️ Возвращено {refund} кредитов.",
  "en": "\n↩️ {refund} credits refunded."
 },
 "🎁 Referal bonusi <b>{title}</b> kanaliga yo‘naltirildi: <b>{units}</b> ta obunachi navbatga qo‘shildi.": {
  "ru": "🎁 Реферальный бонус направлен на канал <b>{title}</b>: в очередь добавлено <b>{units}</b> подписчиков.",
  "en": "🎁 Referral bonus sent to <b>{title}</b>: <b>{units}</b> subscribers added to the queue."
 }
};
function TR(u, uzText) {
  const l = langOf(u);
  if (l === "uz") return uzText;
  const m = TRMAP[uzText];
  return (m && m[l]) || uzText;
}
function TRV(u, uzText, vars) {
  let out = TR(u, uzText);
  for (const k of Object.keys(vars || {})) out = out.split("{" + k + "}").join(String(vars[k]));
  return out;
}
var MENU = menuFor({ language: "uz" });
var MENU_LABELS = new Set(Object.keys(LABEL2KEY));

var inline = (rows) => ({ reply_markup: { inline_keyboard: rows } });
var userById = (id) => db.users[id.replace(/^u-/, "")];
function getUser(from, chatId) {
  const key = String(from.id);
  let isNew = false;
  if (!db.users[key]) {
    isNew = true;
    const bonus = Math.max(0, Number(S().creditRewardSignup) || 0);
    db.users[key] = {
      id: `u-${from.id}`,
      telegramId: from.id,
      username: from.username,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id),
      language: ["uz", "ru", "en"].includes(String(from.language_code || "").slice(0, 2)) ? String(from.language_code).slice(0, 2) : "uz",
      credits: { available: bonus, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: bonus },
      registeredAt: nowStr(),
      referralCode: `REF_${from.id}`,
      isReferralVerified: false,
      completedTasksCount: 0,
      activeOrdersCount: 0,
      status: "active",
      chatId,
      botId: (curBot() || {}).id || "",
      notifications: true,
      notif: { subscribers: true, referrals: true, orders: true, technical: true }
    };
    if (bonus > 0) {
      addTx(db.users[key], bonus, "signup_bonus", "Ro'yxatdan o'tish sovg'asi");
      console.log(`Yangi foydalanuvchi ${from.id} — +${bonus} kredit sovg'a`);
    }
  }
  const u = db.users[key];
  u.chatId = chatId;
  if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
  u.botId = (curBot() || {}).id || u.botId || "";
  u.username = from.username;
  u.displayName = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || u.displayName;
  return { user: u, isNew };
}
function addTx(u, amount, type, description, extra = {}) {
  db.transactions.push({
    id: nid("tx"),
    userId: u.id,
    userName: u.displayName,
    amount,
    type,
    description,
    balanceAfter: u.credits.available,
    createdAt: nowStr(),
    ...extra
  });
  if (db.transactions.length > 2e4) db.transactions.splice(0, 5e3);
}
var OPEN = /* @__PURE__ */ new Set(["ACTIVE", "PENDING", "RECHECK", "CHECK_ERROR"]);
var destOf = (id) => db.channels.find((c) => c.id === id) || db.igProfiles.find((p) => p.id === id);
var orderAssigned = (o) => db.tasks.filter((t) => t.orderId === o.id && t.status !== "CANCELLED").length;
function getBatch(u, platform) {
  const mine = () => db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && OPEN.has(t.status)).sort((a, b) => a.queueSequence - b.queueSequence);
  let open = mine();
  if (open.length < 10) {
    const orders = db.orders.filter((o) => o.status === "active" && o.platform === platform && o.userId !== u.id).sort((a, b) => a.seq - b.seq);
    for (const o of orders) {
      if (open.length >= 10) break;
      const dest = destOf(o.destinationId);
      if (!dest) continue;
      if (platform === "telegram" && (dest.controllers || []).some((c) => c.userId === u.id)) continue;
      if (db.tasks.some((t2) => t2.assignedTo === u.id && t2.destinationId === o.destinationId && (t2.status !== "CANCELLED" || t2.unsubscribed))) continue;
      if (orderAssigned(o) >= o.requestedQuantity - o.cancelledQuantity) continue;
      const t = {
        id: nid("t"),
        platform,
        destinationId: o.destinationId,
        destinationTitle: o.destinationTitle,
        destinationUrl: platform === "telegram" ? `https://t.me/${dest.username}` : dest.profileUrl,
        orderId: o.id,
        ownerId: o.userId,
        rewardCredits: platform === "telegram" ? S().creditRewardTelegram : S().creditRewardInstagram,
        status: "ACTIVE",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        queueSequence: ++db.seq,
        assignedTo: u.id
      };
      db.tasks.push(t);
      open.push(t);
    }
    save();
  }
  return open.slice(0, 10);
}
function checkOrderComplete(o) {
  if (o.status === "active" && o.verifiedQuantity + o.cancelledQuantity >= o.requestedQuantity) {
    o.status = "completed";
    o.completedAt = nowStr();
    const owner = userById(o.userId);
    owner && (owner.activeOrdersCount = Math.max(0, owner.activeOrdersCount - 1));
    if (owner && !notifOn(owner, "orders")) return;
    notify(owner, `\u{1F389} <b>Buyurtma yakunlandi!</b>

${esc(o.destinationTitle)}: ${o.verifiedQuantity} ta obunachi.`);
  }
}
function applyVerified(u, t) {
  const o = db.orders.find((x) => x.id === t.orderId);
  if (!o || o.status === "cancelled" || o.status === "completed") {
    t.status = "CANCELLED";
    return 0;
  }
  const self = t.platform === "instagram";
  t.status = self ? "SELF_CONFIRMED" : "VERIFIED";
  t.verifiedAt = (/* @__PURE__ */ new Date()).toISOString();
  t.checkedAt = t.verifiedAt;
  o.verifiedQuantity++;
  o.pendingQuantity = Math.max(0, o.pendingQuantity - 1);
  const owner = userById(o.userId);
  // Bepul birliklar (admin grant / referal bonusi) egasidan kredit yechmaydi.
  if (o.freeUnits > 0) {
    o.freeUnits -= 1;
  } else if (owner) {
    owner.credits.reserved = Math.max(0, owner.credits.reserved - o.unitCost);
    owner.credits.spent += o.unitCost;
  }
  const dest = destOf(o.destinationId);
  if (dest) {
    if (self) {
      dest.selfReportedFollowers++;
      dest.pendingFollowers = Math.max(0, dest.pendingFollowers - 1);
    } else {
      dest.verifiedSubscribers++;
      dest.activeSubscribers++;
      dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - 1);
    }
  }
  u.credits.available += t.rewardCredits;
  self ? u.credits.selfReportedRewards += t.rewardCredits : u.credits.verifiedRewards += t.rewardCredits;
  u.completedTasksCount++;
  addTx(u, t.rewardCredits, "reward_task", `${self ? "Instagram (o\u2018zi tasdiqlagan)" : "Telegram"}: ${t.destinationTitle}`, { orderId: o.id, channelId: t.destinationId });
  db.verifyLog.push({ ownerId: o.userId, title: t.destinationTitle, platform: t.platform, at: Date.now() });
  if (db.verifyLog.length > 5e4) db.verifyLog.splice(0, 1e4);
  checkOrderComplete(o);
  return t.rewardCredits;
}
function tryQualifyReferral(u) {
  const ref = db.referrals.find((r) => r.referredUserId === u.id);
  if (!ref) return;
  ref.hasCompletedTask = true;
  ref.isVerified = true;
  ref.verifiedAt ||= nowStr();
  const q = qualifyReferral(ref, true, S().creditRewardReferral);
  if (!q.isEligible) return;
  const referrer = userById(ref.referrerId);
  if (!referrer) return;
  ref.bonusAmount = q.rewardCredits;
  u.isReferralVerified = true;
  // Spec §12: bonus foydalanuvchi tanlagan kanaliga yo'naltiriladi.
  const chs = channelsOf(referrer);
  if (!chs.length) {
    referrer.pendingRefBonus = (referrer.pendingRefBonus || 0) + q.rewardCredits;
    save();
    if (notifOn(referrer, "referrals")) notify(referrer, `\u{1F465} Do‘stingiz <b>${esc(u.displayName)}</b> birinchi vazifasini bajardi!\n\n\u{1F381} <b>${q.rewardCredits} kredit</b> referal bonusi tayyor. Uni kanalingizga yo‘naltirish uchun avval kanal ulang (\u201C\u{1F4E2} Kanallarim\u201D \u2192 \u201C\u2795 Kanal qo‘shish\u201D), so‘ng \u201C\u{1F465} Referal tizimi\u201D bo‘limiga kiring.`);
    return;
  }
  referrer.pendingRefBonus = (referrer.pendingRefBonus || 0) + q.rewardCredits;
  ref.awaitingChoice = true;
  const buttons = chs.slice(0, 8).map((c) => [{ text: `\u{1F4E2} ${c.title}`.slice(0, 40), callback_data: `refa:${ref.id}|${c.id}` }]);
  if (notifOn(referrer, "referrals")) notify(referrer, `\u{1F465} Do‘stingiz <b>${esc(u.displayName)}</b> birinchi vazifasini bajardi!\n\n\u{1F381} <b>${q.rewardCredits} kredit</b> referal bonusi tayyor. Qaysi kanalingizga yo‘naltiramiz?`, { reply_markup: { inline_keyboard: buttons } });
  save();
}
// Referal bonusini tanlangan kanalga obunachi navbati sifatida yo'naltiradi.
function allocateRefBonus(referrer, ref, ch) {
  const unit = perSub();
  const amount = Number(ref.bonusAmount) || 0;
  const units = Math.max(1, Math.floor(amount / unit));
  let o = db.orders.find((x) => x.destinationId === ch.id && x.status === "active");
  if (o) {
    o.requestedQuantity += units;
    o.pendingQuantity += units;
    o.freeUnits = (o.freeUnits || 0) + units;
    o.granted = true;
  } else {
    o = {
      id: nid("ord"),
      seq: ++db.seq,
      userId: ch.ownerId,
      userName: ch.ownerName,
      destinationId: ch.id,
      destinationTitle: ch.title,
      platform: "telegram",
      requestedQuantity: units,
      verifiedQuantity: 0,
      pendingQuantity: units,
      cancelledQuantity: 0,
      unitCost: 0,
      totalCost: 0,
      freeUnits: units,
      status: "active",
      granted: true,
      source: "referral_bonus",
      createdAt: nowStr()
    };
    db.orders.push(o);
  }
  ch.totalRequested += units;
  ch.pendingSubscriptions += units;
  ref.bonusIssued = true;
  ref.awaitingChoice = false;
  ref.allocatedChannelId = ch.id;
  ref.allocatedUnits = units;
  referrer.pendingRefBonus = Math.max(0, (referrer.pendingRefBonus || 0) - amount);
  save();
  return { units, order: o, amount };
}
async function verifyBatch(u, platform, chat) {
  const batch = db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && OPEN.has(t.status)).sort((a, b) => a.queueSequence - b.queueSequence).slice(0, 10);
  if (!batch.length) return send(chat, T(u, "verify_none"), menuFor(u));
  const lookup = {};
  if (platform === "telegram") {
    await Promise.all(batch.map(async (t) => {
      const dest = destOf(t.destinationId);
      const r = dest ? await checkMember(dest.channelId, u.telegramId) : "error";
      lookup[t.id] = { verified: r === "member", isApiError: r === "error" };
    }));
  } else {
    for (const t of batch) lookup[t.id] = { verified: Date.now() - Date.parse(t.createdAt) > 15e3 };
  }
  const out = processTaskBatchVerification(batch, lookup);
  let earned = 0, firstTg = false;
  for (const vt of out.verifiedTasks) {
    const real = db.tasks.find((x) => x.id === vt.id);
    const got = applyVerified(u, real);
    if (got > 0) {
      earned += got;
      if (platform === "telegram") firstTg = true;
    }
  }
  const deferred = buildFifoQueueWithDeferred([], out.deferredTasks, []);
  for (const d of deferred) {
    const real = db.tasks.find((x) => x.id === d.id);
    real.status = d.status;
    real.isDeferred = true;
    real.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  if (firstTg) tryQualifyReferral(u);
  save();
  const notDone = out.deferredTasks.filter((t) => t.status === "PENDING");
  let text = T(u, "verify_ok", { ok: out.verifiedTasks.length, reward: earned, bal: u.credits.available });
  if (notDone.length) text += `

⏳ <b>Hali obuna bo‘lmaganlar (${notDone.length} ta):</b>
` + notDone.map((t) => `• ${esc(t.destinationTitle)}`).join("\n") + `

Obuna bo‘lib, yana “✅ Obuna bo‘ldim” tugmasini bosing.`;
  if (out.apiErrorTasks.length) text += `

⚠️ ${out.apiErrorTasks.length} ta kanalni hozir tekshirib bo‘lmadi (Telegram’ning o‘zida xato). Sizda ayb yo‘q — keyinroq o‘zi qayta tekshiriladi.`;
  await send(chat, text, menuFor(u));
  if (!notDone.length && !out.apiErrorTasks.length) await showTasks(u, platform, chat);
}
function balanceLine(u) {
  return T(u, "bal", { a: u.credits.available, r: u.credits.reserved });
}
async function showTasks(u, platform, chat) {
  if (platform === "telegram" && S().isTelegramPaused) return send(chat, T(u, "paused"), menuFor(u));
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, T(u, "ig_off"), menuFor(u));
  const batch = getBatch(u, platform);
  if (!batch.length) return send(chat, T(u, "tasks_none", { balance: balanceLine(u) }), menuFor(u));
  const reward = batch[0].rewardCredits;
  const text = T(u, "tasks_title", { n: batch.length, reward }) +
    batch.map((t, i) => `${i + 1}. ${esc(t.destinationTitle)}${t.isDeferred ? " 🔁" : ""}`).join("\n") +
    (platform === "instagram" ? "\n\n" + T(u, "ig_note") : "");
  const rows = batch.map((t, i) => [{ text: `🔗 ${i + 1}. ${t.destinationTitle}`.slice(0, 60), url: t.destinationUrl }]);
  if (platform === "telegram") {
    const cmpBtns = batch.map((t, i) => ({ text: `⚠️${i + 1}`, callback_data: `cmpd:${t.id}` }));
    for (let i = 0; i < cmpBtns.length; i += 5) rows.push(cmpBtns.slice(i, i + 5));
  }
  rows.push([{ text: T(u, "tasks_btn_done"), callback_data: `verify:${platform === "telegram" ? "tg" : "ig"}` }]);
  rows.push([{ text: T(u, "tasks_btn_refresh"), callback_data: `tasks:${platform === "telegram" ? "tg" : "ig"}` }]);
  return send(chat, text, inline(rows));
}
var channelsOf = (u) => db.channels.filter((c) => c.ownerId === u.id || c.controllers.some((k) => k.userId === u.id));
async function showChannels(u, chat) {
  const chs = channelsOf(u);
  const list = chs.length
    ? chs.map((c) => `• <b>${esc(c.title)}</b> (@${esc(c.username)})\n   ✅ ${c.verifiedSubscribers} • ⏳ ${c.pendingSubscriptions}${c.ownerId !== u.id ? " (" + T(u, "ch_controller") + ")" : ""}`).join("\n")
    : T(u, "ch_none");
  const rows = chs.map((c) => [
    { text: `📢 ${c.title}`.slice(0, 32), callback_data: `chd:${c.id}` },
    { text: "🛒", callback_data: `ord:${c.id}` }
  ]);
  rows.push([{ text: T(u, "ch_add"), callback_data: "chadd" }, { text: T(u, "ch_code_in"), callback_data: "ctlin" }]);
  return send(chat, T(u, "ch_title", { n: chs.length, list, balance: balanceLine(u) }), inline(rows));
}
// Kanal statistikasi sahifasi (spec §6): obunachi holatlari, buyurtma tarixi,
// shikoyatlar va nazoratchilar bir joyda.
async function showChannelDetail(u, ch, chat) {
  const os = db.orders.filter((o) => o.destinationId === ch.id).slice(-5).reverse();
  const cmps = db.complaints.filter((c) => c.destinationId === ch.id);
  const hist = os.length
    ? os.map((o) => `• ${o.requestedQuantity} — ${o.verifiedQuantity} • ${o.status === "active" ? "🟢" : o.status === "completed" ? "✅" : "⛔"}`).join("\n")
    : "—";
  const text = T(u, "ch_detail", {
    title: esc(ch.title),
    username: esc(ch.username),
    cid: esc(ch.channelId),
    req: ch.totalRequested,
    ver: ch.verifiedSubscribers,
    act: ch.activeSubscribers,
    unsub: ch.unsubscribedCount,
    pend: ch.pendingSubscriptions,
    ctl: (ch.controllers || []).map((k) => esc(k.displayName)).join(", ") || "—",
    cmp: cmps.length,
    hist,
    balance: balanceLine(u)
  });
  const rows = [[{ text: T(u, "ch_buy"), callback_data: `ord:${ch.id}` }]];
  if (ch.ownerId === u.id) {
    rows.push([{ text: T(u, "ch_code_in"), callback_data: `ctl:${ch.id}` }, { text: T(u, "ch_unlink"), callback_data: `chdel:${ch.id}` }]);
  }
  rows.push([{ text: T(u, "ch_back"), callback_data: "chs:0" }]);
  return send(chat, text, inline(rows));
}
async function showOrders(u, chat) {
  const all = db.orders.filter((o) => o.userId === u.id);
  const os = all.slice(-10).reverse();
  const list = os.length
    ? os.map((o) => `${o.platform === "telegram" ? "📢" : "📸"} <b>${esc(o.destinationTitle)}</b> — ${o.verifiedQuantity}/${o.requestedQuantity} • ${o.status === "active" ? "🟢" : o.status === "completed" ? "✅" : "⛔"} • ${o.totalCost} 💰`).join("\n")
    : T(u, "ord_none");
  const rows = os.filter((o) => o.status === "active").map((o) => [{ text: `❌ ${o.destinationTitle}`.slice(0, 45), callback_data: `cx:${o.id}` }]);
  return send(chat, T(u, "ord_title", { n: all.length, balance: balanceLine(u), list }), rows.length ? inline(rows) : menuFor(u));
}
async function showInstagram(u, chat) {
  if (!S().isInstagramEnabled) return send(chat, TR(u, "📸 Instagram bo‘limi hozircha o‘chirilgan."), menuFor(u));
  const ps = db.igProfiles.filter((p) => p.userId === u.id);
  const text = `📸 <b>Instagram</b>

Kredit Telegram bilan bitta, lekin vazifalar alohida.

` + (ps.length ? ps.map((p) => `• @${esc(p.username)} — ${p.selfReportedFollowers} follower`).join("\n") : "Profil ulanmagan.") + `

${balanceLine(u)}`;
  const rows = ps.map((p) => [{ text: `🛒 @${p.username}`, callback_data: `ord:${p.id}` }]);
  rows.push([{ text: T(u, "ig_add"), callback_data: "igadd" }, { text: T(u, "ig_tasks"), callback_data: "tasks:ig" }]);
  return send(chat, text, inline(rows));
}
async function showReferrals(u, chat) {
  const refs = db.referrals.filter((r) => r.referrerId === u.id);
  const paid = refs.filter((r) => r.bonusIssued).length;
  const pendingAmount = Number(u.pendingRefBonus) || 0;
  const waiting = refs.filter((r) => !r.bonusIssued && r.bonusAmount > 0);
  const chs = channelsOf(u);
  const rows = [];
  if (waiting.length && chs.length) rows.push([{ text: T(u, "ref_alloc"), callback_data: `refa:${waiting[0].id}|${chs[0].id}` }]);
  const text = T(u, "ref_title", {
    reward: S().creditRewardReferral,
    unit: perSub(),
    n: refs.length,
    paid,
    pending: pendingAmount > 0 ? T(u, "ref_pending", { amount: pendingAmount, hint: chs.length ? "" : " — " + T(u, "ch_none").split("\n")[0] }) : "",
    bot: S().botUsername,
    code: u.referralCode
  });
  return send(chat, text, rows.length ? inline(rows) : menuFor(u));
}
async function showStats(u, chat) {
  const c = u.credits;
  return send(chat, T(u, "stats_title", {
    name: esc(u.displayName),
    id: u.telegramId,
    a: c.available,
    r: c.reserved,
    s: c.spent,
    ref: c.refunded,
    done: u.completedTasksCount,
    ch: channelsOf(u).length,
    ord: db.orders.filter((o) => o.userId === u.id && o.status === "active").length
  }), menuFor(u));
}
async function showHelp(u, chat) {
  return send(chat, T(u, "help"), inline([
    [{ text: T(u, "tasks_btn_refresh"), callback_data: "tasks:tg" }],
    [{ text: "📝", callback_data: "cmp:new" }]
  ]));
}
async function showSettings(u, chat) {
  const mark = (ok) => (ok ? "\u2705" : "\u26D4");
  const langName = { uz: "\u{1F1FA}\u{1F1FF} O\u2018zbekcha", ru: "\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043a\u0438\u0439", en: "\u{1F1EC}\u{1F1E7} English" }[langOf(u)];
  const c = u.credits || {};
  return send(chat, T(u, "set_title", {
    name: esc(u.displayName || ""),
    id: u.telegramId,
    lang: langName,
    bal: c.available || 0,
    hourly: u.notifications ? "\u2705" : "\u26D4",
    sub: mark(notifOn(u, "subscribers")),
    ref: mark(notifOn(u, "referrals")),
    ord: mark(notifOn(u, "orders")),
    tech: mark(notifOn(u, "technical"))
  }), inline([
    [{ text: "\u{1F1FA}\u{1F1FF} O\u2018zbekcha", callback_data: "lang:uz" }, { text: "\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043a\u0438\u0439", callback_data: "lang:ru" }, { text: "\u{1F1EC}\u{1F1E7} English", callback_data: "lang:en" }],
    [{ text: (u.notifications ? T(u, "set_hourly_on") : T(u, "set_hourly_off")) + " \u2014 " + (u.notifications ? "\u2705" : "\u26D4"), callback_data: "notif" }],
    [{ text: T(u, "b_tasks") + " " + mark(notifOn(u, "subscribers")), callback_data: "nt:subscribers" }, { text: T(u, "b_referrals") + " " + mark(notifOn(u, "referrals")), callback_data: "nt:referrals" }],
    [{ text: T(u, "b_orders") + " " + mark(notifOn(u, "orders")), callback_data: "nt:orders" }, { text: "\u{1F6E0} " + mark(notifOn(u, "technical")), callback_data: "nt:technical" }],
    [{ text: T(u, "set_all_on"), callback_data: "ntall:on" }, { text: T(u, "set_all_off"), callback_data: "ntall:off" }],
    [{ text: T(u, "set_rates_btn"), callback_data: "setrates" }, { text: T(u, "set_info_btn"), callback_data: "setinfo" }],
    [{ text: T(u, "set_support_btn"), callback_data: "setsupport" }, { text: T(u, "my_tickets_btn"), callback_data: "setmyt" }]
  ]));
}
async function showMyTickets(u, chat) {
  const list = db.complaints.filter((c) => c.userId === u.id).slice(-8).reverse();
  const stKey = { NEW: "st_new", IN_REVIEW: "st_review", ANSWERED: "st_answered", CLOSED: "st_closed" };
  const body = list.length
    ? list.map((c) => T(u, "my_tickets_item", {
        ticket: esc(c.ticketId || "—"),
        status: T(u, stKey[c.status] || "st_new"),
        category: esc(c.category || "—"),
        date: esc(c.createdAt || ""),
        answer: c.adminResponse ? T(u, "my_tickets_answer", { text: esc(String(c.adminResponse).slice(0, 300)) }) : ""
      })).join("\n")
    : T(u, "my_tickets_none");
  return send(chat, T(u, "my_tickets_title", { tickets: body }), inline([[{ text: T(u, "set_back"), callback_data: "settings" }]]));
}
async function showCreditRules(u, chat) {
  return send(chat, T(u, "set_rates", {
    tg: S().creditRewardTelegram,
    per: perSub(),
    ref: S().creditRewardReferral,
    link: S().creditRewardChannelLink,
    signup: S().creditRewardSignup
  }), inline([[{ text: T(u, "set_back"), callback_data: "settings" }]]));
}
async function showMyData(u, chat) {
  const c = u.credits || {};
  const refs = db.referrals.filter((r) => r.referrerId === u.id).length;
  const tickets = db.complaints.filter((x) => x.userId === u.id).length;
  return send(chat, T(u, "set_info", {
    name: esc(u.displayName || ""),
    id: u.telegramId,
    username: u.username ? "@" + esc(u.username) : "\u2014",
    lang: { uz: "O\u2018zbekcha", ru: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", en: "English" }[langOf(u)],
    date: u.registeredAt || "\u2014",
    a: c.available || 0,
    r: c.reserved || 0,
    s: c.spent || 0,
    ref: c.refunded || 0,
    ch: channelsOf(u).length,
    ig: db.igProfiles.filter((p) => p.userId === u.id).length,
    done: u.completedTasksCount || 0,
    ord: db.orders.filter((o) => o.userId === u.id && o.status === "active").length,
    refs,
    tickets,
    bot: S().botUsername,
    code: u.referralCode
  }), inline([[{ text: T(u, "set_back"), callback_data: "settings" }]]));
}
var CATEGORIES = [
  "Obunachilar kamayib ketdi",
  "Buyurtmam bajarilmayapti",
  "Obunachilar noto‘g‘ri hisoblanmoqda",
  "Kanalimda texnik muammo bor",
  "Kanalimga ruxsatsiz buyurtma berilgan",
  "Boshqa muammo",
  "Shikoyatimni o‘zim yozaman"
];

async function sponsorGate(u, chat) {
  const missing = [];
  for (const sp of db.sponsors.filter((s) => s.isActive && s.isMandatory)) {
    if (await checkMember(sp.channelId, u.telegramId) === "not_member") missing.push(sp);
  }
  if (!missing.length) return true;
  await send(chat, TR(u, "\u{1F4E2} Botdan foydalanish uchun quyidagi homiy kanallarga obuna bo\u2018ling:"), inline([
    ...missing.map((s) => [{ text: `\u{1F4E2} ${s.title}`, url: s.url }]),
    [{ text: T(u, "verify_btn"), callback_data: "sp:check" }]
  ]));
  return false;
}
// Buyurtma tasdiqlash qadami (spec §11): miqdor kiritilgach xulosa ko'rsatiladi,
// tasdiqlangandan keyingina kredit band qilinadi.
async function prepareOrder(u, destId, qty, chat) {
  const dest = destOf(destId);
  if (!dest) return send(chat, T(u, "choose_menu"), menuFor(u));
  const platform = destId.startsWith("ig-") ? "instagram" : "telegram";
  if (S().areOrdersFrozen) return send(chat, T(u, "frozen"), menuFor(u));
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, T(u, "ig_off"), menuFor(u));
  if (!Number.isInteger(qty) || qty < 10 || qty > 1e4) return send(chat, T(u, "ord_qty_range"));
  const unit = perSub();
  const chk = calculateOrderAffordability(u.credits, qty, unit);
  if (!chk.canAfford) {
    u.state = null;
    return send(chat, T(u, "ord_short", { need: chk.totalCost, have: u.credits.available, lack: chk.shortage }), menuFor(u));
  }
  u.state = { type: "order_confirm", destId, qty, platform, unit };
  const title = esc(platform === "telegram" ? dest.title : "@" + dest.username);
  return send(chat, T(u, "ord_summary", {
    title,
    qty,
    unit,
    total: chk.totalCost,
    left: u.credits.available - chk.totalCost
  }), inline([
    [{ text: T(u, "ord_yes"), callback_data: "ordok:1" }, { text: T(u, "ord_no"), callback_data: "ordno:0" }]
  ]));
}
async function createOrderConfirmed(u, destId, qty, chat) {
  const dest = destOf(destId);
  if (!dest) return send(chat, "Manzil topilmadi.", menuFor(u));
  const platform = destId.startsWith("ig-") ? "instagram" : "telegram";
  if (S().areOrdersFrozen) return send(chat, TR(u, "\u{1F9CA} Buyurtmalar vaqtincha muzlatilgan."), menuFor(u));
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, "\u{1F4F8} Instagram moduli o\u2018chirilgan.", menuFor(u));
  if (!Number.isInteger(qty) || qty < 10 || qty > 1e4) return send(chat, TR(u, "Son 10 dan 10 000 gacha bo\u2018lishi kerak. Qaytadan yozing:"));
  const unit = perSub();
  const chk = calculateOrderAffordability(u.credits, qty, unit);
  if (!chk.canAfford) {
    u.state = null;
    return send(chat, TRV(u, "❌ <b>Kredit yetmayapti</b>\n\nKerak: {need} kredit\nSizda: {have} kredit\nYetmayapti: {short} kredit\n\nKredit ishlash uchun “📋 Vazifalar” tugmasini bosing — har bir obuna uchun {reward} kredit beriladi.", { need: chk.totalCost, have: u.credits.available, short: chk.shortage, reward: S().creditRewardTelegram }), menuFor(u));
  }
  u.credits.available -= chk.totalCost;
  u.credits.reserved += chk.totalCost;
  u.activeOrdersCount++;
  const o = {
    id: nid("ord"),
    seq: ++db.seq,
    userId: u.id,
    userName: u.displayName,
    destinationId: dest.id,
    destinationTitle: platform === "telegram" ? dest.title : `@${dest.username}`,
    platform,
    requestedQuantity: qty,
    verifiedQuantity: 0,
    pendingQuantity: qty,
    cancelledQuantity: 0,
    unitCost: unit,
    totalCost: chk.totalCost,
    freeUnits: 0,
    status: "active",
    createdAt: nowStr()
  };
  db.orders.push(o);
  platform === "telegram" ? (dest.totalRequested += qty, dest.pendingSubscriptions += qty) : (dest.totalRequested += qty, dest.pendingFollowers += qty);
  moderationScan("order", { userId: u.id, userName: u.displayName, channelId: o.destinationId, title: o.destinationTitle, qty });
  addTx(u, -chk.totalCost, "order_spend", "Buyurtma: " + o.destinationTitle + " x" + qty, { orderId: o.id });
  u.state = null;
  save();
  return send(chat, T(u, "ord_created", { title: esc(o.destinationTitle), qty, total: chk.totalCost }), menuFor(u));
}
async function cancelOrder(u, orderId, chat) {
  const o = db.orders.find((x) => x.id === orderId && x.userId === u.id);
  if (!o || o.status !== "active") return send(chat, TR(u, "Buyurtma topilmadi yoki allaqachon yopilgan."), menuFor(u));
  const { refundableUnits, refundCredits } = calculateRefundAmount(o);
  o.cancelledQuantity += refundableUnits;
  o.pendingQuantity = 0;
  o.status = "cancelled";
  o.completedAt = nowStr();
  u.credits.reserved = Math.max(0, u.credits.reserved - refundCredits);
  u.credits.available += refundCredits;
  u.credits.refunded += refundCredits;
  u.activeOrdersCount = Math.max(0, u.activeOrdersCount - 1);
  for (const t of db.tasks) if (t.orderId === o.id && OPEN.has(t.status)) t.status = "CANCELLED";
  const dest = destOf(o.destinationId);
  if (dest) {
    dest.pendingSubscriptions !== void 0 && (dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - refundableUnits));
    dest.pendingFollowers !== void 0 && (dest.pendingFollowers = Math.max(0, dest.pendingFollowers - refundableUnits));
  }
  addTx(u, refundCredits, "order_refund", `Bekor qilingan buyurtma qaytimi: ${o.destinationTitle}`, { orderId: o.id });
  save();
  return send(chat, TRV(u, "↩️ <b>Buyurtma bekor qilindi</b>\n\nKelgan obunachilar saqlanadi ({verified} ta), bajarilmagan {unfulfilled} ta uchun <b>{refund} kredit</b> qaytarildi.\n{balance}", { verified: o.verifiedQuantity, unfulfilled: refundableUnits, refund: refundCredits, balance: balanceLine(u) }), menuFor(u));
}
async function addChannel(u, text, chat) {
  const uname = text.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{4,}$/.test(uname)) return send(chat, TR(u, "Manzil noto\u2018g\u2018ri. Kanalingiz manzilini yuboring, masalan: <code>@mening_kanalim</code>\n\nBekor qilish: /cancel"));
  const info = await tg("getChat", { chat_id: `@${uname}` });
  if (!info.ok || info.result.type !== "channel") return send(chat, TR(u, "\u274C Bu manzilda kanal topilmadi.\n\nKanal <b>ommaviy (public)</b> bo\u2018lishi va manzili @ bilan yozilishi kerak."));
  const ch = info.result;
  const botMe = await checkBotAdmin(ch.id);
  if (!botMe) return send(chat, TR(u, "\u274C Bot bu kanalda <b>administrator</b> emas.\n\nKanal sozlamalari \u2192 Administratorlar \u2192 botni qo\u2018shib, qayta yuboring."));
  const me = await tg("getChatMember", { chat_id: ch.id, user_id: u.telegramId });
  if (!me.ok || !["creator", "administrator"].includes(me.result.status)) return send(chat, TR(u, "\u274C Siz bu kanalning administratori emassiz.\n\nFaqat o\u2018zingiz boshqaradigan kanalni ulash mumkin."));
  const existing = db.channels.find((c) => c.channelId === String(ch.id));
  if (existing) {
    u.state = null;
    return send(chat, existing.ownerId === u.id ? TR(u, "Bu kanal allaqachon ulangan — qayta ulash shart emas.") : TR(u, "❌ Bu kanal boshqa foydalanuvchida ulangan.\n\nUning egasi sizga bir martalik kod bersa, “🔑 Kod kiritish” orqali nazoratchi bo‘lasiz."), menuFor(u));
  }
  db.channels.push({
    id: nid("ch"),
    channelId: String(ch.id),
    title: ch.title,
    username: ch.username || uname,
    ownerId: u.id,
    ownerName: u.displayName,
    botHasAdminRights: true,
    totalRequested: 0,
    verifiedSubscribers: 0,
    activeSubscribers: 0,
    unsubscribedCount: 0,
    pendingSubscriptions: 0,
    controllers: [],
    status: "active",
    createdAt: nowStr()
  });
  // Bir martalik sovg'a: kanalini birinchi marta ulagan foydalanuvchiga
  const linkBonus = u.channelBonusGiven ? 0 : Math.max(0, Number(S().creditRewardChannelLink) || 0);
  if (linkBonus > 0) {
    u.channelBonusGiven = true;
    u.credits.available += linkBonus;
    addTx(u, linkBonus, "channel_link_bonus", "Kanal ulandi: " + ch.title);
  }
  u.state = null;
  save();
  moderationScan("channel", { userId: u.id, userName: u.displayName, channelId: String(ch.id), title: ch.title, username: ch.username || uname });
  const head = T(u, "ch_added", { title: esc(ch.title), username: esc(ch.username || uname) });
  const tail = linkBonus > 0 ? T(u, "ch_added_bonus", { bonus: linkBonus, bal: u.credits.available }) : "";
  return send(chat, head + tail, menuFor(u));
}
var BOT_ID = 0;
async function checkBotAdmin(chatId) {
  const b = curBot();
  const me = b && b.botId ? b.botId : BOT_ID;
  if (!me) return false;
  const r = await tg("getChatMember", { chat_id: chatId, user_id: me });
  return r.ok && r.result.status === "administrator";
}
async function addInstagram(u, text, chat) {
  const m = text.trim().match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/i) || text.trim().match(/^@?([A-Za-z0-9._]{2,30})$/);
  if (!m) return send(chat, TR(u, "Instagram username yoki havolasini yuboring. Masalan: <code>@my_brand</code>"));
  const username = m[1];
  if (db.igProfiles.some((p) => p.username.toLowerCase() === username.toLowerCase())) {
    u.state = null;
    return send(chat, TR(u, "Bu profil allaqachon ulangan."), menuFor(u));
  }
  db.igProfiles.push({
    id: nid("ig"),
    userId: u.id,
    ownerName: u.displayName,
    profileUrl: `https://instagram.com/${username}`,
    username,
    totalRequested: 0,
    verifiedFollowers: 0,
    selfReportedFollowers: 0,
    pendingFollowers: 0,
    status: "active",
    createdAt: nowStr()
  });
  u.state = null;
  save();
  return send(chat, `\u{1F4F8} @${esc(username)} qo\u2018shildi.`, menuFor(u));
}
async function submitComplaint(u, category, desc, chat) {
  const ticketId = `TICKET-${Math.floor(1e3 + Math.random() * 9e3)}`;
  const dst = u.state && u.state.type === "complaint" ? u.state : {};
  db.complaints.push({
    id: nid("cmp"),
    ticketId,
    userId: u.id,
    userName: u.displayName,
    category,
    description: desc.slice(0, 2e3),
    destinationId: dst.destinationId || null,
    destinationTitle: dst.destinationTitle || "",
    status: "NEW",
    createdAt: nowStr(),
    updatedAt: nowStr()
  });
  moderationScan("complaint", { userId: u.id, userName: u.displayName, channelId: dst.destinationId || "", title: dst.destinationTitle || "" });
  u.state = null;
  save();
  for (const a of ADMIN_IDS) send(a, `\u{1F6DF} Yangi shikoyat <b>${ticketId}</b>
${esc(u.displayName)} (${u.telegramId})
${esc(category)}

${esc(desc.slice(0, 500))}

Javob: <code>/reply ${ticketId} matn</code>`);
  return send(chat, T(u, "cmp_ok", { ticket: ticketId }), menuFor(u));
}
async function enterControllerCode(u, code, chat) {
  u.state = null;
  const now = /* @__PURE__ */ new Date();
  let lastReason = "Kod noto\u2018g\u2018ri.";
  for (const req of db.ctlRequests.filter((r) => r.status === "pending")) {
    const v = validateControllerCode(req, code, now);
    if (v.valid) {
      const ch = db.channels.find((c) => c.id === req.channelId);
      if (!ch || ch.ownerId === u.id) continue;
      req.status = "approved";
      ch.controllers.push({ userId: u.id, displayName: u.displayName, telegramId: u.telegramId, role: "controller", addedAt: nowStr() });
      save();
      notify(userById(ch.ownerId), `\u{1F511} ${esc(u.displayName)} <b>${esc(ch.title)}</b> kanaliga nazoratchi sifatida qo\u2018shildi.`);
      return send(chat, TRV(u, "✅ Kod tasdiqlandi! Siz <b>{title}</b> kanalida nazoratchisiz.", { title: esc(ch.title) }), menuFor(u));
    }
    if (v.reason && !/noto‘g‘ri/.test(v.reason)) lastReason = v.reason;
  }
  return send(chat, `\u274C ${lastReason}`, menuFor(u));
}
function guideText(u) {
  const bonus = Math.max(0, Number(S().creditRewardChannelLink) || 0);
  return T(u, "guide", {
    price: perSub(),
    reward: S().creditRewardTelegram,
    ref: S().creditRewardReferral,
    bonus: bonus > 0 ? T(u, "bonus_line", { bonus }) : ""
  });
}
async function handleMessage(msg) {
  if (msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return;
  const chat = msg.chat.id;
  const text = (msg.text || "").trim();
  const { user: u, isNew } = getUser(msg.from, chat);
  if (u.status === "blocked") {
    if (/^\/appeal/i.test(text)) {
      if (db.appeals.some((a) => a.userId === u.id && a.status === "NEW")) return send(chat, TR(u, "📨 Apellyatsiyangiz allaqachon ko‘rib chiqilmoqda."));
      db.appeals.push({ id: nid("ap"), userId: u.id, userName: u.displayName, text: text.replace(/^\/appeal\s*/i, "").slice(0, 500) || "—", status: "NEW", createdAt: nowStr() });
      save();
      return send(chat, TR(u, "📨 Apellyatsiya qabul qilindi. Admin ko‘rib chiqadi va javob yuboradi."));
    }
    return send(chat, TR(u, "⛔ Hisobingiz bloklangan.\n\nApellyatsiya yuborish: /appeal <sabab/matn>"));
  }
  if (S().isBotPaused && !isAdmin(u.telegramId)) return send(chat, TR(u, "\u23F8 Bot vaqtincha to\u2018xtatilgan. Keyinroq urinib ko\u2018ring."));
  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/)[1] || "";
    if (isNew && /^REF_\d+$/.test(payload) && payload !== u.referralCode) {
      const referrer = db.users[payload.slice(4)];
      if (referrer) {
        u.referredBy = referrer.id;
        db.referrals.push({ id: nid("ref"), referrerId: referrer.id, referrerName: referrer.displayName, referredUserId: u.id, referredUserName: u.displayName, isRegistered: true, hasCompletedTask: false, isVerified: false, bonusIssued: false, bonusAmount: 0, registeredAt: nowStr() });
      }
    }
    u.state = null;
    save();
    if (isNew) {
      await send(chat, T(u, "start_new", { name: esc(u.displayName) }), menuFor(u));
      await send(chat, guideText(u));
    } else {
      await send(chat, T(u, "start_back", { name: esc(u.displayName), balance: balanceLine(u) }), menuFor(u));
    }
    await sponsorGate(u, chat);
    return;
  }
  if (/^\/(tickets|murojaatlar|obrasheniya)/i.test(text)) {
    u.state = null;
    return showMyTickets(u, chat);
  }
  if (/^\/(help|yordam|qollanma)/i.test(text)) {
    u.state = null;
    return showHelp(u, chat);
  }
  if (text.startsWith("/admin") || text.startsWith("/") && isAdmin(u.telegramId)) {
    if (isAdmin(u.telegramId)) return handleAdmin(u, text, chat);
  }
  if (text === "/cancel") {
    u.state = null;
    return send(chat, T(u, "cancelled"), menuFor(u));
  }
  if (LABEL2KEY[text]) u.state = null;
  if (!await sponsorGate(u, chat)) return;
  const st = u.state;
  if (st && !LABEL2KEY[text]) {
    if (st.type === "add_channel") return addChannel(u, text, chat);
    if (st.type === "add_ig") return addInstagram(u, text, chat);
    if (st.type === "order_qty") return prepareOrder(u, st.destId, parseInt(text.replace(/\D/g, ""), 10), chat);
    if (st.type === "ctl_code") return enterControllerCode(u, text, chat);
    if (st.type === "complaint") return submitComplaint(u, st.category, text, chat);
    if (st.type === "support") return submitComplaint(u, "Adminga murojaat (sozlamalar)", text, chat);
  }
  switch (LABEL2KEY[text] || text) {
    case "channels":
      return showChannels(u, chat);
    case "tasks":
      return showTasks(u, "telegram", chat);
    case "orders":
      return showOrders(u, chat);
    case "instagram":
      return showInstagram(u, chat);
    case "referrals":
      return showReferrals(u, chat);
    case "stats":
      return showStats(u, chat);
    case "help":
      return showHelp(u, chat);
    case "settings":
      return showSettings(u, chat);
    default:
      return send(chat, T(u, "choose_menu"), menuFor(u));
  }
}
async function handleCallback(cq) {
  const from = cq.from;
  const chat = cq.message?.chat?.id;
  if (!chat) return;
  tg("answerCallbackQuery", { callback_query_id: cq.id });
  const { user: u } = getUser(from, chat);
  if (u.status === "blocked") return;
  if (S().isBotPaused && !isAdmin(u.telegramId)) return;
  const [cmd, arg] = String(cq.data || "").split(":");
  const key = `${cmd}:${arg}`;
  if (key === "sp:check") {
    if (await sponsorGate(u, chat)) return send(chat, TR(u, "\u2705 Rahmat! Endi botdan foydalanishingiz mumkin."), menuFor(u));
    return;
  }
  if (!await sponsorGate(u, chat)) return;
  switch (cmd) {
    case "tasks":
      return showTasks(u, arg === "ig" ? "instagram" : "telegram", chat);
    case "verify":
      return verifyBatch(u, arg === "ig" ? "instagram" : "telegram", chat);
    case "chadd":
      u.state = { type: "add_channel" };
      return send(chat, T(u, "ch_add_steps"));
    case "igadd":
      u.state = { type: "add_ig" };
      return send(chat, TR(u, "\u{1F4F8} Instagram username yoki havolasini yuboring. Bekor qilish: /cancel"));
    case "ord": {
      const d = destOf(arg);
      if (!d) return;
      const isTg = arg.startsWith("ch-");
      if (isTg && !channelsOf(u).some((c) => c.id === arg)) return;
      if (!isTg && d.userId !== u.id) return;
      u.state = { type: "order_qty", destId: arg };
      const unit = perSub();
      return send(chat, T(u, "ord_qty", {
        title: esc(isTg ? d.title : "@" + d.username),
        unit,
        balance: balanceLine(u),
        max: Math.floor(u.credits.available / Math.max(1, unit))
      }));
    }
    case "ordok": {
      const sc = u.state;
      if (!sc || sc.type !== "order_confirm") return send(chat, TR(u, "Buyurtma ma\u2019lumoti eskirgan. Qaytadan boshlang: Kanallarim \u2192 kanal \u2192 miqdor."), menuFor(u));
      return createOrderConfirmed(u, sc.destId, sc.qty, chat);
    }
    case "ordno":
      u.state = null;
      return send(chat, T(u, "ord_cancelled"), menuFor(u));
    case "cx":
      return send(chat, TR(u, "Buyurtmani bekor qilmoqchimisiz? Bajarilmagan qismi uchun kredit qaytariladi."), inline([[{ text: T(u, "cancel_yes"), callback_data: `cxy:${arg}` }, { text: T(u, "cancel_no"), callback_data: "noop:0" }]]));
    case "cxy":
      return cancelOrder(u, arg, chat);
    case "chd": {
      const ch = channelsOf(u).find((c) => c.id === arg);
      if (!ch) return;
      return showChannelDetail(u, ch, chat);
    }
    case "chs":
      return showChannels(u, chat);
    case "chdel": {
      const ch = db.channels.find((c) => c.id === arg);
      if (!ch || !(ch.ownerId === u.id || (ch.controllers || []).some((k) => k.userId === u.id))) return;
      return send(chat, TRV(u, "🗑 <b>{title}</b> kanalini botdan uzmoqchimisiz?\n\nFaol buyurtmalar bekor qilinadi va bajarilmagan qismining krediti qaytariladi.", { title: esc(ch.title) }), inline([
        [{ text: T(u, "disc_yes"), callback_data: `chdely:${ch.id}` }, { text: T(u, "disc_no"), callback_data: "noop:0" }]
      ]));
    }
    case "chdely": {
      const ch = db.channels.find((c) => c.id === arg);
      if (!ch || !(ch.ownerId === u.id || (ch.controllers || []).some((k) => k.userId === u.id))) return;
      let refunded = 0;
      for (const o of db.orders.filter((x) => x.destinationId === ch.id && x.status === "active")) {
        refunded += cancelOrderAdmin(o).refundCredits || 0;
      }
      db.channels = db.channels.filter((x) => x.id !== ch.id);
      for (const t of db.tasks) if (t.destinationId === ch.id && OPEN.has(t.status)) t.status = "CANCELLED";
      save();
      return send(chat, TRV(u, "✅ <b>{title}</b> uzildi.", { title: esc(ch.title) }) + (refunded ? TRV(u, "\n↩️ {refund} kredit qaytarildi.", { refund: refunded }) : "") + `\n\n${balanceLine(u)}`, menuFor(u));
    }
    case "ctl": {
      const ch = db.channels.find((c) => c.id === arg && c.ownerId === u.id);
      if (!ch) return;
      for (const r of db.ctlRequests) if (r.channelId === ch.id && r.status === "pending") r.status = "expired";
      const code = generateControllerCode();
      db.ctlRequests.push({ channelId: ch.id, requesterId: u.id, requesterName: u.displayName, code, expiresAt: new Date(Date.now() + 5 * 6e4).toISOString(), status: "pending" });
      save();
      return send(chat, `\u{1F511} <b>${esc(ch.title)}</b> uchun bir martalik kod: <code>${code}</code>

Bu kodni nazoratchi bo\u2018ladigan odamga bering. Amal qilish muddati: 5 daqiqa.`);
    }
    case "ctlin":
      u.state = { type: "ctl_code" };
      return send(chat, TR(u, "\u{1F511} 6 xonali kodni yuboring:"));
    case "cmp":
      u.state = { type: "complaint_pick", destinationId: null, destinationTitle: null };
      return send(chat, T(u, "cmp_choose"), inline(CATEGORIES.map((c, i) => [{ text: c, callback_data: `cmpc:${i}` }])));
    case "cmpd": {
      const t = db.tasks.find((x) => x.id === arg && x.assignedTo === u.id);
      u.state = { type: "complaint_pick", destinationId: t ? t.destinationId : null, destinationTitle: t ? t.destinationTitle : null };
      return send(chat, `⚠️ <b>${esc(t ? t.destinationTitle : "—")}</b>\n\n` + T(u, "cmp_choose"), inline(CATEGORIES.map((c, i) => [{ text: c, callback_data: `cmpc:${i}` }])));
    }
    case "cmpc": {
      const c = CATEGORIES[Number(arg)];
      if (!c) return;
      const dst = u.state && u.state.type === "complaint_pick" ? u.state : {};
      u.state = { type: "complaint", category: c, destinationId: dst.destinationId || null, destinationTitle: dst.destinationTitle || null };
      return send(chat, T(u, "cmp_enter", { cat: esc(c) }));
    }
    case "ntall": {
      if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
      const allOn = String(arg) !== "off";
      for (const k of ["subscribers", "referrals", "orders", "technical"]) u.notif[k] = allOn;
      save();
      return showSettings(u, chat);
    }
    case "setmyt":
      return showMyTickets(u, chat);
    case "setrates":
      return showCreditRules(u, chat);
    case "setinfo":
      return showMyData(u, chat);
    case "setsupport":
      u.state = { type: "support" };
      save();
      return send(chat, T(u, "set_support_prompt"));
    case "notif":
      u.notifications = !u.notifications;
      save();
      return showSettings(u, chat);
    case "refa": {
      const [rid, cid] = String(arg || "").split("|");
      const ref = db.referrals.find((r) => r.id === rid && r.referrerId === u.id && !r.bonusIssued);
      if (!ref) return send(chat, TR(u, "Bu bonus allaqachon yo‘naltirilgan yoki topilmadi."), menuFor(u));
      const ch = channelsOf(u).find((c) => c.id === cid);
      if (!ch) return send(chat, TR(u, "Kanal topilmadi."), menuFor(u));
      const r = allocateRefBonus(u, ref, ch);
      return send(chat, TRV(u, "🎁 Referal bonusi <b>{title}</b> kanaliga yo‘naltirildi: <b>{units}</b> ta obunachi navbatga qo‘shildi.", { title: esc(ch.title), units: r.units }), menuFor(u));
    }
    case "lang": {
      if (!STR[arg]) return;
      u.language = arg;
      save();
      await send(chat, T(u, "lang_saved"), menuFor(u));
      return showSettings(u, chat);
    }
    case "nt": {
      if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
      if (!(arg in u.notif)) return;
      u.notif[arg] = u.notif[arg] === false;
      save();
      return showSettings(u, chat);
    }
  }
}
async function handleAdmin(u, text, chat) {
  const [cmd, ...args] = text.split(/\s+/);
  const rest = args.join(" ");
  const done = (m = "OK \u2705") => {
    save();
    return send(chat, m);
  };
  switch (cmd.split("@")[0]) {
    case "/admin":
    case "/stats":
      return send(chat, `\u{1F6E0} <b>Admin</b>
Foydalanuvchilar: ${Object.keys(db.users).length}
Kanallar: ${db.channels.length} \u2022 IG: ${db.igProfiles.length}
Faol buyurtmalar: ${db.orders.filter((o) => o.status === "active").length}
Ochiq vazifalar: ${db.tasks.filter((t) => OPEN.has(t.status)).length}
Yangi shikoyatlar: ${db.complaints.filter((c) => c.status === "NEW").length}
Holat: bot ${S().isBotPaused ? "\u23F8" : "\u25B6\uFE0F"} \u2022 buyurtma ${S().areOrdersFrozen ? "\u{1F9CA}" : "\u2705"} \u2022 IG ${S().isInstagramEnabled ? "yoqilgan" : "o\u2018chiq"}
Mukofot: TG ${S().creditRewardTelegram}, obunachi narxi ${perSub()}, ref ${S().creditRewardReferral}

/pause /resume /freeze /unfreeze /igon /igoff
/addcredits ID SON \u2022 /block ID \u2022 /unblock ID
/broadcast MATN \u2022 /complaints \u2022 /reply TICKET MATN
/sponsor add @kanal | del @kanal | list
/reward tg|ig|ref SON`);
    case "/pause":
      S().isBotPaused = true;
      return done();
    case "/resume":
      S().isBotPaused = false;
      return done();
    case "/freeze":
      S().areOrdersFrozen = true;
      return done();
    case "/unfreeze":
      S().areOrdersFrozen = false;
      return done();
    case "/igon":
      S().isInstagramEnabled = true;
      return done();
    case "/igoff":
      S().isInstagramEnabled = false;
      return done();
    case "/reward": {
      const n = Number(args[1]);
      if (!(n > 0)) return send(chat, "/reward tg|ig|ref SON");
      const k = args[0] === "tg" ? "creditRewardTelegram" : args[0] === "ig" ? "creditRewardInstagram" : args[0] === "ref" ? "creditRewardReferral" : null;
      if (!k) return send(chat, "/reward tg|ig|ref SON");
      S()[k] = n;
      return done();
    }
    case "/addcredits": {
      const t = db.users[args[0]];
      const n = Number(args[1]);
      if (!t || !Number.isFinite(n) || !n) return send(chat, "/addcredits TELEGRAM_ID SON");
      t.credits.available = Math.max(0, t.credits.available + n);
      addTx(t, n, "admin_adjustment", `Admin (${u.displayName})`);
      notify(t, `\u{1F4B0} Hisobingiz ${n > 0 ? "+" : ""}${n} kreditga o\u2018zgartirildi.`);
      return done();
    }
    case "/block":
    case "/unblock": {
      const t = db.users[args[0]];
      if (!t) return send(chat, "Topilmadi");
      t.status = cmd === "/block" ? "blocked" : "active";
      return done();
    }
    case "/broadcast": {
      if (!rest) return send(chat, "/broadcast MATN");
      const list = Object.values(db.users).filter((x) => x.status !== "blocked");
      send(chat, `\u{1F4E3} ${list.length} ta foydalanuvchiga yuborilmoqda...`);
      (async () => {
        let ok = 0;
        for (const x of list) {
          const r = await send(x.chatId, esc(rest));
          if (r.ok) ok++;
          await new Promise((r2) => setTimeout(r2, 40));
        }
        send(chat, `\u{1F4E3} Yuborildi: ${ok}/${list.length}`);
      })();
      return;
    }
    case "/complaints": {
      const l = db.complaints.filter((c) => c.status === "NEW").slice(-10);
      return send(chat, l.length ? l.map((c) => `<b>${c.ticketId}</b> \u2014 ${esc(c.userName)}
${esc(c.category)}
${esc(c.description.slice(0, 200))}`).join("\n\n") : "Yangi shikoyat yo\u2018q.");
    }
    case "/reply": {
      const c = db.complaints.find((x) => x.ticketId === args[0]);
      const body = args.slice(1).join(" ");
      if (!c || !body) return send(chat, "/reply TICKET-1234 MATN");
      c.adminResponse = body;
      c.status = "ANSWERED";
      c.updatedAt = nowStr();
      notify(userById(c.userId), `\u{1F6DF} <b>${c.ticketId}</b> bo\u2018yicha javob:

${esc(body)}`);
      return done();
    }
    case "/sponsor": {
      if (args[0] === "list") return send(chat, db.sponsors.map((s) => `${s.isActive ? "\u{1F7E2}" : "\u26AA"} ${esc(s.title)} @${esc(s.username)}`).join("\n") || "Yo\u2018q");
      const uname = (args[1] || "").replace(/^@/, "");
      if (args[0] === "del") {
        db.sponsors = db.sponsors.filter((s) => s.username !== uname);
        return done();
      }
      if (args[0] === "add" && uname) {
        const info = await tg("getChat", { chat_id: `@${uname}` });
        if (!info.ok) return send(chat, "\u274C Kanal topilmadi");
        if (!await checkBotAdmin(info.result.id)) return send(chat, "\u274C Bot bu kanalda admin emas (obunani tekshirish uchun kerak).");
        db.sponsors.push({ id: nid("sp"), title: info.result.title, username: uname, channelId: String(info.result.id), url: `https://t.me/${uname}`, isMandatory: true, isActive: true, subscribersCount: 0, createdAt: nowStr() });
        return done();
      }
      return send(chat, "/sponsor add @kanal | del @kanal | list");
    }
  }
  return send(chat, "Noma\u2019lum buyruq. /admin");
}
var chains = /* @__PURE__ */ new Map();
function enqueue(uid, fn) {
  const prev = chains.get(uid) || Promise.resolve();
  const next = prev.then(fn).then(() => {
  }, (e) => console.error("handler xato", e)).then(() => {
    if (chains.get(uid) === next) chains.delete(uid);
  });
  chains.set(uid, next);
}
async function hourlyReport() {
  const hour = Math.floor(Date.now() / 36e5);
  if (db.lastHour === 0) {
    db.lastHour = hour;
    return;
  }
  if (hour === db.lastHour) return;
  const from = db.lastHour * 36e5, to = hour * 36e5;
  db.lastHour = hour;
  save();
  if (!S().hourlyNotificationsEnabled) return;
  const per = {};
  for (const e of db.verifyLog) if (e.at >= from && e.at < to) {
    ((per[e.ownerId] ||= {})[e.title] ||= { n: 0, platform: e.platform }).n++;
  }
  const fmt = (ms) => new Date(ms + 5 * 36e5).toISOString().slice(11, 16);
  for (const [uid, items] of Object.entries(per)) {
    const u = userById(uid);
    if (!u || !u.notifications || !notifOn(u, "subscribers")) continue;
    // Idempotentlik: bir soat uchun ikkinchi marta yubormaymiz
    if (u.lastNotifHour === hour) continue;
    u.lastNotifHour = hour;
    const tgN = Object.values(items).filter((i) => i.platform === "telegram").reduce((a, i) => a + i.n, 0);
    const igN = Object.values(items).filter((i) => i.platform === "instagram").reduce((a, i) => a + i.n, 0);
    await notify(u, `\u{1F550} <b>Soatlik hisobot (${fmt(from)} \u2013 ${fmt(to)})</b>

\u{1F4E2} Telegram: +${tgN}
\u{1F4F8} Instagram: +${igN}

` + Object.entries(items).map(([t, i]) => `\u2022 ${esc(t)}: +${i.n}`).join("\n"));
  }
}
async function maintenance() {
  const cutoff = Date.now() - 48 * 36e5;
  for (const t of db.tasks) if (OPEN.has(t.status) && Date.parse(t.createdAt) < cutoff) t.status = "CANCELLED";
  const weekAgo = Date.now() - 7 * 864e5;
  const cand = db.tasks.filter((t) => t.status === "VERIFIED" && t.platform === "telegram" && Date.parse(t.verifiedAt || "") > weekAgo).sort((a, b) => Date.parse(a.checkedAt || "0") - Date.parse(b.checkedAt || "0")).slice(0, 40);
  for (const t of cand) {
    const dest = destOf(t.destinationId);
    const u = userById(t.assignedTo);
    if (!dest || !u) continue;
    const r = await checkMember(dest.channelId, u.telegramId);
    t.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (r === "not_member") {
      t.status = "CANCELLED";
      t.unsubscribed = true;
      const o = db.orders.find((x) => x.id === t.orderId);
      if (o && o.status === "active") {
        o.verifiedQuantity = Math.max(0, o.verifiedQuantity - 1);
        o.pendingQuantity++;
      }
      dest.verifiedSubscribers = Math.max(0, dest.verifiedSubscribers - 1);
      dest.activeSubscribers = Math.max(0, dest.activeSubscribers - 1);
      dest.unsubscribedCount++;
    }
    await new Promise((r2) => setTimeout(r2, 100));
  }
  save();
}
// Har bir bot o'z long-polling tsiklini yuradi, lekin hammasi bitta db'ga yozadi.
var botRuns = /* @__PURE__ */ new Map();
async function pollLoop(bot, token) {
  for (; ; ) {
    if (botRuns.get(bot.id) !== token) return;
    const r = await tgWith(bot, "getUpdates", { offset: bot.offset || 0, timeout: 30, allowed_updates: ["message", "callback_query"] }, 45e3);
    if (!r.ok) {
      bot.lastError = r.description || "getUpdates xatosi";
      console.error(`[${botName(bot)}] getUpdates xato:`, r.description);
      save();
      await new Promise((res) => setTimeout(res, r.error_code === 409 ? 1e4 : 3e3));
      continue;
    }
    if (bot.lastError) {
      bot.lastError = "";
      save();
    }
    for (const up of r.result) {
      bot.offset = up.update_id + 1;
      const from = up.message?.from || up.callback_query?.from;
      if (!from) continue;
      const upd = up;
      enqueue(from.id, () => botCtx.run(bot, () => upd.message ? handleMessage(upd.message) : handleCallback(upd.callback_query)));
    }
    save();
  }
}
var PANEL_PAGE = "";
try {
  PANEL_PAGE = fs.readFileSync(path.join(ROOT, "panel.html"), "utf8");
} catch (e) {
  console.error("panel.html o'qilmadi:", e.message);
}
// --- Admin autentifikatsiya, rollar va audit (spec §17) ---
var ROLE_PERMS = {
  owner: ["*"],
  superadmin: ["read", "users", "channels", "orders", "tasks", "bots", "settings", "complaints", "sponsors", "instagram", "referrals", "moderation", "news", "analytics", "health", "audit", "export"],
  moderator: ["read", "users", "channels", "orders", "tasks", "complaints", "sponsors", "moderation", "analytics"],
  support: ["read", "users", "orders", "complaints", "analytics"],
  analyst: ["read", "analytics", "health"]
};
function can(role, perm) {
  const list = ROLE_PERMS[role] || [];
  return list.includes("*") || list.includes(perm);
}
var SESSIONS = new Map();
var SESSION_TTL = 12 * 36e5;
function hashPass(pw, salt) {
  const s = salt || crypto.randomBytes(8).toString("hex");
  return s + ":" + crypto.scryptSync(String(pw), s, 32).toString("hex");
}
function checkPass(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt] = stored.split(":");
  const calc = hashPass(pw, salt);
  const a = Buffer.from(calc), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieOf(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}
function sessionOf(req) {
  const tok = cookieOf(req, "sid");
  if (!tok) return null;
  const s2 = SESSIONS.get(tok);
  if (!s2) return null;
  if (s2.exp < Date.now()) {
    SESSIONS.delete(tok);
    return null;
  }
  return s2;
}
function authed(req) {
  req.auth = sessionOf(req);
  if (req.auth) return true;
  const h = req.headers.authorization || "";
  if (!ADMIN_PASSWORD || !h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    req.auth = { username: "admin", role: "owner", exp: Date.now() + SESSION_TTL };
    return true;
  }
  return false;
}
function readRawBody(req, limit = 2e4) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on("end", () => resolve(data));
  });
}
function checkPassPlain(input, expected) {
  const a = Buffer.from(String(input)), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function audit(req, action, target, meta) {
  try {
  const who = (req && req.auth) || {};
  const h = (req && req.headers) || {};
  db.auditLog.push({
    id: nid("log"),
    at: nowStr(),
    actor: who.username || "admin",
    role: who.role || "owner",
    action: String(action || ""),
    target: String(target || ""),
    meta: meta ? String(meta).slice(0, 300) : "",
    ip: String(h["x-forwarded-for"] || "").split(",")[0].trim()
  });
  if (db.auditLog.length > 5000) db.auditLog.splice(0, 1000);
  save();
  } catch (e) {
    console.error("audit xatosi:", e.message);
  }
}
var SESSION_TTL_LONG = 30 * 24 * 36e5;
var LOGIN_TRIES = new Map();
var LOGIN_MAX = 6;
var LOGIN_WINDOW = 15 * 6e4;
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || "anonim";
}
function loginGate(ip) {
  const r = LOGIN_TRIES.get(ip);
  if (!r) return { blocked: false };
  const spent = Date.now() - r.first;
  if (spent > LOGIN_WINDOW) {
    LOGIN_TRIES.delete(ip);
    return { blocked: false };
  }
  if (r.n >= LOGIN_MAX) return { blocked: true, minutesLeft: Math.max(1, Math.ceil((LOGIN_WINDOW - spent) / 6e4)) };
  return { blocked: false };
}
function loginFail(ip) {
  const now = Date.now();
  const r = LOGIN_TRIES.get(ip);
  if (!r || now - r.first > LOGIN_WINDOW) LOGIN_TRIES.set(ip, { n: 1, first: now });
  else r.n++;
  if (LOGIN_TRIES.size > 800) LOGIN_TRIES.clear();
  const cur = LOGIN_TRIES.get(ip);
  return Math.max(0, LOGIN_MAX - (cur ? cur.n : 0));
}
function loginOk(ip) {
  LOGIN_TRIES.delete(ip);
}
// Egasi: ADMIN_EMAIL (yoki "admin"/"owner") + ADMIN_PASSWORD.
// ADMIN_EMAIL berilmagan bo'lsa eski xatti-harakat — faqat parol tekshiriladi.
function ownerLoginOk(uname, pass) {
  if (!pass || !ADMIN_PASSWORD) return false;
  if (!checkPassPlain(pass, ADMIN_PASSWORD)) return false;
  if (!ADMIN_EMAIL) return true;
  return uname === ADMIN_EMAIL || uname === "admin" || uname === "owner";
}
function isSecureReq(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" || !!(req.socket && req.socket.encrypted);
}
function loginPage(err) {
  return `<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#080b11">
<title>Kirish — Obuna 2X</title>
<style>
:root{color-scheme:dark;--bg:#070a10;--card:#0f1420;--line:#1d2636;--txt:#e9eef7;--dim:#8a98ad;--accent:#5b7cfa;--accent2:#8b5cf6;--err:#fca5a5}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:22px;background:var(--bg);color:var(--txt);
font-family:"Inter","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before,body::after{content:"";position:fixed;z-index:0;border-radius:50%;filter:blur(80px);opacity:.55;pointer-events:none}
body::before{width:460px;height:460px;left:-150px;top:-170px;background:radial-gradient(circle,#22437f,transparent 66%)}
body::after{width:420px;height:420px;right:-150px;bottom:-180px;background:radial-gradient(circle,#4a2c88,transparent 66%)}
.grid{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5;
background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
background-size:46px 46px;mask-image:radial-gradient(circle at 50% 35%,#000 0%,transparent 72%)}
.wrap{position:relative;z-index:1;width:100%;max-width:404px}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:22px;padding-left:4px}
.brand .mark{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-weight:800;font-size:14px;color:#fff;
background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 10px 26px rgba(91,124,250,.4)}
.brand b{font-size:15px;letter-spacing:-.2px;display:block;line-height:1.2}
.brand span{font-size:11.5px;color:var(--dim);letter-spacing:.3px}
.card{background:linear-gradient(180deg,#121826,#0d1220);border:1px solid var(--line);border-radius:20px;padding:28px 26px 24px;
box-shadow:0 28px 70px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.04) inset}
h1{font-size:21px;margin:0 0 6px;letter-spacing:-.35px;font-weight:700}
.sub{color:var(--dim);font-size:13px;margin:0 0 22px;line-height:1.5}
label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.45px;text-transform:uppercase;color:#95a3b9;margin:0 0 7px}
.f{margin-bottom:15px}
.inp{position:relative;display:flex;align-items:center}
input[type=text],input[type=email],input[type=password]{width:100%;padding:12px 13px;border-radius:11px;border:1px solid #222c3e;background:#090e17;color:var(--txt);
font:inherit;font-size:14px;transition:border-color .16s,box-shadow .16s,background .16s;outline:none}
input::placeholder{color:#56637a}
input:hover{border-color:#2b374d}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(91,124,250,.16);background:#0a101b}
input:-webkit-autofill{-webkit-text-fill-color:var(--txt);-webkit-box-shadow:0 0 0 1000px #0a101b inset;caret-color:var(--txt)}
.inp input[type=password],.inp input#password{padding-right:46px}
.eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:9px;
background:transparent;color:#7c8aa1;cursor:pointer;transition:.15s;font-size:15px}
.eye:hover{background:#151d2c;color:#c8d3e5}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:4px 0 18px}
.chk{display:flex;align-items:center;gap:9px;color:#9aa8bd;font-size:12.5px;font-weight:500;letter-spacing:0;text-transform:none;cursor:pointer;user-select:none;margin:0}
.chk input{width:15px;height:15px;accent-color:var(--accent);margin:0;cursor:pointer}
.btn{position:relative;width:100%;padding:12px 16px;border:0;border-radius:11px;color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer;
background:linear-gradient(180deg,#4f6fff,#2a4de0);box-shadow:0 10px 24px rgba(42,77,224,.34);transition:.16s;display:flex;align-items:center;justify-content:center;gap:9px}
.btn:hover{filter:brightness(1.08)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.75;cursor:default}
.spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:sp .7s linear infinite;display:none}
.btn.busy .spin{display:block}
@keyframes sp{to{transform:rotate(360deg)}}
.alert{display:none;gap:9px;align-items:flex-start;margin:0 0 16px;padding:11px 12px;border-radius:11px;font-size:12.5px;line-height:1.45;
background:rgba(248,113,113,.09);border:1px solid rgba(248,113,113,.28);color:var(--err)}
.alert.show{display:flex}
.caps{display:none;margin:-6px 0 10px;font-size:11.5px;color:#fcd34d}
.caps.show{display:block}
.foot{margin-top:16px;text-align:center;color:#5b6779;font-size:11.5px;line-height:1.6}
.foot b{color:#7b8798;font-weight:600}
@media(max-width:420px){.card{padding:24px 18px 20px;border-radius:18px}h1{font-size:19px}}
@media(prefers-reduced-motion:reduce){*{transition:0s!important;animation:0s!important}}
</style></head>
<body>
<div class="grid"></div>
<div class="wrap">
  <div class="brand"><div class="mark">2X</div><div><b>Obuna 2X</b><span>boshqaruv paneli</span></div></div>
  <form class="card" id="f" method="POST" action="/login" novalidate>
    <h1>Xush kelibsiz</h1>
    <p class="sub">Davom etish uchun administrator hisobingizga kiring.</p>
    <div class="alert ${err ? "show" : ""}" id="err"><span>⚠️</span><span id="err-txt">${err}</span></div>
    <div class="f">
      <label for="username">Email yoki login</label>
      <div class="inp"><input id="username" name="username" type="text" inputmode="email" autocomplete="username" spellcheck="false" placeholder="email@example.com" required autofocus></div>
    </div>
    <div class="f">
      <label for="password">Parol</label>
      <div class="inp">
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required>
        <button class="eye" type="button" id="eye" aria-label="Parolni ko'rsatish" title="Parolni ko'rsatish">👁</button>
      </div>
      <div class="caps" id="caps">Caps Lock yoqilgan</div>
    </div>
    <div class="row">
      <label class="chk"><input type="checkbox" name="remember" value="1" id="remember"> 30 kun eslab qol</label>
    </div>
    <button class="btn" type="submit" id="go"><span class="spin"></span><span id="go-txt">Kirish</span></button>
    <div class="foot">Faqat administratorlar uchun · <b>xavfsiz ulanish</b></div>
  </form>
</div>
<script>
(function () {
  var f = document.getElementById('f');
  var user = document.getElementById('username');
  var pass = document.getElementById('password');
  var go = document.getElementById('go');
  var goTxt = document.getElementById('go-txt');
  var err = document.getElementById('err');
  var errTxt = document.getElementById('err-txt');
  var caps = document.getElementById('caps');
  var remember = document.getElementById('remember');

  try {
    var saved = localStorage.getItem('2x_login');
    if (saved) { user.value = saved; remember.checked = true; }
  } catch (e) {}

  function showError(msg) {
    errTxt.textContent = msg;
    err.classList.add('show');
  }
  function clearError() { err.classList.remove('show'); }
  function busy(on) {
    go.disabled = on;
    go.classList.toggle('busy', on);
    goTxt.textContent = on ? 'Tekshirilmoqda…' : 'Kirish';
  }

  document.getElementById('eye').addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    this.textContent = show ? '🙈' : '👁';
    this.setAttribute('aria-label', show ? "Parolni yashirish" : "Parolni ko'rsatish");
    pass.focus();
  });

  pass.addEventListener('keyup', function (e) {
    caps.classList.toggle('show', e.getModifierState && e.getModifierState('CapsLock'));
  });
  pass.addEventListener('blur', function () { caps.classList.remove('show'); });
  [user, pass].forEach(function (el) { el.addEventListener('input', clearError); });

  f.addEventListener('submit', function (ev) {
    var u = user.value.trim();
    var p = pass.value;
    if (!u || !p) {
      ev.preventDefault();
      showError("Email/login va parolni kiriting.");
      (u ? pass : user).focus();
      return;
    }
    if (!window.fetch) return;
    ev.preventDefault();
    clearError();
    busy(true);
    fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: u, password: p, remember: remember.checked })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok && d && d.ok) {
          try {
            if (remember.checked) localStorage.setItem('2x_login', u);
            else localStorage.removeItem('2x_login');
          } catch (e) {}
          location.replace(d.next || '/');
          return;
        }
        busy(false);
        showError((d && d.error) || 'Kirish amalga oshmadi. Qayta urinib ko\\'ring.');
        pass.select();
      });
    }).catch(function () {
      busy(false);
      showError("Serverga ulanib bo'lmadi. Internetni tekshirib, qayta urinib ko'ring.");
    });
  });
})();
</script>
</body></html>`;
}
// --- Admin panel API yordamchilari ---
var startedAt = Date.now();
function jsonOut(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    return new URL(o).host === (req.headers.host || "");
  } catch {
    return false;
  }
}
function uptimeStr() {
  const s = Math.floor((Date.now() - startedAt) / 1e3);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return `${d}d ${h}h ${m}m`;
}
function maskToken(t) {
  t = String(t || "");
  if (!t) return "";
  return t.length <= 14 ? t.slice(0, 4) + "…" : t.slice(0, 6) + "…" + t.slice(-4);
}
function botView(b) {
  return {
    id: b.id,
    role: b.role || "worker",
    label: botName(b),
    username: b.username || "",
    botId: b.botId || "",
    enabled: !!b.enabled,
    online: botRuns.has(b.id),
    tokenMasked: maskToken(b.token),
    lastError: b.lastError || "",
    createdAt: b.createdAt || ""
  };
}
function cancelOrderAdmin(o) {
  const owner = userById(o.userId);
  const { refundableUnits, refundCredits } = calculateRefundAmount(o);
  o.cancelledQuantity += refundableUnits;
  o.pendingQuantity = 0;
  o.status = "cancelled";
  o.completedAt = nowStr();
  if (owner) {
    owner.credits.reserved = Math.max(0, owner.credits.reserved - refundCredits);
    owner.credits.available += refundCredits;
    owner.credits.refunded += refundCredits;
    owner.activeOrdersCount = Math.max(0, owner.activeOrdersCount - 1);
    addTx(owner, refundCredits, "order_refund", `Admin bekor qildi: ${o.destinationTitle}`, { orderId: o.id });
    notify(owner, `\u21A9\uFE0F Buyurtmangiz admin tomonidan bekor qilindi.\n${esc(o.destinationTitle)}\n${refundableUnits} ta uchun <b>${refundCredits}</b> kredit qaytarildi.`);
  }
  for (const t of db.tasks) if (t.orderId === o.id && OPEN.has(t.status)) t.status = "CANCELLED";
  const dest = destOf(o.destinationId);
  if (dest) {
    if (dest.pendingSubscriptions !== void 0) dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - refundableUnits);
    if (dest.pendingFollowers !== void 0) dest.pendingFollowers = Math.max(0, dest.pendingFollowers - refundableUnits);
  }
  save();
  return { refundCredits, refundableUnits };
}
// --- Moderatsiya skaneri (spec §16) ---
// Bot kanal kontentini o'qiy olmaydi — faqat nom/username, tezlik va shikoyat
// signallari tekshiriladi. Yakuniy qaror har doim admin tomonidan qabul qilinadi.
var MOD_BAD = [
  "scam", "casino", "kazino", "porn", "adult", "18+", "betting", "stavka",
  "giveaway", "lottery", "pump", "signal", "free money", "soxta", "fake subs",
  "obunachi sotamiz", "kripto signal", "invest 100"
];
var modSeen = new Map();
function modFlag(kind, reason, data, severity) {
  const key = kind + "|" + reason + "|" + (data.channelId || data.userId || data.username || "");
  const now = Date.now();
  const last = modSeen.get(key) || 0;
  if (now - last < 6 * 36e5) return null;
  modSeen.set(key, now);
  const flag = {
    id: nid("mf"),
    at: nowStr(),
    kind,
    reason,
    severity: severity || "medium",
    userId: data.userId || "",
    userName: data.userName || "",
    channelId: data.channelId || "",
    title: data.title || data.username || "",
    status: "OPEN"
  };
  db.moderationFlags = db.moderationFlags || [];
  db.moderationFlags.push(flag);
  if (db.moderationFlags.length > 1000) db.moderationFlags.splice(0, 300);
  save();
  for (const a of ADMIN_IDS) {
    send(a, "\u{1F6E1}\uFE0F <b>Moderatsiya signali</b>\n\n" + esc(kind) + " \u2022 " + esc(severity || "medium") + "\n" + esc(reason) + "\n" + esc(flag.title) + " (" + esc(flag.userName || flag.userId) + ")");
  }
  return flag;
}
function hasBadWord(text) {
  const t = String(text || "").toLowerCase();
  return MOD_BAD.find((w) => t.includes(w)) || "";
}
function moderationScan(kind, data) {
  data = data || {};
  if (kind === "channel" || kind === "instagram") {
    const bad = hasBadWord(data.title) || hasBadWord(data.username);
    if (bad) return modFlag(kind, "Taqiqlangan so'z: " + bad, data, "high");
    if (kind === "channel" && data.userId) {
      const day = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      const recent = db.channels.filter((c) => c.ownerId === data.userId && String(c.createdAt || "") >= day).length;
      if (recent >= 3) return modFlag(kind, "Bir kunda " + recent + " ta kanal ulandi", data, "medium");
    }
    return null;
  }
  if (kind === "order") {
    if (Number(data.qty) >= 5000) return modFlag(kind, "Juda katta buyurtma: " + data.qty, data, "medium");
    return null;
  }
  if (kind === "complaint") {
    const chId = data.channelId;
    if (!chId) return null;
    const since = Date.now() - 864e5;
    const n = db.complaints.filter((c) => c.destinationId === chId && Date.parse(c.createdAt) >= since).length;
    if (n >= 3) return modFlag(kind, "Kanalga 24 soatda " + n + " ta shikoyat", data, "high");
    return null;
  }
  return null;
}
// --- News bot: Gemini bilan yangilik yaratib, kanalga post qiladi ---
// Token faqat env'dan (repo'ga yozilmaydi)
var NEWS_TOKEN = (process.env.NEWS_BOT_TOKEN || "").trim();
var newsBotInfo = { username: "", id: "" };
// Model cooldown: 429/404/503 bo'lgan modellar vaqtincha o'tkazib yuboriladi,
// shunda world-news-bot bitta modelning limitiga bog'liq bo'lib qolmaydi.
var newsModelCooldown = new Map();
function newsModelReady(m) {
  const until = newsModelCooldown.get(m) || 0;
  return Date.now() >= until;
}
function newsModelCooldownSet(m, ms) {
  newsModelCooldown.set(m, Date.now() + ms);
}
function newsDefaults() {
  return {
    enabled: true,
    channel: "@Dunyo_Yangiliklari_Texno",
    times: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.1-flash-lite-preview", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-2.5-flash", "gemini-2.5-flash-lite", "antigravity-preview-latest"],
    apiKey: process.env.GEMINI_API_KEY || "",
    sent: [],
    history: [],
    lastPostAt: "",
    lastStatus: "",
    lastModel: "",
    lastError: ""
  };
}
function newsCfg() {
  if (!S().news || typeof S().news !== "object") S().news = newsDefaults();
  const n = S().news;
  const d = newsDefaults();
  for (const k of Object.keys(d)) if (n[k] === void 0) n[k] = d[k];
  if (!Array.isArray(n.times)) n.times = d.times;
  if (!Array.isArray(n.models) || !n.models.length) {
    n.models = n.model ? [String(n.model)].concat(d.models) : d.models.slice();
  }
  delete n.model;
  if (!Array.isArray(n.sent)) n.sent = [];
  if (!Array.isArray(n.history)) n.history = [];
  if (!n.apiKey && process.env.GEMINI_API_KEY) n.apiKey = process.env.GEMINI_API_KEY;
  // Eski (world-news-bot) sozlamalarini yangi botga ko'chirish
  const legacyTimes = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "19:30", "21:00", "22:30", "00:00"];
  if (n.channel === "@WORLD_NEWS_1M") n.channel = d.channel;
  if (n.times.join(",") === legacyTimes.join(",")) n.times = d.times.slice();
  return n;
}
async function newsTg(method, params = {}, timeoutMs = 35e3) {
  if (!NEWS_TOKEN) return { ok: false, description: "NEWS_BOT_TOKEN o'rnatilmagan" };
  try {
    const r = await fetch(`${API}/bot${NEWS_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return await r.json().catch(() => ({ ok: false, description: "javob o'qilmadi" }));
  } catch (e) {
    return { ok: false, description: e.message, network: true };
  }
}
function slotToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function uzbNowMinutes() {
  const t = new Date(Date.now() + 5 * 3600e3);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}
function uzbNow() {
  const t = new Date(Date.now() + 5 * 3600e3);
  const p = (x) => String(x).padStart(2, "0");
  const date = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
  const time = `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  return { date, time, full: `${date} ${time}` };
}
async function newsHeadlines() {
  const q = process.env.NEWS_RSS_QUERY || "technology";
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:1d")}&hl=en-US&gl=US&ceid=US:en`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20e3)
    });
    const t = await r.text();
    const titles = [...t.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)].map((m) => m[1]).slice(1);
    return titles.map((x) => x.replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim()).filter(Boolean).slice(0, 10);
  } catch (e) {
    console.error("News bot: RSS xatosi ->", e.message);
    return [];
  }
}
async function newsGemini(cfg, model, prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2500, temperature: 0.9 }
    }),
    signal: AbortSignal.timeout(75e3)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = String((j.error && j.error.message) || "xato");
    const err = new Error(`Gemini ${r.status}: ${msg.slice(0, 160)}`);
    err.status = r.status;
    throw err;
  }
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map((p) => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini bo'sh javob qaytardi");
  return text;
}
async function newsGenerate(cfg) {
  if (!cfg.apiKey) throw new Error("Gemini API kaliti yo'q - /news sahifasida kiriting");
  const last = cfg.history.slice(0, 12).map((h) => h.title).join("; ");
  const heads = await newsHeadlines();
  const prompt = `Sen o'zbek tilidagi texno-blogersan. Bugungi IT/texnologiya yangiligidan bitta post yoz.` +
    (heads.length ? ` Bugungi sarlavhalar: ${heads.join(" | ")}. Shu sarlavhalardan eng qiziqarlisini tanla va o'zbek tilida tushuntir.` : " Eng so'nggi IT yangiligini top.") +
    ` Oldingi mavzularni takrorlama: ${last || "yo'q"}.` +
    ` Faqat texnologiya, AI, gadjet yoki dasturiy ta'minotga oid yangilikni tanla — janjal, siyosat, sport va shaxsiy hayot haqida yozma.` +
    ` Post 700 belgidan oshmasin, emoji ko'p bo'lsin, oxirida "IMAGE_URL: <rasm havolasi>" qatorini qo'sh.`;
  const errors = [];
  // Avval cooldown tugagan (tirik) modellarni sinab ko'ramiz; bo'lmasa hammasini.
  const live = cfg.models.filter((m) => newsModelReady(m));
  const order = live.length ? live : cfg.models.slice();
  for (const model of order) {
    try {
      const text = await newsGemini(cfg, model, prompt);
      cfg.lastModel = model;
      return text;
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      console.error(`News bot: ${model} ishlamadi -> ${e.message}`);
      const status = Number(e && e.status) || 0;
      const msg = String(e && e.message || "");
      let ms = 5 * 60e3; // default 5 min
      if (status === 404 || /no longer available/i.test(msg)) ms = 24 * 3600e3;
      else if (status === 429) ms = 60 * 60e3;
      else if (status === 401 || status === 403) ms = 24 * 3600e3;
      newsModelCooldownSet(model, ms);
    }
  }
  throw new Error(`Barcha modellar ishlamadi: ${errors.slice(0, 3).join(" | ")}`);
}
async function newsPublish(trigger, dry) {
  const cfg = newsCfg();
  cfg.lastStatus = "yaratilmoqda";
  try {
    const raw = await newsGenerate(cfg);
    let body = raw.trim();
    let image = "";
    const m = raw.match(/IMAGE_URL:\s*(\S+)/i);
    if (m) {
      image = m[1].trim();
      body = raw.replace(/IMAGE_URL:.*$/im, "").trim();
    }
    if (dry) {
      cfg.lastStatus = "sinov";
      cfg.lastError = "";
      save();
      return { ok: true, dry: true, text: body, model: cfg.lastModel };
    }
    const html = newsToHtml(body);
    let sent;
    if (image) {
      sent = await newsTg("sendPhoto", { chat_id: cfg.channel, photo: image, caption: html.slice(0, 1024), parse_mode: "HTML" });
      if (!sent.ok) sent = await newsTg("sendMessage", { chat_id: cfg.channel, text: html.slice(0, 4096), parse_mode: "HTML" });
    } else {
      sent = await newsTg("sendMessage", { chat_id: cfg.channel, text: html.slice(0, 4096), parse_mode: "HTML" });
    }
    // HTML rad etilsa — formatlashsiz qayta yuborish (post baribir chiqsin)
    if (!sent.ok && /can't parse entities|unsupported start tag|Unclosed/i.test(sent.description || "")) {
      const plain = newsStripTags(html);
      sent = image
        ? await newsTg("sendPhoto", { chat_id: cfg.channel, photo: image, caption: plain.slice(0, 1024) })
        : await newsTg("sendMessage", { chat_id: cfg.channel, text: plain.slice(0, 4096) });
    }
    if (!sent.ok) throw new Error(sent.description || "Telegram xatosi");
    const stamp = uzbNow();
    cfg.lastPostAt = stamp.full;
    cfg.lastStatus = "yuborildi";
    cfg.lastError = "";
    cfg.history.unshift({ at: stamp.full, title: body.split("\n")[0].slice(0, 80), trigger: trigger || "jadval" });
    cfg.history = cfg.history.slice(0, 50);
    save();
    console.log(`News bot: post yuborildi (${cfg.channel}, ${trigger || "jadval"}, model: ${cfg.lastModel || "-"})`);
    return { ok: true, text: body };
  } catch (e) {
    cfg.lastStatus = "xato";
    cfg.lastError = e.message;
    save();
    console.error("News bot xatosi:", e.message);
    return { ok: false, error: e.message };
  }
}
// Gemini matnidagi **qalin** belgilarini Telegram HTML'iga aylantiradi.
// Avval HTML belgilari qochiriladi, keyin qalinlashtirish qo'llanadi — shunda
// matndagi < & > belgilari parse xatosiga sabab bo'lmaydi.
function newsToHtml(text) {
  const safe = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return safe.replace(/\*\*([^*\n]{1,200})\*\*/g, "<b>$1</b>");
}
function newsStripTags(html) {
  return String(html || "").replace(/<\/?b>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function startNewsScheduler() {
  const cfg = newsCfg();
  if (!NEWS_TOKEN) {
    console.error("News bot: NEWS_BOT_TOKEN o'rnatilmagan");
    return;
  }
  newsTg("getMe").then((me) => {
    if (me.ok) {
      newsBotInfo = { username: me.result.username, id: String(me.result.id) };
      console.log(`News bot @${me.result.username} ulandi (kanal: ${newsCfg().channel})`);
    } else {
      console.error("News bot getMe xatosi:", me.description);
    }
  });
  setInterval(async () => {
    const c = newsCfg();
    if (!c.enabled) return;
    const t = uzbNow();
    // 1) Joriy daqiqa jadvalga to‘g‘ri kelsa — post qilamiz.
    let due = c.times.includes(t.time) && !c.sent.includes(`${t.date} ${t.time}`) ? t.time : null;
    // 2) Instansiya uxlab qolgan bo‘lsa, oxirgi 20 daqiqa ichidagi o‘tkazib
    //    yuborilgan slotni qoplaymiz (aks holda o‘sha post butunlay yo‘qoladi).
    if (!due) {
      const nowMin = uzbNowMinutes();
      const missed = c.times
        .map((s) => ({ s, m: slotToMinutes(s) }))
        .filter((x) => x.m <= nowMin && nowMin - x.m <= 20)
        .sort((a, b) => b.m - a.m);
      for (const m of missed) {
        if (!c.sent.includes(`${t.date} ${m.s}`)) {
          due = m.s;
          break;
        }
      }
    }
    if (!due) return;
    c.sent.push(`${t.date} ${due}`);
    c.sent = c.sent.slice(-200);
    save();
    await newsPublish(due === t.time ? "jadval" : `kechikkan ${due}`);
  }, 30e3);
  console.log(`News bot jadvali: ${cfg.times.join(", ")} (${cfg.channel})`);
}
function readJsonBody(req, limit = 1e5) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) data = data.slice(0, limit);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
var NEWS_PAGE = `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yangiliklar boti</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.5 system-ui,Segoe UI,Arial;background:#0f1115;color:#e7e9ee}
.wrap{max-width:780px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.muted{color:#8b93a7;font-size:13px}
.card{background:#171a21;border:1px solid #242936;border-radius:12px;padding:16px;margin:16px 0}
label{display:block;font-size:13px;color:#a8b0c2;margin:10px 0 4px}
input,textarea,select{width:100%;box-sizing:border-box;background:#0f1219;border:1px solid #2b3243;color:#e7e9ee;border-radius:8px;padding:9px 10px;font:inherit}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:180px}
button{background:#2f6bff;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;cursor:pointer}
button.ghost{background:#222937}button:disabled{opacity:.55;cursor:default}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;background:#1f2531;color:#a8b0c2}
.pill.ok{background:#12351f;color:#6ee7a0}.pill.err{background:#3a1414;color:#ff9b9b}
ul{list-style:none;padding:0;margin:8px 0 0}li{padding:7px 0;border-bottom:1px solid #1f2531;font-size:13px}
pre{white-space:pre-wrap;background:#0f1219;border:1px solid #2b3243;border-radius:8px;padding:10px;font-size:13px;max-height:240px;overflow:auto}
</style></head><body><div class="wrap">
<h1>Yangiliklar boti</h1>
<div class="muted">Gemini bilan post yaratib, kanalga yuboradi · <a href="/" style="color:#7aa2ff">asosiy panel</a></div>
<div class="card">
  <div><span id="state" class="pill">yuklanmoqda…</span> <span id="who" class="muted"></span></div>
  <label>Holat</label>
  <select id="enabled"><option value="1">Yoqilgan</option><option value="0">To'xtatilgan</option></select>
  <div class="row">
    <div><label>Kanal (@yoki -100…)</label><input id="channel" placeholder="@Dunyo_Yangiliklari_Texno"></div>
    <div><label>Modellar (tartib bo'yicha)</label><input id="models" placeholder="gemini-3.1-flash-lite, gemini-3.5-flash-lite"></div>
  </div>
  <label>Gemini API kaliti</label><input id="apiKey" type="password" placeholder="o'zgarmasin desangiz bo'sh qoldiring">
  <label>Jadval (vergul bilan, Asia/Tashkent)</label><input id="times" placeholder="08:00, 12:00, 18:00">
  <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
    <button id="save">Saqlash</button>
    <button id="post" class="ghost">Hozir post qil</button>
    <button id="dry" class="ghost">Sinov (post qilmasdan)</button>
  </div>
</div>
<div class="card"><div id="last" class="muted">Oxirgi post: —</div><pre id="log" hidden></pre><ul id="hist"></ul></div>
</div>
<script>
const $=(s)=>document.querySelector(s);
async function load(){
 const r=await fetch('/api/news');const d=await r.json();
 $('#enabled').value=d.enabled?'1':'0';$('#channel').value=d.channel||'';$('#models').value=(d.models||[]).join(', ');
 $('#times').value=(d.times||[]).join(', ');
 $('#apiKey').placeholder=d.hasKey?('kalit bor ('+d.keySource+') - o\'zgartirmasangiz bo\'sh qoldiring'):'kalit yo\'q - kiriting';
 $('#who').textContent=d.bot.username?('@'+d.bot.username):'bot ulanmagan';
 const st=$('#state');st.textContent=d.lastStatus||'tayyor';
 st.className='pill '+(d.lastStatus==='xato'?'err':(d.lastStatus==='yuborildi'?'ok':''));
 $('#last').textContent='Oxirgi post: '+(d.lastPostAt||'—')+(d.lastModel?(' · model: '+d.lastModel):'')+(d.lastError?(' · xato: '+d.lastError):'');
 $('#hist').innerHTML=(d.history||[]).map(h=>'<li><b>'+h.at+'</b> · '+h.title+' <span class="muted">('+h.trigger+')</span></li>').join('')||'<li class="muted">Tarix bo\'sh</li>';
}
$('#save').onclick=async()=>{
 $('#save').disabled=true;
 const body={enabled:$('#enabled').value==='1',channel:$('#channel').value.trim(),models:$('#models').value.trim(),times:$('#times').value,apiKey:$('#apiKey').value};
 const r=await fetch('/api/news',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const d=await r.json();$('#save').disabled=false;
 if(!d.ok) alert(d.error||'xato'); else { $('#apiKey').value=''; load(); }
};
$('#dry').onclick=async()=>{
 $('#dry').disabled=true;const st=$('#state');st.textContent='sinov…';st.className='pill';
 const r=await fetch('/api/news/post?dry=1',{method:'POST'});const d=await r.json();
 $('#dry').disabled=false;load();
 $('#log').hidden=false;$('#log').textContent=d.ok?('Model: '+d.model+'\n\n'+d.text):('Xato: '+d.error);
};
$('#post').onclick=async()=>{
 $('#post').disabled=true;const st=$('#state');st.textContent='yuborilmoqda…';st.className='pill';
 const r=await fetch('/api/news/post',{method:'POST'});const d=await r.json();
 $('#post').disabled=false;load();
 $('#log').hidden=false;$('#log').textContent=d.ok?('Yuborildi:\n\n'+d.text):('Xato: '+d.error);
};
load();
</script></body></html>`;
var server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("ok " + STORAGE);
    return;
  }
  if (!ADMIN_PASSWORD) {
    res.writeHead(503);
    res.end("ADMIN_PASSWORD o\u2018rnatilmagan");
    return;
  }
  if (url.pathname === "/login") {
    if (req.method === "POST") {
      return readRawBody(req).then((raw) => {
        const isJson = String(req.headers["content-type"] || "").includes("application/json");
        const fail = (code, msg) => {
          if (isJson) return jsonOut(res, code, { ok: false, error: msg });
          res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
          res.end(loginPage(msg));
        };
        if (!sameOrigin(req)) return fail(403, "So‘rov boshqa saytdan yuborilgan — rad etildi.");
        const ip = clientIp(req);
        const gate = loginGate(ip);
        if (gate.blocked) return fail(429, "Juda ko‘p urinish. " + gate.minutesLeft + " daqiqadan keyin qayta urinib ko‘ring.");
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          const p = new URLSearchParams(raw || "");
          body = { username: p.get("username") || "", password: p.get("password") || "", remember: p.get("remember") === "1" };
        }
        const uname = String((body && body.username) || "").trim().toLowerCase();
        const pass = String((body && body.password) || "");
        const remember = !!(body && (body.remember === true || body.remember === "1" || body.remember === "on"));
        const adm = db.adminUsers.find((x) => x.username.toLowerCase() === uname);
        let role = "";
        let name = "";
        if (adm && pass && checkPass(pass, adm.passHash)) {
          role = adm.role;
          name = adm.username;
        } else if (ownerLoginOk(uname, pass)) {
          role = "owner";
          name = ADMIN_EMAIL || "owner";
        }
        if (!role) {
          const left = loginFail(ip);
          audit({ auth: { username: "anonim", role: "guest" }, headers: { "x-forwarded-for": ip } }, "login_failed", String(uname).slice(0, 64));
          if (left === 0) return fail(429, "Juda ko‘p urinish. 15 daqiqadan keyin qayta urinib ko‘ring.");
          return fail(401, "Email yoki parol xato. Qolgan urinish: " + left + ".");
        }
        loginOk(ip);
        const ttl = remember ? SESSION_TTL_LONG : SESSION_TTL;
        const tok = crypto.randomBytes(24).toString("hex");
        SESSIONS.set(tok, { username: name, role, exp: Date.now() + ttl });
        if (adm) {
          adm.lastLoginAt = nowStr();
          save();
        }
        audit({ auth: { username: name, role }, headers: { "x-forwarded-for": ip } }, "login", name);
        const cookie = "sid=" + tok + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" + Math.floor(ttl / 1e3) + (isSecureReq(req) ? "; Secure" : "");
        if (isJson) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookie, "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, role: role, next: "/" }));
          return;
        }
        res.writeHead(302, { "set-cookie": cookie, location: "/" });
        res.end();
      });
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
    res.end(loginPage(""));
    return;
  }
  if (url.pathname === "/logout") {
    const tok = cookieOf(req, "sid");
    if (tok) SESSIONS.delete(tok);
    res.writeHead(302, { "set-cookie": "sid=; Path=/; Max-Age=0", location: "/login" });
    res.end();
    return;
  }
  if (!authed(req)) {
    if (url.pathname.startsWith("/api/")) return jsonOut(res, 401, { ok: false, error: "Kirish kerak" });
    res.writeHead(302, { location: "/login" });
    res.end();
    return;
  }
  if (url.pathname === "/news") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(NEWS_PAGE);
    return;
  }
  if (url.pathname === "/api/news") {
    const cfg = newsCfg();
    if (req.method === "POST") {
      if (!sameOrigin(req)) {
        jsonOut(res, 403, { ok: false, error: "Origin rad etildi" });
        return;
      }
      readJsonBody(req).then((b) => {
        const times = String(b.times ?? cfg.times.join(","))
          .split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
          .filter((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x));
        const channel = String(b.channel ?? cfg.channel).trim();
        if (!(channel.startsWith("@") || /^-?\d{5,}$/.test(channel))) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Kanal @username yoki -100… ID bo'lishi kerak" }));
          return;
        }
        cfg.enabled = b.enabled === void 0 ? cfg.enabled : !!b.enabled;
        cfg.channel = channel;
        const rawModels = Array.isArray(b.models) ? b.models.join(",") : String(b.models ?? "");
        const models = rawModels.split(/[,;\s]+/).map((x) => x.trim().toLowerCase())
          .filter((x) => /^[a-z0-9][a-z0-9.\-]{2,60}$/.test(x));
        if (models.length) cfg.models = models;
        if (times.length) cfg.times = times;
        if (b.apiKey) cfg.apiKey = String(b.apiKey).trim();
        cfg.lastError = "";
        save();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      enabled: cfg.enabled,
      channel: cfg.channel,
      times: cfg.times,
      models: cfg.models,
      lastModel: cfg.lastModel || "",
      hasKey: !!cfg.apiKey,
      keySource: process.env.GEMINI_API_KEY ? "env" : cfg.apiKey ? "panel" : "yo'q",
      lastPostAt: cfg.lastPostAt,
      lastStatus: cfg.lastStatus,
      lastError: cfg.lastError,
      history: cfg.history.slice(0, 20),
      bot: newsBotInfo
    }));
    return;
  }
  if (url.pathname === "/api/news/post" && req.method === "POST") {
    if (!sameOrigin(req)) {
      jsonOut(res, 403, { ok: false, error: "Origin rad etildi" });
      return;
    }
    const dry = url.searchParams.get("dry") === "1";
    newsPublish(dry ? "sinov" : "qo'lda", dry).then((r) => {
      res.writeHead(r.ok ? 200 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    });
    return;
  }
  if (url.pathname === "/api/stats") {
    jsonOut(res, 200, {
      users: Object.keys(db.users).length,
      channels: db.channels.length,
      igProfiles: db.igProfiles.length,
      activeOrders: db.orders.filter((o) => o.status === "active").length,
      openTasks: db.tasks.filter((t) => OPEN.has(t.status)).length,
      complaintsNew: db.complaints.filter((c) => c.status === "NEW").length,
      bots: botsList().map((b) => ({ id: b.id, role: b.role, username: b.username, online: botRuns.has(b.id) })),
      settings: { ...S(), telegramBotToken: void 0, bots: void 0, news: void 0 }
    });
    return;
  }
  if (url.pathname.startsWith("/api/admin/")) {
    const route = url.pathname.slice("/api/admin/".length);
    const isPost = req.method === "POST";
    if (isPost && !sameOrigin(req)) {
      jsonOut(res, 403, { ok: false, error: "Origin rad etildi" });
      return;
    }
    const PERM_OF_ROUTE = {
      overview: "read", me: "read", users: "users", user: "users", channels: "channels",
      channel: "channels", orders: "orders", order: "orders", tasks: "tasks", bots: "bots",
      settings: "settings", complaints: "complaints", sponsors: "sponsors", instagram: "instagram",
      referrals: "referrals", moderation: "moderation", appeals: "moderation", analytics: "analytics",
      health: "health", audit: "audit", admins: "admins", export: "export", broadcast: "settings",
      backup: "health", backups: "health"
    };
    const needPerm = PERM_OF_ROUTE[route] || "read";
    const role = (req.auth && req.auth.role) || "owner";
    if (route === "admins" && role !== "owner") return jsonOut(res, 403, { ok: false, error: "Faqat owner" });
    if (!can(role, needPerm)) return jsonOut(res, 403, { ok: false, error: "Ruxsat yo'q: " + needPerm });
    if (isPost) audit(req, route, "", "");
    const run = async () => {
      const b = isPost ? await readJsonBody(req) : {};
      switch (route) {
        case "overview": {
          return {
            now: uzbNow().full,
            storage: STORAGE,
            dbState: DATABASE_URL ? "Postgres" : "fayl",
            uptime: uptimeStr(),
            counts: {
              users: Object.keys(db.users).length,
              channels: db.channels.length,
              ordersActive: db.orders.filter((o) => o.status === "active").length,
              tasksOpen: db.tasks.filter((t) => OPEN.has(t.status)).length,
              complaintsNew: db.complaints.filter((c) => c.status === "NEW").length,
              transactions: db.transactions.length
            },
            bots: botsList().map(botView),
            recentUsers: Object.values(db.users).sort((x, y) => String(y.registeredAt).localeCompare(String(x.registeredAt))).slice(0, 8).map((u) => ({
              telegramId: u.telegramId,
              username: u.username || "",
              displayName: u.displayName,
              credits: u.credits.available,
              registeredAt: u.registeredAt
            }))
          };
        }
        case "me": {
          return {
            username: (req.auth && req.auth.username) || "admin",
            role: (req.auth && req.auth.role) || "owner",
            perms: ROLE_PERMS[(req.auth && req.auth.role) || "owner"] || ["*"]
          };
        }
        case "instagram": {
          if (!isPost) {
            return {
              enabled: S().isInstagramEnabled,
              items: db.igProfiles.map((p) => ({
                id: p.id,
                username: p.username,
                user: userById(p.userId)?.displayName || p.userId,
                selfReported: p.selfReportedFollowers || 0,
                pending: p.pendingFollowers || 0,
                status: p.status
              }))
            };
          }
          if (b.action === "delete") {
            const p = db.igProfiles.find((x) => x.id === String(b.id || ""));
            if (!p) throw new Error("Profil topilmadi");
            db.igProfiles = db.igProfiles.filter((x) => x.id !== p.id);
            for (const t of db.tasks) if (t.destinationId === p.id && OPEN.has(t.status)) t.status = "CANCELLED";
            save();
            audit(req, "instagram_delete", p.username);
            return { deleted: p.username };
          }
          if (b.action === "toggle") {
            S().isInstagramEnabled = !S().isInstagramEnabled;
            save();
            audit(req, "instagram_toggle", String(S().isInstagramEnabled));
            return { enabled: S().isInstagramEnabled };
          }
          throw new Error("Noma'lum amal");
        }
        case "referrals": {
          const items = db.referrals.slice().reverse().map((r) => ({
            id: r.id,
            referrer: r.referrerName || r.referrerId,
            referred: r.referredUserName || r.referredUserId,
            hasTask: !!r.hasCompletedTask,
            verified: !!r.isVerified,
            bonusIssued: !!r.bonusIssued,
            bonusAmount: r.bonusAmount || 0,
            channel: r.allocatedChannelId || "",
            units: r.allocatedUnits || 0,
            at: r.registeredAt
          }));
          return {
            total: items.length,
            verified: items.filter((x) => x.verified).length,
            paid: items.filter((x) => x.bonusIssued).length,
            pending: db.referrals.filter((r) => r.bonusAmount > 0 && !r.bonusIssued).length,
            items: items.slice(0, 200)
          };
        }
        case "moderation": {
          if (!isPost) {
            return {
              complaintsNew: db.complaints.filter((c) => c.status === "NEW").length,
              appealsOpen: db.appeals.filter((a) => a.status === "NEW").length,
              blocked: Object.values(db.users).filter((u) => u.status === "blocked").length,
              flagsOpen: (db.moderationFlags || []).filter((f) => f.status === "OPEN").length,
              flags: (db.moderationFlags || []).slice().reverse().slice(0, 100),
              items: Object.values(db.users)
                .filter((u) => u.status === "blocked" || (u.moderation && u.moderation.length))
                .slice(0, 200)
                .map((u) => ({
                  telegramId: u.telegramId,
                  name: u.displayName,
                  username: u.username || "",
                  status: u.status,
                  last: (u.moderation && u.moderation.slice(-1)[0]) || null
                }))
            };
          }
          const uid = String(b.telegramId || "");
          const u = db.users[uid];
          if (!u) throw new Error("Foydalanuvchi topilmadi");
          const note = String(b.note || "").slice(0, 300);
          u.moderation = u.moderation || [];
          if (b.action === "warn") {
            u.moderation.push({ at: nowStr(), action: "warn", note });
            notify(u, "⚠️ Ogohlantirish: qoidalarga rioya qiling. Sabab: " + (note || "qoidabuzarlik"));
            audit(req, "mod_warn", uid, note);
          } else if (b.action === "block") {
            u.status = "blocked";
            u.moderation.push({ at: nowStr(), action: "block", note });
            audit(req, "mod_block", uid, note);
          } else if (b.action === "unblock") {
            u.status = "active";
            u.moderation.push({ at: nowStr(), action: "unblock", note });
            notify(u, "✅ Hisobingiz tiklandi.");
            audit(req, "mod_unblock", uid, note);
          } else if (b.action === "restrict_channel") {
            const ch = db.channels.find((c) => c.id === String(b.channelId || ""));
            if (!ch) throw new Error("Kanal topilmadi");
            ch.restricted = true;
            ch.restrictedAt = nowStr();
            audit(req, "mod_restrict_channel", ch.title, note);
          } else if (b.action === "dismiss_flag") {
            const f = (db.moderationFlags || []).find((x) => x.id === String(b.id || ""));
            if (!f) throw new Error("Signal topilmadi");
            f.status = "DISMISSED";
            f.resolvedAt = nowStr();
            save();
            audit(req, "mod_dismiss_flag", f.id, f.reason);
            return { ok: true };
          } else if (b.action === "pause_orders") {
            for (const o of db.orders.filter((o2) => o2.userId === u.id && o2.status === "active")) {
              cancelOrderAdmin(o);
            }
            u.moderation.push({ at: nowStr(), action: "pause_orders", note });
            audit(req, "mod_pause_orders", uid, note);
          } else throw new Error("Noma'lum amal");
          save();
          return { ok: true, status: u.status };
        }
        case "appeals": {
          if (!isPost) {
            return {
              items: db.appeals.slice().reverse().slice(0, 100).map((a) => ({
                id: a.id,
                userId: a.userId,
                name: a.userName,
                text: a.text,
                status: a.status,
                at: a.createdAt
              }))
            };
          }
          const ap = db.appeals.find((x) => x.id === String(b.id || ""));
          if (!ap) throw new Error("Apellyatsiya topilmadi");
          if (b.status === "ACCEPTED") {
            const u = userById(ap.userId);
            if (u) {
              u.status = "active";
              notify(u, "✅ Apellyatsiyangiz qabul qilindi. Hisob tiklandi.");
            }
          }
          ap.status = b.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED";
          ap.resolvedAt = nowStr();
          save();
          audit(req, "appeal_" + ap.status, ap.userName || ap.userId);
          return { ok: true };
        }
        case "analytics": {
          const days = [];
          for (let i = 6; i >= 0; i--) {
            const start = new Date(Date.now() - i * 864e5);
            const key = start.toISOString().slice(0, 10);
            days.push({
              date: key,
              users: Object.values(db.users).filter((u) => String(u.registeredAt || "").startsWith(key)).length,
              orders: db.orders.filter((o) => String(o.createdAt || "").startsWith(key)).length,
              complaints: db.complaints.filter((c) => String(c.createdAt || "").startsWith(key)).length,
              verified: db.tasks.filter((t) => String(t.verifiedAt || "").startsWith(key)).length
            });
          }
          const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
          return {
            days,
            totals: {
              users: Object.keys(db.users).length,
              channels: db.channels.length,
              igProfiles: db.igProfiles.length,
              orders: db.orders.length,
              activeOrders: db.orders.filter((o) => o.status === "active").length,
              tasksVerified: db.tasks.filter((t) => t.status === "VERIFIED" || t.status === "SELF_CONFIRMED").length,
              creditsAvailable: Object.values(db.users).reduce((a, u) => a + u.credits.available, 0),
              creditsReserved: Object.values(db.users).reduce((a, u) => a + u.credits.reserved, 0),
              creditsSpent: Object.values(db.users).reduce((a, u) => a + u.credits.spent, 0),
              referrals: db.referrals.length,
              complaintsOpen: db.complaints.filter((c) => c.status === "NEW").length
            }
          };
        }
        case "backup": {
          if (!isPost) return { items: await listBackups(), lastBackupAt: db.lastBackupAt };
          const ok = await backupNow("qo'lda");
          audit(req, "backup_manual", ok ? "ok" : "xato");
          return { ok };
        }
        case "backups": {
          return { items: await listBackups(), lastBackupAt: db.lastBackupAt };
        }
        case "health": {
          const mem = process.memoryUsage();
          return {
            uptime: uptimeStr(),
            storage: STORAGE,
            db: DATABASE_URL ? "postgres" : "fayl",
            memoryMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
            queue: {
              tasksOpen: db.tasks.filter((t) => OPEN.has(t.status)).length,
              ordersActive: db.orders.filter((o) => o.status === "active").length,
              complaintsNew: db.complaints.filter((c) => c.status === "NEW").length,
              appealsNew: db.appeals.filter((a) => a.status === "NEW").length
            },
            bots: botsList().map((b) => ({
              id: b.id,
              role: b.role,
              online: botRuns.has(b.id),
              enabled: !!b.enabled,
              lastError: b.lastError || ""
            })),
            news: { enabled: newsCfg().enabled, lastPostAt: newsCfg().lastPostAt, lastStatus: newsCfg().lastStatus, lastError: newsCfg().lastError },
            lastExportAt: db.lastExportAt ? new Date(db.lastExportAt).toISOString() : "",
            lastBackupAt: db.lastBackupAt ? new Date(db.lastBackupAt).toISOString() : "",
            backups: await listBackups(),
            auditEntries: db.auditLog.length,
            sessions: SESSIONS.size,
            node: process.version
          };
        }
        case "audit": {
          const q = String(b.q || "").toLowerCase();
          const items = db.auditLog
            .slice()
            .reverse()
            .filter((x) => !q || (x.actor + " " + x.action + " " + x.target).toLowerCase().includes(q))
            .slice(0, 300);
          return { total: db.auditLog.length, items };
        }
        case "admins": {
          if (!isPost) {
            return {
              roles: Object.keys(ROLE_PERMS),
              items: db.adminUsers.map((a) => ({
                id: a.id,
                username: a.username,
                role: a.role,
                createdAt: a.createdAt,
                lastLoginAt: a.lastLoginAt || ""
              }))
            };
          }
          if (b.action === "add") {
            const un = String(b.username || "").trim();
            const pw = String(b.password || "");
            const role2 = String(b.role || "moderator");
            if (!/^[A-Za-z0-9_.-]{3,32}$/.test(un)) throw new Error("Username 3-32 belgi (harf, raqam, _ . -)");
            if (pw.length < 8) throw new Error("Parol kamida 8 belgi bo'lishi kerak");
            if (!ROLE_PERMS[role2]) throw new Error("Rol noto'g'ri");
            if (db.adminUsers.some((a) => a.username.toLowerCase() === un.toLowerCase())) throw new Error("Bu username band");
            const a = { id: nid("adm"), username: un, passHash: hashPass(pw), role: role2, createdAt: nowStr() };
            db.adminUsers.push(a);
            save();
            audit(req, "admin_add", un, role2);
            return { id: a.id, username: a.username, role: a.role };
          }
          if (b.action === "delete") {
            const a = db.adminUsers.find((x) => x.id === String(b.id || ""));
            if (!a) throw new Error("Admin topilmadi");
            db.adminUsers = db.adminUsers.filter((x) => x.id !== a.id);
            save();
            audit(req, "admin_delete", a.username);
            return { deleted: a.username };
          }
          if (b.action === "pass") {
            const a = db.adminUsers.find((x) => x.id === String(b.id || ""));
            if (!a) throw new Error("Admin topilmadi");
            const pw = String(b.password || "");
            if (pw.length < 8) throw new Error("Parol kamida 8 belgi bo'lishi kerak");
            a.passHash = hashPass(pw);
            save();
            audit(req, "admin_pass", a.username);
            return { ok: true };
          }
          throw new Error("Noma'lum amal");
        }
        case "export": {
          db.lastExportAt = Date.now();
          save();
          audit(req, "export", "state");
          return { at: nowStr(), state: db };
        }
        case "bots": {
          if (!isPost) return { bots: botsList().map(botView) };
          const action = String(b.action || "");
          if (action === "add") {
            const token = String(b.token || "").trim();
            if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Token formati noto'g'ri (123456789:AA...)");
            if (botsList().some((x) => x.token === token)) throw new Error("Bu token allaqachon qo'shilgan");
            const me = await tgWith({ token }, "getMe", {}, 15e3);
            if (!me.ok) throw new Error("Telegram tokenni qabul qilmadi: " + (me.description || "xato"));
            const bot = {
              id: nid("bot"),
              token,
              role: "worker",
              enabled: true,
              offset: 0,
              username: me.result.username || "",
              displayName: me.result.first_name || "",
              botId: me.result.id,
              createdAt: nowStr()
            };
            botsList().push(bot);
            save();
            await startBotLoop(bot);
            return { username: bot.username, bots: botsList().map(botView) };
          }
          if (action === "toggle") {
            const bot = botById(String(b.id || ""));
            if (!bot) throw new Error("Bot topilmadi");
            if (bot.role === "main" && !b.enabled) throw new Error("Asosiy botni o'chirib bo'lmaydi (u env orqali boshqariladi)");
            bot.enabled = !!b.enabled;
            save();
            if (bot.enabled) await startBotLoop(bot);
            else stopBotLoop(bot.id);
            return { bots: botsList().map(botView) };
          }
          if (action === "delete") {
            const bot = botById(String(b.id || ""));
            if (!bot) throw new Error("Bot topilmadi");
            if (bot.role === "main") throw new Error("Asosiy botni o'chirib bo'lmaydi");
            stopBotLoop(bot.id);
            S().bots = botsList().filter((x) => x.id !== bot.id);
            save();
            return { bots: botsList().map(botView) };
          }
          if (action === "restart") {
            await restartBots();
            return { bots: botsList().map(botView) };
          }
          throw new Error("Noma'lum amal: " + action);
        }
        case "users": {
          const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
          let list = Object.values(db.users);
          if (q) list = list.filter((u) => String(u.displayName || "").toLowerCase().includes(q) || String(u.username || "").toLowerCase().includes(q) || String(u.telegramId).includes(q));
          const total = list.length;
          list = list.sort((x, y) => String(y.registeredAt).localeCompare(String(x.registeredAt))).slice(0, limit);
          return {
            total,
            items: list.map((u) => ({
              telegramId: u.telegramId,
              username: u.username || "",
              displayName: u.displayName,
              credits: u.credits.available,
              reserved: u.credits.reserved,
              completedTasksCount: u.completedTasksCount || 0,
              status: u.status || "active",
              registeredAt: u.registeredAt
            }))
          };
        }
        case "user": {
          const t = db.users[String(b.telegramId || "")];
          if (!t) throw new Error("Foydalanuvchi topilmadi");
          if (b.action === "credits") {
            const n = Number(b.amount);
            if (!Number.isFinite(n) || !n) throw new Error("Kredit soni noto'g'ri");
            t.credits.available = Math.max(0, t.credits.available + n);
            addTx(t, n, "admin_adjustment", "Admin panel");
            notify(t, `\u{1F4B0} Hisobingiz ${n > 0 ? "+" : ""}${n} kreditga o'zgartirildi.`);
            save();
            return { balance: t.credits.available };
          }
          if (b.action === "block" || b.action === "unblock") {
            t.status = b.action === "block" ? "blocked" : "active";
            save();
            return { status: t.status };
          }
          throw new Error("Noma'lum amal");
        }
        case "channels": {
          return {
            items: db.channels.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).map((c) => ({
              id: c.id,
              title: c.title,
              username: c.username,
              ownerName: c.ownerName,
              verifiedSubscribers: c.verifiedSubscribers,
              pendingSubscriptions: c.pendingSubscriptions,
              botHasAdminRights: !!c.botHasAdminRights,
              createdAt: c.createdAt
            }))
          };
        }
        case "channel": {
          const c = db.channels.find((x) => x.id === String(b.id || ""));
          if (!c) throw new Error("Kanal topilmadi");
          // Avval faol buyurtmalarni bekor qilib, kreditini egasiga qaytaramiz —
          // aks holda o‘chirilgan kanal uchun kredit “band” bo‘lib qoladi.
          let refunded = 0;
          for (const o of db.orders.filter((x) => x.destinationId === c.id && x.status === "active")) {
            refunded += cancelOrderAdmin(o).refundCredits || 0;
          }
          db.channels = db.channels.filter((x) => x.id !== c.id);
          for (const t of db.tasks) if (t.destinationId === c.id && OPEN.has(t.status)) t.status = "CANCELLED";
          save();
          return { deleted: c.title, refunded };
        }
        case "orders": {
          const all = db.orders.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
          return {
            total: all.length,
            active: all.filter((o) => o.status === "active").length,
            items: all.slice(0, 60)
          };
        }
        case "order": {
          // "grant" — admin kanalga vazifa (obunachi navbati) qo'shadi.
          // Kredit talab qilinmaydi: nol narxli faol buyurtma yaratiladi, shunda
          // foydalanuvchilarda shu kanal uchun obuna vazifasi paydo bo'ladi.
          if (b.action === "grant") {
            const dest = db.channels.find((c) => c.id === String(b.destinationId || ""));
            if (!dest) throw new Error("Kanal topilmadi");
            const qty = Math.min(1e4, Math.max(10, Math.round(Number(b.qty) || 50)));
            // Shu kanalda faol buyurtma bo‘lsa — yangisini yaratmay, uni kengaytiramiz
            const existing = db.orders.find((x) => x.destinationId === dest.id && x.status === "active");
            if (existing) {
              existing.requestedQuantity += qty;
              existing.pendingQuantity += qty;
              existing.freeUnits = (existing.freeUnits || 0) + qty;
              dest.totalRequested += qty;
              dest.pendingSubscriptions += qty;
              save();
              return { orderId: existing.id, qty, merged: true, total: existing.requestedQuantity };
            }
            const o = {
              id: nid("ord"),
              seq: ++db.seq,
              userId: dest.ownerId,
              userName: dest.ownerName,
              destinationId: dest.id,
              destinationTitle: dest.title,
              platform: "telegram",
              requestedQuantity: qty,
              verifiedQuantity: 0,
              pendingQuantity: qty,
              cancelledQuantity: 0,
              unitCost: 0,
              totalCost: 0,
              freeUnits: qty,
              status: "active",
              granted: true,
              createdAt: nowStr()
            };
            db.orders.push(o);
            dest.totalRequested += qty;
            dest.pendingSubscriptions += qty;
            save();
            return { orderId: o.id, qty };
          }
          const o = db.orders.find((x) => x.id === String(b.id || ""));
          if (!o) throw new Error("Buyurtma topilmadi");
          if (o.status !== "active") throw new Error("Bu buyurtma allaqachon yopilgan");
          return cancelOrderAdmin(o);
        }
        case "tasks": {
          const byStatus = {};
          for (const t of db.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
          const items = db.tasks.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))).slice(0, 60).map((t) => {
            const u = userById(t.assignedTo);
            return { id: t.id, destinationTitle: t.destinationTitle, userName: u ? u.displayName : t.assignedTo, status: t.status, createdAt: t.createdAt };
          });
          return { byStatus, items };
        }
        case "complaints": {
          if (!isPost) {
            const items = db.complaints.slice().reverse();
            return { items, newCount: items.filter((c) => c.status === "NEW").length };
          }
          const c = db.complaints.find((x) => x.ticketId === String(b.ticketId || ""));
          if (!c) throw new Error("Shikoyat topilmadi");
          const text = String(b.text || "").trim();
          if (!text) throw new Error("Javob matni bo'sh");
          c.adminResponse = text;
          c.status = "ANSWERED";
          c.updatedAt = nowStr();
          notify(userById(c.userId), `\u{1F6DF} <b>${c.ticketId}</b> bo'yicha javob:\n\n${esc(text)}`);
          save();
          return { ticketId: c.ticketId };
        }
        case "sponsors": {
          if (!isPost) return { items: db.sponsors };
          if (b.action === "del") {
            db.sponsors = db.sponsors.filter((s) => s.username !== String(b.username || "").replace(/^@/, ""));
            save();
            return { items: db.sponsors };
          }
          const uname = String(b.username || "").trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "");
          if (!uname) throw new Error("Username kiriting");
          const info = await tg("getChat", { chat_id: "@" + uname }, 15e3);
          if (!info.ok) throw new Error("Kanal topilmadi: " + (info.description || ""));
          if (!await checkBotAdmin(info.result.id)) throw new Error("Bot bu kanalda administrator emas");
          if (db.sponsors.some((s) => s.username === uname)) throw new Error("Allaqachon qo'shilgan");
          db.sponsors.push({ id: nid("sp"), title: info.result.title, username: uname, channelId: String(info.result.id), url: "https://t.me/" + uname, isMandatory: true, isActive: true, subscribersCount: 0, createdAt: nowStr() });
          save();
          return { items: db.sponsors };
        }
        case "settings": {
          const s = S();
          if (!isPost) {
            const { news, bots, ...rest } = s;
            return { settings: { ...rest, news: news ? { enabled: news.enabled, channel: news.channel, times: news.times } : null } };
          }
          for (const k of ["creditRewardSignup", "creditRewardChannelLink", "creditRewardTelegram", "creditRewardInstagram", "creditRewardReferral", "creditPerSubscriber"]) {
            if (b[k] === void 0) continue;
            const n = Number(b[k]);
            if (!Number.isFinite(n) || n < 0) throw new Error(k + " noto'g'ri son");
            s[k] = Math.round(n);
          }
          const igWas = !!s.isInstagramEnabled;
          for (const k of ["isBotPaused", "areOrdersFrozen", "isInstagramEnabled", "hourlyNotificationsEnabled"]) {
            if (b[k] !== void 0) s[k] = !!b[k];
          }
          save();
          // Instagram yoqilsa/o‘chirilsa — ta'sirlangan buyurtma egalariga xabar (spec §9)
          if (igWas !== !!s.isInstagramEnabled) {
            const owners = new Set(
              db.orders.filter((o) => o.platform === "instagram" && o.status === "active").map((o) => o.userId)
            );
            const msg = s.isInstagramEnabled
              ? "📸 Instagram moduli qayta yoqildi. Muzlatilgan buyurtmalaringiz avtomatik davom etadi."
              : "📸 Instagram moduli vaqtincha o‘chirildi. Instagram buyurtmalaringiz muzlatildi — balans va tarix saqlanadi, modul yoqilganda davom etadi.";
            for (const uid of owners) {
              const u = userById(uid);
              if (u && notifOn(u, "technical")) notify(u, msg);
            }
            audit(req, "instagram_toggle", String(s.isInstagramEnabled), "affected=" + owners.size);
          }
          return { saved: true };
        }
        case "broadcast": {
          if (!isPost) throw new Error("POST kerak");
          const text = String(b.text || "").trim();
          if (!text) throw new Error("Matn bo'sh");
          const list = Object.values(db.users).filter((x) => x.status !== "blocked" && x.chatId);
          (async () => {
            let ok = 0;
            for (const x of list) {
              const b = (x.botId && botById(x.botId)) || primaryBot();
              const r = await sendWith(b, x.chatId, esc(text), {});
              if (r.ok) ok++;
              await new Promise((r2) => setTimeout(r2, 50));
            }
            console.log(`Broadcast: ${ok}/${list.length}`);
          })().catch((e) => console.error("Broadcast xatosi:", e.message));
          return { count: list.length };
        }
      }
      throw new Error("Noma'lum endpoint: " + route);
    };
    run().then((out) => jsonOut(res, 200, { ok: true, ...out })).catch((e) => jsonOut(res, 400, { ok: false, error: e.message }));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/panel") {
    if (!PANEL_PAGE) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("panel.html topilmadi");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PANEL_PAGE);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
function startKeepAlive() {
  if (process.env.KEEP_ALIVE === "0") return;
  const base = (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return;
  const target = base + "/healthz";
  const every = Math.max(60, Number(process.env.KEEP_ALIVE_SEC || 600)) * 1e3;
  setInterval(() => {
    fetch(target, { signal: AbortSignal.timeout(15e3) }).then((r) => {
      if (!r.ok) console.error("keep-alive javobi:", r.status);
    }).catch((e) => console.error("keep-alive xato:", e.message));
  }, every);
  console.log(`Keep-alive yoqilgan: ${target} (har ${Math.round(every / 1e3)}s)`);
}
async function startBotLoop(bot) {
  if (!bot || !bot.enabled || !bot.token) return false;
  if (botRuns.has(bot.id)) return true;
  const stopToken = Symbol("stop");
  botRuns.set(bot.id, stopToken);
  const me = await tgWith(bot, "getMe");
  if (!me.ok) {
    botRuns.delete(bot.id);
    bot.lastError = me.description || "getMe xatosi";
    bot.online = false;
    // Har 30 soniyada urinish logni to‘ldirib yubormasin — 5 daqiqa kutamiz
    bot.nextRetryAt = Date.now() + 5 * 6e4;
    console.error(`[${botName(bot)}] ishga tushmadi (5 daqiqadan keyin qayta urinish):`, bot.lastError);
    save();
    return false;
  }
  bot.username = me.result.username || "";
  bot.displayName = me.result.first_name || "";
  bot.botId = me.result.id;
  bot.online = true;
  bot.lastError = "";
  bot.startedAt = nowStr();
  if (bot.role === "main") {
    BOT_ID = me.result.id;
    S().botId = String(me.result.id);
    S().botUsername = bot.username;
    S().botDisplayName = bot.displayName;
  }
  await tgWith(bot, "deleteWebhook", { drop_pending_updates: false });
  await tgWith(bot, "setMyCommands", { commands: [{ command: "start", description: "Botni ishga tushirish" }, { command: "help", description: "To‘liq qo‘llanma" }, { command: "cancel", description: "Joriy amalni bekor qilish" }] });
  // Eski (offline davrdagi) xabarlar oqimini tashlab yuborish
  if (!bot.offset) {
    const skip = await tgWith(bot, "getUpdates", { offset: -1, limit: 1, timeout: 0 });
    if (skip.ok && skip.result.length) bot.offset = skip.result[0].update_id + 1;
  }
  save();
  console.log(`Bot ${botName(bot)} ishga tushdi (long polling${bot.role === "main" ? "" : ", ishchi bot"})`);
  pollLoop(bot, stopToken).catch((e) => console.error(`[${botName(bot)}] pollLoop xatosi:`, e));
  return true;
}
function stopBotLoop(id) {
  botRuns.delete(id);
  const b = botById(id);
  if (b) b.online = false;
}
async function startAllBots() {
  const list = botsList().filter((b) => b.enabled && b.token);
  for (const b of list) {
    if (botRuns.has(b.id)) continue;
    await startBotLoop(b);
  }
  if (!list.length) console.error("Bot tokeni yo'q - faqat veb panel ishlaydi. Panelda bot tokenini qo'shing.");
}
async function restartBots() {
  for (const id of [...botRuns.keys()]) stopBotLoop(id);
  await new Promise((r) => setTimeout(r, 1200));
  await startAllBots();
}
var shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig}: holat saqlanmoqda...`);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
  try {
    await Promise.race([persist(), new Promise((r) => setTimeout(r, 8e3))]);
  } catch {
  }
  try {
    if (dbPool) await dbPool.end();
  } catch {
  }
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  shutdown(sig);
});
// Asosiy botni (env tokeni) bazadagi ro'yxatga bir marta yozib qo'yamiz.
function botsInit() {
  const list = botsList();
  const env = (TOKEN || "").trim();
  if (env) {
    let b = list.find((x) => x.token === env);
    if (!b) {
      b = { id: "bot-main", token: env, role: "main", enabled: true, createdAt: nowStr() };
      list.unshift(b);
    }
    b.role = "main";
    b.enabled = true;
  }
  for (const b of list) {
    if (b.role === "main") continue;
    b.role = "worker";
    if (b.offset === void 0) b.offset = 0;
  }
  save();
  return list;
}
// Bir martalik sozlama migratsiyasi: sovg'a ro'yxatdan o'tishda emas, kanal
// ulanganda beriladi (creditRewardChannelLink).
function migrateSettings() {
  const s = S();
  // 1 kredit = 1 obunachi; referal bonusi 300 kredit.
  if (s.rulesVersion !== 3) {
    if (typeof s.creditPerSubscriber !== "number" || !(s.creditPerSubscriber > 0)) s.creditPerSubscriber = 1;
    s.creditRewardReferral = 300;
    if (typeof s.creditRewardTelegram !== "number") s.creditRewardTelegram = 100;
    s.rulesVersion = 3;
    save();
    console.log(`Qoida: 1 obunachi = ${s.creditPerSubscriber} kredit, obuna mukofoti ${s.creditRewardTelegram}, referal ${s.creditRewardReferral}`);
  }
  if (s.bonusRuleVersion === 2) return;
  s.creditRewardSignup = 0;
  if (typeof s.creditRewardChannelLink !== "number") s.creditRewardChannelLink = 10;
  s.bonusRuleVersion = 2;
  save();
  console.log(`Sozlama: ro'yxat bonusi 0, kanal ulash bonusi ${s.creditRewardChannelLink}`);
}
async function main() {
  await openStore();
  botsInit();
  migrateSettings();
  server.on("error", (e) => {
    console.error("HTTP server xatosi:", e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => console.log(`Veb server: http://${HOST}:${PORT} (saqlash: ${STORAGE})`));
  startKeepAlive();
  startNewsScheduler();
  setInterval(() => hourlyReport().catch((e) => console.error(e)), 6e4);
  startBackupJob();
  setInterval(() => maintenance().catch((e) => console.error(e)), 15 * 6e4);
  setInterval(() => {
    for (const b of botsList()) {
      if (!b.enabled || !b.token || botRuns.has(b.id)) continue;
      if (b.nextRetryAt && Date.now() < b.nextRetryAt) continue;
      startBotLoop(b).catch((e) => console.error(e));
    }
  }, 3e4);
  await startAllBots();
}
main().catch((e) => {
  console.error("Ishga tushirishda halokatli xato:", e);
  process.exit(1);
});
