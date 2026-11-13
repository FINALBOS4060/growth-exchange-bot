// server/index.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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
  isInstagramEnabled: false,
  // Instagram'ni tekshirib bo'lmaydi (o'zi tasdiqlaydi) — admin /igon bilan yoqadi
  isBotPaused: false,
  isTelegramPaused: false,
  areOrdersFrozen: false,
  hourlyNotificationsEnabled: true,
  telegramBotToken: "",
  botUsername: "",
  botDisplayName: "Growth Exchange Bot",
  botId: "",
  webhookUrl: "",
  webhookStatus: "polling",
  // News bot (world-news-bot integratsiyasi) — /news sahifasidan boshqariladi
  news: {
    enabled: true,
    channel: "@WORLD_NEWS_1M",
    times: ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "19:30", "21:00", "22:30", "00:00"],
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.1-flash-lite-preview", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-2.5-flash", "gemini-2.5-flash-lite", "antigravity-preview-latest"],
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
async function tg(method, params = {}, timeoutMs = 35e3) {
  try {
    const r = await fetch(`${API}/bot${TOKEN}/${method}`, {
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
var send = (chat, text, extra = {}) => tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
var notify = (u, text) => u ? send(u.chatId, text) : Promise.resolve();
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
    db.users[key] = {
      id: `u-${from.id}`,
      telegramId: from.id,
      username: from.username,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id),
      language: "uz",
      credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0 },
      registeredAt: nowStr(),
      referralCode: `REF_${from.id}`,
      isReferralVerified: false,
      completedTasksCount: 0,
      activeOrdersCount: 0,
      status: "active",
      chatId,
      notifications: true
    };
  }
  const u = db.users[key];
  u.chatId = chatId;
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
  if (!batch.length) return send(chat, "Tekshiradigan vazifa yo\u2018q. \u{1F4CB} Vazifalar tugmasini bosing.", MENU);
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
  let text = `\u2705 <b>Tekshiruv yakunlandi!</b>

\u2022 Tasdiqlangan: ${out.verifiedTasks.length} ta
\u2022 Mukofot: +${earned} kredit
\u2022 Balans: ${u.credits.available} kredit`;
  if (notDone.length) text += `

\u23F3 <b>Hali bajarilmagan (${notDone.length} ta)</b> \u2014 obuna bo\u2018lib, qayta tekshiring:
` + notDone.map((t) => `\u2022 ${esc(t.destinationTitle)}`).join("\n");
  if (out.apiErrorTasks.length) text += `

\u26A0\uFE0F ${out.apiErrorTasks.length} ta kanalni tekshirib bo\u2018lmadi (texnik xato). Bu obunani bekor qilish hisoblanmaydi \u2014 keyinroq qayta tekshiriladi.`;
  await send(chat, text, MENU);
  if (!notDone.length && !out.apiErrorTasks.length) await showTasks(u, platform, chat);
}
function balanceLine(u) {
  return `\u{1F4B0} Balans: <b>${u.credits.available}</b> kredit  \u2022  \u{1F512} Band: ${u.credits.reserved}`;
}
async function showTasks(u, platform, chat) {
  if (platform === "telegram" && S().isTelegramPaused) return send(chat, "\u23F8 Telegram vazifalari vaqtincha to\u2018xtatilgan.", MENU);
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, "\u{1F4F8} Instagram moduli hozircha o\u2018chirilgan.", MENU);
  const batch = getBatch(u, platform);
  if (!batch.length) return send(chat, `\u{1F4CB} Hozircha sizga mos vazifa yo\u2018q. Keyinroq urinib ko\u2018ring.

${balanceLine(u)}`, MENU);
  const reward = batch[0].rewardCredits;
  const text = `\u{1F4CB} <b>${platform === "telegram" ? "Obuna" : "Instagram follow"} vazifalari (${batch.length} ta):</b>

Har bir havolani oching, ${platform === "telegram" ? "obuna bo\u2018ling" : "follow qiling"}, so\u2018ng tasdiqlash tugmasini bosing.
Har biri uchun: <b>+${reward}</b> kredit.

` + batch.map((t, i) => `${i + 1}. ${esc(t.destinationTitle)}${t.isDeferred ? " \u{1F501}" : ""}`).join("\n") + (platform === "instagram" ? "\n\n\u26A0\uFE0F Instagram o\u2018zi tasdiqlash asosida ishlaydi \u2014 soxta tasdiqlar admin tomonidan tekshiriladi." : "");
  const rows = batch.map((t, i) => [{ text: `\u{1F517} ${i + 1}. ${t.destinationTitle}`.slice(0, 60), url: t.destinationUrl }]);
  rows.push([{ text: platform === "telegram" ? "\u2705 Obuna bo\u2018ldim" : "\u2705 Bajardim", callback_data: `verify:${platform === "telegram" ? "tg" : "ig"}` }]);
  rows.push([{ text: "\u{1F504} Yangilash", callback_data: `tasks:${platform === "telegram" ? "tg" : "ig"}` }]);
  return send(chat, text, inline(rows));
}
var channelsOf = (u) => db.channels.filter((c) => c.ownerId === u.id || c.controllers.some((k) => k.userId === u.id));
async function showChannels(u, chat) {
  const chs = channelsOf(u);
  const text = `\u{1F4E2} <b>Sizning kanallaringiz:</b> ${chs.length} ta

` + (chs.length ? chs.map((c) => `\u2022 <b>${esc(c.title)}</b> (@${esc(c.username)}) \u2014 ${c.verifiedSubscribers} tasdiqlangan, ${c.pendingSubscriptions} kutilmoqda${c.ownerId !== u.id ? " (nazoratchi)" : ""}`).join("\n") : "Hali kanal ulanmagan. Botni kanalingizga <b>administrator</b> qilib qo\u2018shing va \u201C\u2795 Kanal qo\u2018shish\u201D ni bosing.") + `

${balanceLine(u)}`;
  const rows = chs.map((c) => [{ text: `\u{1F6D2} ${c.title}`.slice(0, 40), callback_data: `ord:${c.id}` }, ...c.ownerId === u.id ? [{ text: "\u{1F511} Kod", callback_data: `ctl:${c.id}` }] : []]);
  rows.push([{ text: "\u2795 Kanal qo\u2018shish", callback_data: "chadd" }, { text: "\u{1F511} Kod kiritish", callback_data: "ctlin" }]);
  return send(chat, text, inline(rows));
}
async function showOrders(u, chat) {
  const os = db.orders.filter((o) => o.userId === u.id).slice(-10).reverse();
  const text = `\u{1F6D2} <b>Buyurtmalaringiz:</b> ${db.orders.filter((o) => o.userId === u.id).length} ta
${balanceLine(u)}

` + (os.length ? os.map((o) => `${o.platform === "telegram" ? "\u{1F4E2}" : "\u{1F4F8}"} <b>${esc(o.destinationTitle)}</b>
   ${o.verifiedQuantity}/${o.requestedQuantity} bajarildi \u2022 ${o.status === "active" ? "\u{1F7E2} faol" : o.status === "completed" ? "\u2705 yakunlangan" : "\u26D4 bekor"} \u2022 ${o.totalCost} kredit`).join("\n\n") : "Hali buyurtma yo\u2018q. \u201C\u{1F4E2} Kanallarim\u201D orqali buyurtma bering.");
  const rows = os.filter((o) => o.status === "active").map((o) => [{ text: `\u274C Bekor: ${o.destinationTitle}`.slice(0, 45), callback_data: `cx:${o.id}` }]);
  return send(chat, text, rows.length ? inline(rows) : MENU);
}
async function showInstagram(u, chat) {
  if (!S().isInstagramEnabled) return send(chat, "\u{1F4F8} Instagram moduli hozircha o\u2018chirilgan.", MENU);
  const ps = db.igProfiles.filter((p) => p.userId === u.id);
  const text = `\u{1F4F8} <b>Instagram moduli</b>

Kredit umumiy, lekin vazifalar navbati Telegram\u2019dan mustaqil.

` + (ps.length ? ps.map((p) => `\u2022 @${esc(p.username)} \u2014 ${p.selfReportedFollowers} follower`).join("\n") : "Profil yo\u2018q.") + `

${balanceLine(u)}`;
  const rows = ps.map((p) => [{ text: `\u{1F6D2} @${p.username}`, callback_data: `ord:${p.id}` }]);
  rows.push([{ text: "\u2795 Profil qo\u2018shish", callback_data: "igadd" }, { text: "\u{1F4CB} Instagram vazifalar", callback_data: "tasks:ig" }]);
  return send(chat, text, inline(rows));
}
async function showReferrals(u, chat) {
  const refs = db.referrals.filter((r) => r.referrerId === u.id);
  const paid = refs.filter((r) => r.bonusIssued).length;
  return send(chat, `\u{1F465} <b>Referal tizimi</b>

Taklif qilingan do\u2018st kamida bitta vazifani <b>rasmiy tasdiqlangan</b> holda bajarsa, sizga <b>+${S().creditRewardReferral}</b> kredit beriladi.

Taklif qilinganlar: ${refs.length} ta \u2022 Mukofot olingan: ${paid} ta

\u{1F517} Havolangiz:
https://t.me/${S().botUsername}?start=${u.referralCode}`, MENU);
}
async function showStats(u, chat) {
  const c = u.credits;
  return send(chat, `\u{1F4CA} <b>Statistika</b>

\u{1F464} ${esc(u.displayName)}
\u{1F194} ${u.telegramId}
\u{1F4B0} Balans: ${c.available} kredit
\u{1F512} Band: ${c.reserved}
\u{1F4B8} Sarflangan: ${c.spent}
\u21A9\uFE0F Qaytarilgan: ${c.refunded}
\u2705 Bajarilgan vazifalar: ${u.completedTasksCount}
\u{1F4E2} Kanallar: ${channelsOf(u).length} ta
\u{1F6D2} Faol buyurtmalar: ${db.orders.filter((o) => o.userId === u.id && o.status === "active").length} ta`, MENU);
}
async function showHelp(chat) {
  return send(chat, "\u{1F6DF} <b>Yordam markazi</b>\n\nSavol yoki shikoyatingiz bo\u2018lsa, murojaat yuboring \u2014 adminlar ko\u2018rib chiqadi.", inline([[{ text: "\u{1F4DD} Shikoyat yuborish", callback_data: "cmp:new" }]]));
}
async function showSettings(u, chat) {
  return send(chat, `\u2699\uFE0F <b>Sozlamalar</b>

Til: \u{1F1FA}\u{1F1FF} O\u2018zbekcha
Soatlik hisobot: ${u.notifications ? "yoqilgan \u2705" : "o\u2018chirilgan \u26D4"}`, inline([[{ text: u.notifications ? "\u{1F515} Hisobotni o\u2018chirish" : "\u{1F514} Hisobotni yoqish", callback_data: "notif" }]]));
}
var CATEGORIES = [
  "Obunachilar kamayib ketdi",
  "Buyurtmam bajarilmayapti",
  "Obunachilar noto\u2018g\u2018ri hisoblanmoqda",
  "Kanalimda texnik muammo bor",
  "Kanalimga ruxsatsiz buyurtma berilgan",
  "Boshqa muammo",
  "Shikoyatimni o\u2018zim yozaman"
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
  if (!Number.isInteger(qty) || qty < 10 || qty > 1e4) return send(chat, "Miqdor 10 dan 10000 gacha butun son bo\u2018lishi kerak. Qayta kiriting:");
  const unit = platform === "telegram" ? S().creditRewardTelegram : S().creditRewardInstagram;
  const chk = calculateOrderAffordability(u.credits, qty, unit);
  if (!chk.canAfford) {
    u.state = null;
    return send(chat, `\u274C Kredit yetarli emas!
Talab: ${chk.totalCost}
Mavjud: ${u.credits.available}
Kamchilik: ${chk.shortage}

\u{1F4CB} Vazifalarni bajarib kredit to\u2018plang.`, MENU);
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

\u2022 ${esc(o.destinationTitle)}
\u2022 Miqdor: ${qty}
\u2022 Narx: ${chk.totalCost} kredit (band qilindi)
\u2022 FIFO navbatiga qo\u2018yildi.`, MENU);
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
  return send(chat, `\u21A9\uFE0F Buyurtma bekor qilindi.
Bajarilgan qism saqlandi, ${refundableUnits} ta bajarilmagan uchun <b>${refundCredits}</b> kredit qaytarildi.
${balanceLine(u)}`, MENU);
}
async function addChannel(u, text, chat) {
  const uname = text.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{4,}$/.test(uname)) return send(chat, "Username noto\u2018g\u2018ri. Masalan: <code>@my_channel</code>. Qayta yuboring yoki menyudan tanlang.");
  const info = await tg("getChat", { chat_id: `@${uname}` });
  if (!info.ok || info.result.type !== "channel") return send(chat, "\u274C Kanal topilmadi (ommaviy kanal bo\u2018lishi kerak).");
  const ch = info.result;
  const botMe = await checkBotAdmin(ch.id);
  if (!botMe) return send(chat, "\u274C Bot bu kanalda administrator emas. Botni administrator qilib qo\u2018shing va qayta yuboring.");
  const me = await tg("getChatMember", { chat_id: ch.id, user_id: u.telegramId });
  if (!me.ok || !["creator", "administrator"].includes(me.result.status)) return send(chat, "\u274C Siz bu kanalning administratori emassiz. Boshqa odam kanaliga o\u2018zingizni egasi qilib ulash mumkin emas.");
  const existing = db.channels.find((c) => c.channelId === String(ch.id));
  if (existing) {
    u.state = null;
    return send(chat, existing.ownerId === u.id ? "Bu kanal allaqachon ulangan." : "\u274C Bu kanal boshqa foydalanuvchi nomida ulangan. Nazoratchi kodi orqali qo\u2018shiling.", MENU);
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
  u.state = null;
  save();
  return send(chat, `\u{1F4E2} <b>Kanal ulandi!</b>

\u2022 ${esc(ch.title)} (@${esc(ch.username || uname)})
\u2022 Bot admin huquqi: tasdiqlangan \u2705`, MENU);
}
var BOT_ID = 0;
async function checkBotAdmin(chatId) {
  const r = await tg("getChatMember", { chat_id: chatId, user_id: BOT_ID });
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
    await send(chat, `Assalomu alaykum, <b>${esc(u.displayName)}</b>! \u{1F680}

Bu Telegram va Instagram o\u2018zaro o\u2018sish platformasi.
Boshqa kanallarga obuna bo\u2018lib kredit ishlang va o\u2018z kanalingizga obunachi buyurtma qiling.

${balanceLine(u)}`, MENU);
    await sponsorGate(u, chat);
    return;
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
      return send(chat, "\u{1F4E2} Kanal username\u2019ini yuboring (masalan <code>@my_channel</code>).\n\nAvval botni kanalga <b>administrator</b> qilib qo\u2018shing. Bekor qilish: /cancel");
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
      return send(chat, `\u{1F6D2} <b>${esc(isTg ? d.title : "@" + d.username)}</b> uchun nechta ${isTg ? "obunachi" : "follower"} kerak?

Narx: ${unit} kredit/dona \u2022 ${balanceLine(u)}
Maksimal: ${Math.floor(u.credits.available / unit)} ta (10 dan 10000 gacha)

Sonni yozing. Bekor qilish: /cancel`);
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
    await send(u.chatId, `\u{1F550} <b>Soatlik hisobot (${fmt(from)} \u2013 ${fmt(to)})</b>

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
async function pollLoop() {
  for (; ; ) {
    const r = await tg("getUpdates", { offset: db.offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 45e3);
    if (!r.ok) {
      console.error("getUpdates xato:", r.description);
      await new Promise((res) => setTimeout(res, r.error_code === 409 ? 1e4 : 3e3));
      continue;
    }
    for (const up of r.result) {
      db.offset = up.update_id + 1;
      const from = up.message?.from || up.callback_query?.from;
      if (!from) continue;
      if (up.message) enqueue(from.id, () => handleMessage(up.message));
      else if (up.callback_query) enqueue(from.id, () => handleCallback(up.callback_query));
    }
    save();
  }
}
var MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json" };
var DIST = path.join(ROOT, "dist");
function authed(req) {
  const h = req.headers.authorization || "";
  if (!ADMIN_PASSWORD || !h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// --- News bot: Gemini bilan yangilik yaratib, kanalga post qiladi ---
var NEWS_TOKEN = (process.env.NEWS_BOT_TOKEN || "8231778750:AAH4jJaKSZ7a_ATxSHthi_JiRWuIJ2ob33Q").trim();
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
    channel: "@WORLD_NEWS_1M",
    times: ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "19:30", "21:00", "22:30", "00:00"],
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
    let sent;
    if (image) {
      sent = await newsTg("sendPhoto", { chat_id: cfg.channel, photo: image, caption: body.slice(0, 1024) });
      if (!sent.ok) sent = await newsTg("sendMessage", { chat_id: cfg.channel, text: body.slice(0, 4096) });
    } else {
      sent = await newsTg("sendMessage", { chat_id: cfg.channel, text: body.slice(0, 4096) });
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
    const slot = `${t.date} ${t.time}`;
    if (!c.times.includes(t.time) || c.sent.includes(slot)) return;
    c.sent.push(slot);
    c.sent = c.sent.slice(-200);
    save();
    await newsPublish("jadval");
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
    <div><label>Kanal (@yoki -100…)</label><input id="channel" placeholder="@WORLD_NEWS_1M"></div>
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
    const dry = url.searchParams.get("dry") === "1";
    newsPublish(dry ? "sinov" : "qo'lda", dry).then((r) => {
      res.writeHead(r.ok ? 200 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify(r));
    });
    return;
  }
  if (url.pathname === "/api/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      users: Object.keys(db.users).length,
      channels: db.channels.length,
      igProfiles: db.igProfiles.length,
      activeOrders: db.orders.filter((o) => o.status === "active").length,
      openTasks: db.tasks.filter((t) => OPEN.has(t.status)).length,
      complaintsNew: db.complaints.filter((c) => c.status === "NEW").length,
      settings: { ...S(), telegramBotToken: void 0 }
    }));
    return;
  }
  let file = path.normalize(path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
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
async function startBot() {
  if (!TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN o'rnatilmagan - faqat veb panel ishlaydi.");
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const me = await tg("getMe");
    if (me.ok) {
      BOT_ID = me.result.id;
      S().botId = String(BOT_ID);
      S().botUsername = me.result.username;
      S().botDisplayName = me.result.first_name;
      await tg("deleteWebhook", { drop_pending_updates: false });
      await tg("setMyCommands", { commands: [{ command: "start", description: "Botni ishga tushirish" }, { command: "cancel", description: "Joriy amalni bekor qilish" }] });
      save();
      console.log(`Bot @${me.result.username} ishga tushdi (long polling)`);
      setInterval(() => hourlyReport().catch((e) => console.error(e)), 6e4);
      setInterval(() => maintenance().catch((e) => console.error(e)), 15 * 6e4);
      pollLoop();
      return;
    }
    console.error(`Bot ishga tushmadi (urinish ${attempt}):`, me.description || (me.network ? "tarmoq xatosi" : "noma'lum xato"));
    console.error("30 soniyadan keyin qayta urinamiz. Veb panel va /healthz ishlashda davom etadi.");
    await new Promise((res) => setTimeout(res, 3e4));
  }
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
async function main() {
  await openStore();
  server.on("error", (e) => {
    console.error("HTTP server xatosi:", e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => console.log(`Veb server: http://${HOST}:${PORT} (saqlash: ${STORAGE})`));
  startKeepAlive();
  startNewsScheduler();
  await startBot();
}
main().catch((e) => {
  console.error("Ishga tushirishda halokatli xato:", e);
  process.exit(1);
});
