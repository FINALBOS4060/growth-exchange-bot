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
  const refundCredits = unfulfilledQuantity * order.unitCost;
  return {
    refundableUnits: unfulfilledQuantity,
    refundCredits
  };
}
function qualifyReferral(referral, hasCompletedVerifiedTask, bonusAmount = 200) {
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
var DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
var DATABASE_URL = (process.env.DATABASE_URL || "").trim();
var PORT = Number(process.env.PORT || 3e3);
var HOST = process.env.IP || "0.0.0.0";
var defaultSettings = () => ({
  creditRewardTelegram: 100,
  creditRewardInstagram: 100,
  creditRewardReferral: 200,
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
  settings: defaultSettings(),
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
var notify = (u, text) => {
  if (!u) return Promise.resolve();
  const b = botCtx.getStore() || (u.botId ? botById(u.botId) : null) || primaryBot();
  return sendWith(b, u.chatId, text, {});
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
var MENU = {
  reply_markup: {
    keyboard: [
      [{ text: "\u{1F4CB} Vazifalar" }, { text: "\u{1F4E2} Kanallarim" }],
      [{ text: "\u{1F6D2} Buyurtmalarim" }, { text: "\u{1F4F8} Instagram" }],
      [{ text: "\u{1F465} Referal tizimi" }, { text: "\u{1F4CA} Statistika" }],
      [{ text: "\u{1F6DF} Yordam" }, { text: "\u2699\uFE0F Sozlamalar" }]
    ],
    resize_keyboard: true
  }
};
var MENU_LABELS = new Set(MENU.reply_markup.keyboard.flat().map((b) => b.text));
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
      language: "uz",
      credits: { available: bonus, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: bonus },
      registeredAt: nowStr(),
      referralCode: `REF_${from.id}`,
      isReferralVerified: false,
      completedTasksCount: 0,
      activeOrdersCount: 0,
      status: "active",
      chatId,
      botId: (curBot() || {}).id || "",
      notifications: true
    };
    if (bonus > 0) {
      addTx(db.users[key], bonus, "signup_bonus", "Ro'yxatdan o'tish sovg'asi");
      console.log(`Yangi foydalanuvchi ${from.id} — +${bonus} kredit sovg'a`);
    }
  }
  const u = db.users[key];
  u.chatId = chatId;
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
  if (owner) {
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
  ref.bonusIssued = true;
  ref.bonusAmount = q.rewardCredits;
  u.isReferralVerified = true;
  referrer.credits.available += q.rewardCredits;
  addTx(referrer, q.rewardCredits, "reward_referral", `Referal: ${u.displayName}`);
  notify(referrer, `\u{1F465} Do\u2018stingiz <b>${esc(u.displayName)}</b> birinchi vazifasini bajardi!
+${q.rewardCredits} kredit hisobingizga qo\u2018shildi.`);
}
async function verifyBatch(u, platform, chat) {
  const batch = db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && OPEN.has(t.status)).sort((a, b) => a.queueSequence - b.queueSequence).slice(0, 10);
  if (!batch.length) return send(chat, "Tekshiradigan vazifangiz yo‘q.\n\nAvval “📋 Vazifalar” tugmasini bosing.", MENU);
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
  let text = `✅ <b>Tekshirildi!</b>

• Tasdiqlandi: <b>${out.verifiedTasks.length} ta</b>
• Mukofot: <b>+${earned} kredit</b>
• Hozirgi balans: <b>${u.credits.available} kredit</b>`;
  if (notDone.length) text += `

⏳ <b>Hali obuna bo‘lmaganlar (${notDone.length} ta):</b>
` + notDone.map((t) => `• ${esc(t.destinationTitle)}`).join("\n") + `

Obuna bo‘lib, yana “✅ Obuna bo‘ldim” tugmasini bosing.`;
  if (out.apiErrorTasks.length) text += `

⚠️ ${out.apiErrorTasks.length} ta kanalni hozir tekshirib bo‘lmadi (Telegram’ning o‘zida xato). Sizda ayb yo‘q — keyinroq o‘zi qayta tekshiriladi.`;
  await send(chat, text, MENU);
  if (!notDone.length && !out.apiErrorTasks.length) await showTasks(u, platform, chat);
}
function balanceLine(u) {
  return `💰 Balans: <b>${u.credits.available}</b> kredit  •  🔒 Band: ${u.credits.reserved} kredit`;
}
async function showTasks(u, platform, chat) {
  if (platform === "telegram" && S().isTelegramPaused) return send(chat, "⏸ Telegram vazifalari vaqtincha to‘xtatilgan. Keyinroq urinib ko‘ring.", MENU);
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, "📸 Instagram bo‘limi hozircha o‘chirilgan.", MENU);
  const batch = getBatch(u, platform);
  if (!batch.length) return send(chat, `📋 <b>Hozircha vazifa yo‘q</b>

Buning sababi: hozir hech kim obunachi buyurtma qilmagan, ya’ni obuna bo‘ladigan kanal yo‘q. Keyinroq yana shu tugmani bosing.

${balanceLine(u)}`, MENU);
  const reward = batch[0].rewardCredits;
  const text = `📋 <b>Vazifalar: ${batch.length} ta kanal</b>

Qanday bajariladi:
1. Quyidagi havolalardan kanalga kiring
2. ${platform === "telegram" ? "Obuna bo‘ling" : "Follow qiling"}
3. Pastdagi <b>“✅ Obuna bo‘ldim”</b> tugmasini bosing — bot o‘zi tekshiradi

Har bir obuna uchun: <b>+${reward} kredit</b>

` + batch.map((t, i) => `${i + 1}. ${esc(t.destinationTitle)}${t.isDeferred ? " 🔁" : ""}`).join("\n") + (platform === "instagram" ? "\n\n⚠️ Instagram’da tasdiqlash sizning so‘zingizga asoslanadi — admin tekshiradi." : "");
  const rows = batch.map((t, i) => [{ text: `🔗 ${i + 1}. ${t.destinationTitle}`.slice(0, 60), url: t.destinationUrl }]);
  rows.push([{ text: platform === "telegram" ? "✅ Obuna bo‘ldim" : "✅ Bajardim", callback_data: `verify:${platform === "telegram" ? "tg" : "ig"}` }]);
  rows.push([{ text: "🔄 Yangilash", callback_data: `tasks:${platform === "telegram" ? "tg" : "ig"}` }]);
  return send(chat, text, inline(rows));
}
var channelsOf = (u) => db.channels.filter((c) => c.ownerId === u.id || c.controllers.some((k) => k.userId === u.id));
async function showChannels(u, chat) {
  const chs = channelsOf(u);
  const text = `📢 <b>Kanallaringiz: ${chs.length} ta</b>

` + (chs.length ? chs.map((c) => `• <b>${esc(c.title)}</b> (@${esc(c.username)})\n   obunachi: ${c.verifiedSubscribers} ta keldi • ${c.pendingSubscriptions} ta kutilmoqda${c.ownerId !== u.id ? " (nazoratchi)" : ""}`).join("\n") : `Hali kanal ulanmagan. Ulash uchun:
1. Botni kanalingizga <b>administrator</b> qiling
2. “➕ Kanal qo‘shish” tugmasini bosing
3. Kanal manzilini yuboring (masalan: @kanal_nomi)

Birinchi marta ulaganingizda <b>+10 kredit</b> sovg‘a olasiz.`) + `

${balanceLine(u)}`;
  const rows = chs.map((c) => [{ text: `🛒 ${c.title}`.slice(0, 40), callback_data: `ord:${c.id}` }, ...c.ownerId === u.id ? [{ text: "🔑 Kod", callback_data: `ctl:${c.id}` }] : []]);
  rows.push([{ text: "➕ Kanal qo‘shish", callback_data: "chadd" }, { text: "🔑 Kod kiritish", callback_data: "ctlin" }]);
  return send(chat, text, inline(rows));
}
async function showOrders(u, chat) {
  const os = db.orders.filter((o) => o.userId === u.id).slice(-10).reverse();
  const text = `🛒 <b>Buyurtmalaringiz: ${db.orders.filter((o) => o.userId === u.id).length} ta</b>
${balanceLine(u)}

` + (os.length ? os.map((o) => `${o.platform === "telegram" ? "📢" : "📸"} <b>${esc(o.destinationTitle)}</b>
   keldi: ${o.verifiedQuantity} / ${o.requestedQuantity} ta • ${o.status === "active" ? "🟢 davom etyapti" : o.status === "completed" ? "✅ tugagan" : "⛔ bekor qilingan"} • ${o.totalCost} kredit`).join("\n\n") : "Hali buyurtma bermagansiz.\n\n“📢 Kanallarim” → kanalingizni tanlang → nechta obunachi kerakligini yozing.");
  const rows = os.filter((o) => o.status === "active").map((o) => [{ text: `❌ Bekor qilish: ${o.destinationTitle}`.slice(0, 45), callback_data: `cx:${o.id}` }]);
  return send(chat, text, rows.length ? inline(rows) : MENU);
}
async function showInstagram(u, chat) {
  if (!S().isInstagramEnabled) return send(chat, "📸 Instagram bo‘limi hozircha o‘chirilgan.", MENU);
  const ps = db.igProfiles.filter((p) => p.userId === u.id);
  const text = `📸 <b>Instagram</b>

Kredit Telegram bilan bitta, lekin vazifalar alohida.

` + (ps.length ? ps.map((p) => `• @${esc(p.username)} — ${p.selfReportedFollowers} follower`).join("\n") : "Profil ulanmagan.") + `

${balanceLine(u)}`;
  const rows = ps.map((p) => [{ text: `🛒 @${p.username}`, callback_data: `ord:${p.id}` }]);
  rows.push([{ text: "➕ Profil qo‘shish", callback_data: "igadd" }, { text: "📋 Instagram vazifalar", callback_data: "tasks:ig" }]);
  return send(chat, text, inline(rows));
}
async function showReferrals(u, chat) {
  const refs = db.referrals.filter((r) => r.referrerId === u.id);
  const paid = refs.filter((r) => r.bonusIssued).length;
  return send(chat, `👥 <b>Referal tizimi</b>

Do‘stingizni taklif qiling. U shu botga kirib <b>kamida bitta vazifani</b> bajarsa, sizga <b>+${S().creditRewardReferral} kredit</b> beriladi.

Taklif qilganlar: ${refs.length} ta • Mukofot olganlar: ${paid} ta

🔗 Sizning havolangiz:
https://t.me/${S().botUsername}?start=${u.referralCode}

Shu havolani do‘stlaringizga yuboring.`, MENU);
}
async function showStats(u, chat) {
  const c = u.credits;
  return send(chat, `📊 <b>Statistika</b>

👤 ${esc(u.displayName)}
🆔 ${u.telegramId}

💰 Balans: <b>${c.available}</b> kredit — hozir ishlatsa bo‘ladigan kredit
🔒 Band: ${c.reserved} kredit — faol buyurtmaga band qilingan
💸 Sarflangan: ${c.spent} kredit
↩️ Qaytarilgan: ${c.refunded} kredit
✅ Bajarilgan vazifalar: ${u.completedTasksCount} ta
📢 Kanallar: ${channelsOf(u).length} ta
🛒 Faol buyurtmalar: ${db.orders.filter((o) => o.userId === u.id && o.status === "active").length} ta`, MENU);
}
async function showHelp(chat) {
  const text = `🛟 <b>Yordam — botning to‘liq qo‘llanmasi</b>

<b>Bu bot nima qiladi?</b>
Bot kanallarga obunachi yig‘ishga yordam beradi. Siz boshqa kanallarga obuna bo‘lib <b>kredit</b> ishlaysiz, keyin shu kredit bilan o‘z kanalingizga obunachi yig‘asiz. Bu yerda pul ishlatilmaydi.

<b>Kredit nima?</b>
Kredit — bot ichidagi hisob birligi. 1 obunachi = ${S().creditRewardTelegram} kredit. Kreditni naqd pulga aylantirib bo‘lmaydi.

<b>Pastdagi tugmalar nima qiladi:</b>

📋 <b>Vazifalar</b> — obuna bo‘lish uchun kanallar ro‘yxati. Har biriga obuna bo‘lib “✅ Obuna bo‘ldim” tugmasini bosing. Har biri uchun +${S().creditRewardTelegram} kredit.

📢 <b>Kanallarim</b> — o‘z kanalingizni ulash va unga obunachi buyurtish. Ichida: “➕ Kanal qo‘shish” (yangi kanal ulash), kanal nomi (buyurtma berish), “🔑 Kod” (kanalingizga yordamchi qo‘shish uchun bir martalik kod).

🛒 <b>Buyurtmalarim</b> — bergan buyurtmalaringiz va ularning holati. Bekor qilsangiz, bajarilmagan qismining krediti qaytadi.

📸 <b>Instagram</b> — Instagram profilini ulash bo‘limi (hozircha o‘chirilgan).

👥 <b>Referal tizimi</b> — taklif havolangiz. Do‘stingiz shu havola bilan kirib bitta vazifa bajarsa, sizga +${S().creditRewardReferral} kredit.

📊 <b>Statistika</b> — balans, sarflangan kredit, bajarilgan vazifalar soni, kanallar soni.

🛟 <b>Yordam</b> — shu qo‘llanma va admin bilan bog‘lanish.

⚙️ <b>Sozlamalar</b> — soatlik hisobotni yoqish yoki o‘chirish.

<b>Muhim qoidalar:</b>
• Obuna haqiqiy tekshiriladi — obuna bo‘lmasangiz kredit berilmaydi.
• Obunadan chiqsangiz, kredit qaytarib olinadi.
• Soxta harakat qilsangiz hisob bloklanadi.
• Kanal ulash uchun bot o‘sha kanalda administrator bo‘lishi shart.
• Kanal ulash bonusi (+${S().creditRewardChannelLink} kredit) faqat bir marta beriladi.

Savolingiz yoki muammoingiz bo‘lsa — pastdagi <b>“📝 Shikoyat yuborish”</b> tugmasini bosing, admin javob beradi.`;
  return send(chat, text, inline([
    [{ text: "📋 Vazifalarga o‘tish", callback_data: "tasks:tg" }],
    [{ text: "📝 Shikoyat yuborish", callback_data: "cmp:new" }]
  ]));
}
async function showSettings(u, chat) {
  return send(chat, `⚙️ <b>Sozlamalar</b>

Til: 🇺🇿 O‘zbekcha
Soatlik hisobot: ${u.notifications ? "yoqilgan ✅ (har soatda nechta obunachi kelgani haqida xabar keladi)" : "o‘chirilgan ⛔"}`, inline([[{ text: u.notifications ? "🔕 Hisobotni o‘chirish" : "🔔 Hisobotni yoqish", callback_data: "notif" }]]));
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
  await send(chat, "\u{1F4E2} Botdan foydalanish uchun quyidagi homiy kanallarga obuna bo\u2018ling:", inline([
    ...missing.map((s) => [{ text: `\u{1F4E2} ${s.title}`, url: s.url }]),
    [{ text: "\u2705 Tekshirish", callback_data: "sp:check" }]
  ]));
  return false;
}
async function createOrder(u, destId, qty, chat) {
  const dest = destOf(destId);
  if (!dest) return send(chat, "Manzil topilmadi.", MENU);
  const platform = destId.startsWith("ig-") ? "instagram" : "telegram";
  if (S().areOrdersFrozen) return send(chat, "\u{1F9CA} Buyurtmalar vaqtincha muzlatilgan.", MENU);
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, "\u{1F4F8} Instagram moduli o\u2018chirilgan.", MENU);
  if (!Number.isInteger(qty) || qty < 10 || qty > 1e4) return send(chat, "Son 10 dan 10 000 gacha bo\u2018lishi kerak. Qaytadan yozing:");
  const unit = platform === "telegram" ? S().creditRewardTelegram : S().creditRewardInstagram;
  const chk = calculateOrderAffordability(u.credits, qty, unit);
  if (!chk.canAfford) {
    u.state = null;
    return send(chat, `\u274C <b>Kredit yetmayapti</b>

Kerak: ${chk.totalCost} kredit
Sizda: ${u.credits.available} kredit
Yetmayapti: ${chk.shortage} kredit

Kredit ishlash uchun \u201C\u{1F4CB} Vazifalar\u201D tugmasini bosing \u2014 har bir obuna uchun ${S().creditRewardTelegram} kredit beriladi.`, MENU);
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
    status: "active",
    createdAt: nowStr()
  };
  db.orders.push(o);
  platform === "telegram" ? (dest.totalRequested += qty, dest.pendingSubscriptions += qty) : (dest.totalRequested += qty, dest.pendingFollowers += qty);
  addTx(u, -chk.totalCost, "order_spend", `Buyurtma band qilindi: ${o.destinationTitle} \xD7 ${qty}`, { orderId: o.id });
  u.state = null;
  save();
  return send(chat, `\u{1F6D2} <b>Buyurtma qabul qilindi!</b>

\u2022 Kanal: ${esc(o.destinationTitle)}
\u2022 Soni: ${qty} ta obunachi
\u2022 Narxi: ${chk.totalCost} kredit (hisobingizda band qilindi)

Obunachilar navbat bilan qo\u2018shiladi. Holatini \u201C\u{1F6D2} Buyurtmalarim\u201D da ko\u2018rasiz.`, MENU);
}
async function cancelOrder(u, orderId, chat) {
  const o = db.orders.find((x) => x.id === orderId && x.userId === u.id);
  if (!o || o.status !== "active") return send(chat, "Buyurtma topilmadi yoki allaqachon yopilgan.", MENU);
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
  return send(chat, `\u21A9\uFE0F <b>Buyurtma bekor qilindi</b>

Kelgan obunachilar saqlanadi (${o.verifiedQuantity} ta), bajarilmagan ${refundableUnits} ta uchun <b>${refundCredits} kredit</b> qaytarildi.
${balanceLine(u)}`, MENU);
}
async function addChannel(u, text, chat) {
  const uname = text.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{4,}$/.test(uname)) return send(chat, "Manzil noto\u2018g\u2018ri. Kanalingiz manzilini yuboring, masalan: <code>@mening_kanalim</code>\n\nBekor qilish: /cancel");
  const info = await tg("getChat", { chat_id: `@${uname}` });
  if (!info.ok || info.result.type !== "channel") return send(chat, "\u274C Bu manzilda kanal topilmadi.\n\nKanal <b>ommaviy (public)</b> bo\u2018lishi va manzili @ bilan yozilishi kerak.");
  const ch = info.result;
  const botMe = await checkBotAdmin(ch.id);
  if (!botMe) return send(chat, "\u274C Bot bu kanalda <b>administrator</b> emas.\n\nKanal sozlamalari \u2192 Administratorlar \u2192 botni qo\u2018shib, qayta yuboring.");
  const me = await tg("getChatMember", { chat_id: ch.id, user_id: u.telegramId });
  if (!me.ok || !["creator", "administrator"].includes(me.result.status)) return send(chat, "\u274C Siz bu kanalning administratori emassiz.\n\nFaqat o\u2018zingiz boshqaradigan kanalni ulash mumkin.");
  const existing = db.channels.find((c) => c.channelId === String(ch.id));
  if (existing) {
    u.state = null;
    return send(chat, existing.ownerId === u.id ? "Bu kanal allaqachon ulangan \u2014 qayta ulash shart emas." : "\u274C Bu kanal boshqa foydalanuvchida ulangan.\n\nUning egasi sizga bir martalik kod bersa, \u201C\u{1F511} Kod kiritish\u201D orqali nazoratchi bo\u2018lasiz.", MENU);
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
    addTx(u, linkBonus, "channel_link_bonus", `Kanal ulandi: ${ch.title}`);
  }
  u.state = null;
  save();
  return send(chat, `\u{1F4E2} <b>Kanal ulandi!</b>

\u2022 ${esc(ch.title)} (@${esc(ch.username || uname)})
\u2022 Bot kanalda administrator \u2014 tasdiqlandi \u2705
\nEndi \u201C\u{1F6D2} Buyurtmalarim\u201D emas, \u201C\u{1F4E2} Kanallarim\u201D dan kanalingizni tanlab obunachi buyurtib berishingiz mumkin.` +
    (linkBonus > 0
      ? `
\u{1F381} Kanal ulaganingiz uchun <b>+${linkBonus} kredit</b> sovg'a!\n${balanceLine(u)}`
      : `
${balanceLine(u)}`), MENU);
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
  if (!m) return send(chat, "Instagram username yoki havolasini yuboring. Masalan: <code>@my_brand</code>");
  const username = m[1];
  if (db.igProfiles.some((p) => p.username.toLowerCase() === username.toLowerCase())) {
    u.state = null;
    return send(chat, "Bu profil allaqachon ulangan.", MENU);
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
  return send(chat, `\u{1F4F8} @${esc(username)} qo\u2018shildi.`, MENU);
}
async function submitComplaint(u, category, desc, chat) {
  const ticketId = `TICKET-${Math.floor(1e3 + Math.random() * 9e3)}`;
  db.complaints.push({ id: nid("cmp"), ticketId, userId: u.id, userName: u.displayName, category, description: desc.slice(0, 2e3), status: "NEW", createdAt: nowStr(), updatedAt: nowStr() });
  u.state = null;
  save();
  for (const a of ADMIN_IDS) send(a, `\u{1F6DF} Yangi shikoyat <b>${ticketId}</b>
${esc(u.displayName)} (${u.telegramId})
${esc(category)}

${esc(desc.slice(0, 500))}

Javob: <code>/reply ${ticketId} matn</code>`);
  return send(chat, `\u{1F6DF} Murojaat qabul qilindi!
Bilet: <b>${ticketId}</b>
Adminlar tez orada javob beradi.`, MENU);
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
      return send(chat, `\u2705 Kod tasdiqlandi! Siz <b>${esc(ch.title)}</b> kanalida nazoratchisiz.`, MENU);
    }
    if (v.reason && !/noto‘g‘ri/.test(v.reason)) lastReason = v.reason;
  }
  return send(chat, `\u274C ${lastReason}`, MENU);
}
function guideText(u) {
  const bonus = Math.max(0, Number(S().creditRewardChannelLink) || 0);
  const per = S().creditRewardTelegram;
  return `📖 <b>Bot qanday ishlaydi</b>

Bot ikki ish uchun kerak:
1) Boshqa kanallarga obuna bo‘lib <b>kredit</b> ishlaysiz
2) Shu kredit bilan o‘z kanalingizga <b>obunachi</b> yig‘asiz

💰 <b>Kredit nima?</b> — bu bot ichidagi hisob birligi. 1 obunachi = ${per} kredit. Pul emas, naqd qilib bo‘lmaydi.

1️⃣ <b>Kredit ishlash</b>
“📋 Vazifalar” tugmasini bosing → kanalga obuna bo‘ling → “✅ Obuna bo‘ldim” tugmasini bosing. Bot obunani o‘zi tekshiradi va har biri uchun <b>+${per} kredit</b> beradi.

2️⃣ <b>Kanalingizni ulash</b>
Avval botni kanalingizga <b>administrator</b> qiling. Keyin “📢 Kanallarim” → “➕ Kanal qo‘shish” → kanal manzilini yuboring.
${bonus > 0 ? `Birinchi marta ulaganingizda <b>+${bonus} kredit</b> sovg‘a oladi.\n` : ""}
3️⃣ <b>Obunachi buyurtish</b>
“📢 Kanallarim” dan kanalingizni tanlang va nechta obunachi kerakligini yozing. Kredit darhol band qilinadi, obunachilar navbat bilan qo‘shiladi.

4️⃣ <b>Referal</b>
“👥 Referal tizimi” da shaxsiy havolangiz bor. Do‘stingiz shu havola bilan kirib bitta vazifa bajarsa, sizga <b>+${S().creditRewardReferral} kredit</b> beriladi.

❓ Har bir tugma nima qilishini bilish uchun “🛟 Yordam” tugmasini bosing.

Pastdagi menyudan boshlang ↓`;
}
async function handleMessage(msg) {
  if (msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return;
  const chat = msg.chat.id;
  const text = (msg.text || "").trim();
  const { user: u, isNew } = getUser(msg.from, chat);
  if (u.status === "blocked") return send(chat, "\u26D4 Hisobingiz bloklangan.");
  if (S().isBotPaused && !isAdmin(u.telegramId)) return send(chat, "\u23F8 Bot vaqtincha to\u2018xtatilgan. Keyinroq urinib ko\u2018ring.");
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
      await send(chat, `Assalomu alaykum, <b>${esc(u.displayName)}</b>! \u{1F44B}

Botga xush kelibsiz! Quyida qisqa yo\u2018riqnoma.`, MENU);
      await send(chat, guideText(u));
    } else {
      await send(chat, `Assalomu alaykum, <b>${esc(u.displayName)}</b>! \u{1F680}

Bu Telegram va Instagram o\u2018zaro o\u2018sish platformasi.
Boshqa kanallarga obuna bo\u2018lib kredit ishlang va o\u2018z kanalingizga obunachi buyurtma qiling.

${balanceLine(u)}`, MENU);
    }
    await sponsorGate(u, chat);
    return;
  }
  if (/^\/(help|yordam|qollanma)/i.test(text)) {
    u.state = null;
    return showHelp(chat);
  }
  if (text.startsWith("/admin") || text.startsWith("/") && isAdmin(u.telegramId)) {
    if (isAdmin(u.telegramId)) return handleAdmin(u, text, chat);
  }
  if (text === "/cancel") {
    u.state = null;
    return send(chat, "Bekor qilindi.", MENU);
  }
  if (MENU_LABELS.has(text)) u.state = null;
  if (!await sponsorGate(u, chat)) return;
  const st = u.state;
  if (st && !MENU_LABELS.has(text)) {
    if (st.type === "add_channel") return addChannel(u, text, chat);
    if (st.type === "add_ig") return addInstagram(u, text, chat);
    if (st.type === "order_qty") return createOrder(u, st.destId, parseInt(text.replace(/\D/g, ""), 10), chat);
    if (st.type === "ctl_code") return enterControllerCode(u, text, chat);
    if (st.type === "complaint") return submitComplaint(u, st.category, text, chat);
  }
  switch (text) {
    case "\u{1F4CB} Vazifalar":
      return showTasks(u, "telegram", chat);
    case "\u{1F4E2} Kanallarim":
      return showChannels(u, chat);
    case "\u{1F6D2} Buyurtmalarim":
      return showOrders(u, chat);
    case "\u{1F4F8} Instagram":
      return showInstagram(u, chat);
    case "\u{1F465} Referal tizimi":
      return showReferrals(u, chat);
    case "\u{1F4CA} Statistika":
      return showStats(u, chat);
    case "\u{1F6DF} Yordam":
      return showHelp(chat);
    case "\u2699\uFE0F Sozlamalar":
      return showSettings(u, chat);
    default:
      return send(chat, "Kerakli amalni pastdagi menyudan tanlang.", MENU);
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
    if (await sponsorGate(u, chat)) return send(chat, "\u2705 Rahmat! Endi botdan foydalanishingiz mumkin.", MENU);
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
      return send(chat, "\u{1F4E2} <b>Kanal ulash \u2014 3 qadam</b>\n\n1. Kanalingiz sozlamalariga kirib, botni <b>administrator</b> qiling\n2. Kanal manzilini yuboring, masalan: <code>@mening_kanalim</code>\n3. Bot kanalni tekshiradi va ulaydi\n\nBirinchi marta ulaganingizda <b>+10 kredit</b> sovg\u2018a.\n\nBekor qilish: /cancel");
    case "igadd":
      u.state = { type: "add_ig" };
      return send(chat, "\u{1F4F8} Instagram username yoki havolasini yuboring. Bekor qilish: /cancel");
    case "ord": {
      const d = destOf(arg);
      if (!d) return;
      const isTg = arg.startsWith("ch-");
      if (isTg && !channelsOf(u).some((c) => c.id === arg)) return;
      if (!isTg && d.userId !== u.id) return;
      u.state = { type: "order_qty", destId: arg };
      const unit = isTg ? S().creditRewardTelegram : S().creditRewardInstagram;
      return send(chat, `\u{1F6D2} <b>${esc(isTg ? d.title : "@" + d.username)}</b>

Nechta ${isTg ? "obunachi" : "follower"} kerakligini yozing (10 dan 10000 gacha).
\u2022 Narx: ${unit} kredit / 1 ta
\u2022 ${balanceLine(u)}
\u2022 Bu kredit bilan ko\u2018pi bilan: ${Math.floor(u.credits.available / unit)} ta
\u2022 Kredit hozir band qilinadi, obunachilar kelganda sarflanadi
\nBekor qilish: /cancel`);
    }
    case "cx":
      return send(chat, "Buyurtmani bekor qilmoqchimisiz? Bajarilmagan qismi uchun kredit qaytariladi.", inline([[{ text: "Ha, bekor qilish", callback_data: `cxy:${arg}` }, { text: "Yo\u2018q", callback_data: "noop:0" }]]));
    case "cxy":
      return cancelOrder(u, arg, chat);
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
      return send(chat, "\u{1F511} 6 xonali kodni yuboring:");
    case "cmp":
      return send(chat, "Muammo turini tanlang:", inline(CATEGORIES.map((c, i) => [{ text: c, callback_data: `cmpc:${i}` }])));
    case "cmpc": {
      const c = CATEGORIES[Number(arg)];
      if (!c) return;
      u.state = { type: "complaint", category: c };
      return send(chat, `\u{1F4DD} <b>${esc(c)}</b>

Muammoni batafsil yozing. Bekor qilish: /cancel`);
    }
    case "notif":
      u.notifications = !u.notifications;
      save();
      return showSettings(u, chat);
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
Mukofot: TG ${S().creditRewardTelegram} / IG ${S().creditRewardInstagram} / ref ${S().creditRewardReferral}

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
    if (!u || !u.notifications) continue;
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
function authed(req) {
  const h = req.headers.authorization || "";
  if (!ADMIN_PASSWORD || !h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  if (!authed(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Growth Exchange"' });
    res.end("Parol kerak");
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
          for (const k of ["creditRewardSignup", "creditRewardChannelLink", "creditRewardTelegram", "creditRewardInstagram", "creditRewardReferral"]) {
            if (b[k] === void 0) continue;
            const n = Number(b[k]);
            if (!Number.isFinite(n) || n < 0) throw new Error(k + " noto'g'ri son");
            s[k] = Math.round(n);
          }
          for (const k of ["isBotPaused", "areOrdersFrozen", "isInstagramEnabled", "hourlyNotificationsEnabled"]) {
            if (b[k] !== void 0) s[k] = !!b[k];
          }
          save();
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
