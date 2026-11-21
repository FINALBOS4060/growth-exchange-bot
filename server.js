// server/index.ts
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { summarizeRuntime } from "./scripts/lib/ledger-reconcile.mjs";

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
      // Vaqtinchalik xato: FIFO'ga EMAS, CHECK_ERROR holatida qoladi. Uni
      // faqat doimiy TASK_CHECK jobi qayta tekshiradi (spec §2).
      deferredTasks.push({
        ...task,
        status: "CHECK_ERROR"
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
var APP_ENV = String(process.env.APP_ENV || "").trim().toLowerCase();
var IS_TEST_ENV = APP_ENV === "test";
function isLoopbackUrl(base) {
  try {
    const h = new URL(base).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}
// Xavfsizlik (spec D): `APP_ENV=test` — HAQIQIY Telegram va haqiqiy bot
// tokenlari bilan ishlamaydigan rejim. Noto'g'ri sozlansa jarayon umuman
// ishga tushmaydi (jimgina production'ga yozib yubormasligi uchun).
function assertEnvSafe() {
  if (!IS_TEST_ENV) return;
  if (!process.env.TELEGRAM_API_BASE || !isLoopbackUrl(process.env.TELEGRAM_API_BASE)) {
    throw new Error("TEST_EGRESS_BLOCKED: APP_ENV=test uchun TELEGRAM_API_BASE loopback mock bo'lishi shart");
  }
  const real = [process.env.TELEGRAM_BOT_TOKEN, process.env.NEWS_BOT_TOKEN]
    .map((x) => String(x || "").trim())
    .filter((x) => x && x !== "TESTTOKEN");
  if (real.length) throw new Error("TEST_EGRESS_BLOCKED: test rejimida haqiqiy bot tokeni ishlatilmaydi");
}
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
  // Instagram'ni rasmiy tekshirib bo'lmaydi (o'zi tasdiqlaydi). Shuning uchun
  // unga sarflanadigan kredit berilmaydi — admin xohlasa shu qiymatni oshiradi.
  creditRewardInstagramSelfConfirmed: 0,
  // Malakali referal mukofoti — bitta umumiy hamyonga kredit sifatida (bir marta).
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
  // Balansdagi kredit avtomatik ravishda o'z kanaliga buyurtmaga aylantiriladi.
  autoOrderCredits: true,
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
  // A'zolik (membership) registri: har bir (foydalanuvchi, kanal) juftligi uchun
  // bitta yozuv + voqealar tarixi + rejalashtirilgan tekshiruv navbati.
  memberships: [],
  membershipEvents: [],
  verificationJobs: [],
  sponsorMemberships: [],
  notifPeriods: [],
  ctlRequests: [],
  verifyLog: [],
  // Tekshiruv nosozliklari jurnali: har bir muvaffaqiyatsiz getChatMember
  // so'rovi to'liq diagnostika bilan yoziladi (chat, user, kod, tavsif, HTTP
  // holati, retry_after). Ilgari xato "Telegram API xatosi" degan umumiy matn
  // bilan almashtirilardi va haqiqiy sabab butunlay yo'qolardi.
  verifyErrors: [],
  adminUsers: [],
  auditLog: [],
  appeals: [],
  settings: defaultSettings(),
  lastExportAt: 0,
  lastBackupAt: 0,
  moderationFlags: [],
  lastHour: 0,
  // Panel «Operatsiyalar» bo'limi: oxirgi texnik amallar (faqat ko'rsatish).
  opsMeta: {}
};
function applyLoadedState(loaded) {
  if (!loaded || typeof loaded !== "object") return false;
  db = { ...db, ...loaded, settings: { ...defaultSettings(), ...loaded.settings || {} } };
  if (!Array.isArray(db.verifyErrors)) db.verifyErrors = [];
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
// Oxirgi o'qilgan/yozilgan holat (uch tomonlama merge uchun ASOS) va `rev`.
// `rev` — `app_state` qatorining versiyasi: har muvaffaqiyatli yozuvda +1.
var LAST_STATE = "";
// Bazada HAQIQATAN turgan holat matni (oxirgi muvaffaqiyatli yozuv yoki
// o'qilgan qator). `persistNow()` aynan shu matn bilan solishtiradi;
// `syncDown()` boshqa instans yozganini ko'rsa tozalaydi.
var DB_STATE = "";
var STATE_REV = 0;
// `persist()` natijani HAQIQIY qaytaradi: xato yutilmaydi. Zanjir (dbChain)
// hech qachon rad etilmaydi — bitta xato keyingi yozuvlarni bloklamaydi, lekin
// chaqiruvchi `false` oladi va pul amalini qaytarish imkoniga ega bo'ladi.
//
// KO'P INSTANS: yozuv `rev` bo'yicha CAS bilan bajariladi —
// `WHERE id = 1 AND rev = <o'qilgan rev>`. Eski xotira nusxasi yangi
// ma'lumotni JIMGINA bosib ketolmaydi: 0 qator qaytadi va natija `false`.
function persistNow() {
  if (!dbPool) return Promise.resolve(true);
  const payload = JSON.stringify(db);
  // Holat bazadagi bilan AYNAN bir xil bo'lsa — JSON'ni qayta yubormaymiz.
  // Solishtirish faqat `DB_STATE` bilan: `LAST_STATE` merge uchun ASOS bo'lib,
  // u mahalliy saqlanmagan o'zgarishlarni ham o'z ichiga oladi (unga tayanib
  // "o'zgarmagan" deyish ma'lumot yo'qotardi). `rev` ham o'zgarmaydi — CAS
  // mantiqi (WHERE id = 1 AND rev = $2) tegilmaydi.
  if (payload === DB_STATE) return Promise.resolve(true);
  const expect = STATE_REV;
  const p = dbChain.then(() => dbPool.query(
    "UPDATE app_state SET data = $1::jsonb, rev = rev + 1, updated_at = now() WHERE id = 1 AND rev = $2 RETURNING rev",
    [payload, expect]
  ));
  dbChain = p.then(() => {}, () => {});
  return p.then((r) => {
    if (!r.rows || !r.rows.length) {
      console.error(`Postgres CAS konflikti: rev ${expect} eskirgan — yozuv rad etildi (holat qulfi ostida qayta o'qish kerak)`);
      return false;
    }
    STATE_REV = Number(r.rows[0].rev) || expect + 1;
    LAST_STATE = payload;
    DB_STATE = payload;
    return true;
  }, (e) => {
    console.error("Postgres saqlash xatosi:", e && e.message || e);
    return false;
  });
}
// Qulflar ASYNC KONTEKST bo'yicha qayta kirishga ruxsat beradi: bir xil
// so'rov ichida `withStateTx` → `flushOrRollback` → `withSaveLock` zanjiri
// o'zini bloklab qo'ymasligi kerak, boshqa so'rov esa kutishi shart.
var LOCK_CTX = new AsyncLocalStorage();
// Pul yozuvlari va ularning rollback'i KETMA-KET bajariladi: aks holda xato
// bo'lgan operatsiya hali xotirada qaytarilmaganda boshqa yozuv shu holatni
// bazaga ko'chirib qo'yardi. `flushSaveAwaited()` faqat shu qulf ICHIDA
// chaqiriladi (u `persistNow()` ishlatadi — qayta qulf olish yo'q).
var SAVE_LOCK = Promise.resolve();
async function withSaveLock(fn) {
  const st = LOCK_CTX.getStore();
  if (st && st.save) return fn();
  const prev = SAVE_LOCK;
  let release;
  SAVE_LOCK = new Promise((r) => {
    release = r;
  });
  await prev;
  try {
    return await LOCK_CTX.run({ save: true, state: false }, fn);
  } finally {
    release();
  }
}
function persist() {
  return withStateTx(async () => persistNow()).then((r) => (r && r.ok ? !!r.value : false));
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
      // `rev` — instanslararo yozuv navbati. `ADD COLUMN IF NOT EXISTS` mavjud
      // jadvalni buzmaydi va ma'lumotni qayta yozmaydi (destruktiv migratsiya yo'q).
      await dbPool.query("ALTER TABLE app_state ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0");
      const r = await dbPool.query("SELECT data, rev FROM app_state WHERE id = 1");
      if (r.rows.length) {
        applyLoadedState(r.rows[0].data);
        STATE_REV = Number(r.rows[0].rev) || 0;
        LAST_STATE = JSON.stringify(db);
        DB_STATE = LAST_STATE;
        console.log("Saqlash: Postgres (mavjud holat yuklandi, rev=" + STATE_REV + ")");
      } else {
        loadFile();
        // Qator yo'q — yaratamiz. Ikki instans bir vaqtda ko'tarilsa
        // `ON CONFLICT DO NOTHING`: ikkinchisi birinchisining holatini o'qiydi.
        const ins = await dbPool.query(
          "INSERT INTO app_state (id, data, rev) VALUES (1, $1::jsonb, 0) ON CONFLICT (id) DO NOTHING RETURNING rev",
          [JSON.stringify(db)]
        );
        if (ins.rows.length) {
          STATE_REV = 0;
          LAST_STATE = JSON.stringify(db);
          DB_STATE = LAST_STATE;
        } else {
          const r2 = await dbPool.query("SELECT data, rev FROM app_state WHERE id = 1");
          if (r2.rows.length) applyLoadedState(r2.rows[0].data);
          STATE_REV = r2.rows.length ? Number(r2.rows[0].rev) || 0 : 0;
          LAST_STATE = JSON.stringify(db);
          DB_STATE = LAST_STATE;
        }
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
// ===== Instans qulfi (bir token → bitta polling jarayoni) =====
// Productionda 26 soat ichida 16 marta qayta ishga tushish bo'lgan. Har safar
// yangi instans eski instansning long-poll so'rovi tugashini kutmasdan
// getUpdates boshlagan → Telegram "Conflict: terminated by other getUpdates
// request" qaytargan. Endi polling huquqi bazadagi qulf bilan beriladi:
// Postgres'da `pg_try_advisory_lock` (ulanish uzilsa avtomatik bo'shaydi),
// fayl rejimida esa heartbeat bilan yangilanadigan lock fayli.
var LOCK_HELD = /* @__PURE__ */ new Set();
var LOCK_CONN = null;
var LOCK_CONN_BUSY = false;
var INSTANCE_ID = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
// Token → barqaror qulf kaliti. Bir xil token har doim bir xil kalitga,
// turli tokenlar esa mustaqil kalitlarga tushadi (sha1 = determinist, 40 hex).
function pollLockKey(token) {
  return "poll:" + crypto.createHash("sha1").update(String(token || "")).digest("hex");
}
function lockFile(key) {
  const h = crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 12);
  return path.join(path.dirname(DATA_FILE), `.lock-${h}.json`);
}
// Qulf saqlash qatlamiga MOS bo'lishi shart: Postgres ishlamay fayl rejimiga
// tushib qolgan bo'lsa, advisory lock hech qachon olinmaydi va bot umuman
// polling qilmay qolardi.
function lockViaPg() {
  return STORAGE === "postgres" && !!DATABASE_URL;
}
async function lockClient() {
  if (!lockViaPg()) return null;
  if (LOCK_CONN) return LOCK_CONN;
  if (LOCK_CONN_BUSY) return null;
  LOCK_CONN_BUSY = true;
  try {
    const pgMod = await import("pg");
    const pg = pgMod.default || pgMod;
    const c = new pg.Client(pgConfig(DATABASE_URL));
    await c.connect();
    c.on("error", (e) => {
      console.error("Qulf ulanishi uzildi:", e.message);
      LOCK_CONN = null;
      LOCK_HELD.clear();
      onLockLost();
    });
    LOCK_CONN = c;
    return c;
  } catch (e) {
    console.error("Qulf ulanishi ochilmadi:", e.message);
    return null;
  } finally {
    LOCK_CONN_BUSY = false;
  }
}
async function tryLock(key) {
  if (!lockViaPg()) {
    const f = lockFile(key);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      const mine = cur && cur.id === INSTANCE_ID;
      const fresh = cur && Date.now() - (cur.at || 0) < 6e4;
      if (!mine && fresh) {
        // Jarayon tirikmi? O'lgan bo'lsa qulf darhol bo'sh hisoblanadi
        // (crashdan keyin 60 soniya kutmaymiz).
        let alive = cur.pid === process.pid;
        if (!alive && cur.pid) {
          try {
            process.kill(cur.pid, 0);
            alive = true;
          } catch (e) {
            alive = !!e && e.code === "EPERM";
          }
        }
        if (alive) return false;
      }
    } catch {}
    try {
      fs.writeFileSync(f, JSON.stringify({ id: INSTANCE_ID, pid: process.pid, at: Date.now(), key }));
      LOCK_HELD.add(key);
      return true;
    } catch {
      return false;
    }
  }
  const c = await lockClient();
  if (!c) return false;
  try {
    // hashtextextended — 64-bitli kalit (hashtext 32-bitli, to'qnashuv ehtimoli
    // yuqoriroq edi). Seed 0: kalit barqaror va determinist.
    const r = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", ["gxb:" + key]);
    if (r.rows[0] && r.rows[0].ok) {
      LOCK_HELD.add(key);
      return true;
    }
    return false;
  } catch (e) {
    console.error("Qulf olishda xato:", e.message);
    LOCK_CONN = null;
    LOCK_HELD.clear();
    return false;
  }
}
async function releaseLock(key) {
  if (!LOCK_HELD.has(key)) return;
  LOCK_HELD.delete(key);
  if (!lockViaPg()) {
    try {
      fs.unlinkSync(lockFile(key));
    } catch {}
    return;
  }
  const c = LOCK_CONN;
  if (!c) return;
  try {
    await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", ["gxb:" + key]);
  } catch {}
}
async function releaseAllLocks() {
  for (const k of [...LOCK_HELD]) await releaseLock(k);
  if (LOCK_CONN) {
    try {
      await LOCK_CONN.end();
    } catch {}
    LOCK_CONN = null;
  }
}
// Qulf ulanishi uzilsa Postgres qulfni bo'shatadi — boshqa instans polling
// boshlashi mumkin. Shuning uchun biz DARHOL pollingni to'xtatamiz, aks holda
// ikkita jarayon bir tokenni tortib oladi.
function onLockLost() {
  if (shuttingDown) return;
  if (!botRuns || !botRuns.size) return;
  console.error("Qulf yo'qoldi — polling to'xtatiladi (boshqa instans davom etadi)");
  for (const id of [...botRuns.keys()]) stopBotLoop(id);
}
function startLockHeartbeat(sec = 25) {
  setInterval(async () => {
    if (!lockViaPg()) {
      for (const k of LOCK_HELD) {
        try {
          fs.writeFileSync(lockFile(k), JSON.stringify({ id: INSTANCE_ID, pid: process.pid, at: Date.now(), key: k }));
        } catch {}
      }
      return;
    }
    if (!LOCK_CONN) return;
    try {
      await LOCK_CONN.query("SELECT 1");
    } catch (e) {
      console.error("Qulf heartbeat xatosi:", e.message);
      LOCK_CONN = null;
      LOCK_HELD.clear();
      onLockLost();
    }
  }, Math.max(5, sec) * 1e3);
}
// `saveNow()` endi muvaffaqiyatni qaytaradi: pul amalidan keyin foydalanuvchiga
// "bajarildi" deb faqat yozuv HAQIQATAN diskda bo'lsa aytiladi.
function saveNow() {
  if (dbPool) return true;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (e) {
    console.error("Faylga saqlash xatosi", e);
    return false;
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
// Xavfsizlik holati (login urinishlari) uchun darhol yozish: jarayon shu
// paytda o'chsa ham blok yo'qolmaydi.
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const ok = saveNow();
  persist();
  return ok;
}
// Pul amallari uchun ANIQ saqlash: Postgres rejimida yozuv haqiqatan
// bajarilganini KUTADI. `flushSave()` fayl rejimida sinxron va aniq, lekin
// Postgres'da yozuvni kutmasdan `true` qaytarardi — shu sababli
// `flushOrRollback()` PG'da hech qachon qaytarmasdi.
async function flushSaveAwaited() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dbPool) return saveNow();
  // Yozuv holat tranzaksiyasi orqali: qulf ostida eng so'nggi holat bilan
  // birlashtiriladi, keyin `rev` bo'yicha CAS bilan yoziladi. Tranzaksiya
  // ichidan chaqirilganda qayta qulf olinmaydi (reentrant).
  const r = await withStateTx(() => persistNow());
  return r.ok ? !!r.value : false;
}
// Pul maydonlari snapshot'i: `flushSave()` yiqilsa o'zgarishni qaytarish uchun.
function creditsSnapshot(u) {
  return { credits: { ...u.credits }, txLen: db.transactions.length, op: CURRENT_OP };
}
function creditsRestore(u, snap) {
  if (!snap) return;
  Object.assign(u.credits, snap.credits);
  // Faqat shu operatsiya yozgan tranzaksiyalar olib tashlanadi.
  db.transactions = dropOpRows(db.transactions, snap, snap.txLen);
}
// Chuqur nusxa va joyida tiklash: obyekt REFERENSI uzilmaydi, shuning uchun
// bir vaqtda ishlayotgan boshqa handler'larning yozuvlari yo'qolmaydi.
function deepCopy(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}
function restoreInto(target, src) {
  if (!target || !src) return;
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  for (const k of Object.keys(src)) {
    const v = src[k];
    const cur = target[k];
    // Ichma-ich obyektlar ham JOYIDA yangilanadi: ishlab turgan handler
    // ushlab turgan `u.credits` kabi havolalar uzilib qolmaydi.
    if (v && cur && typeof v === "object" && typeof cur === "object" && !Array.isArray(v) && !Array.isArray(cur)) {
      restoreInto(cur, v);
    } else target[k] = v;
  }
}
// Operatsiya identifikatori: rollback faqat SHU operatsiya yaratgan yozuvlarni
// olib tashlaydi. Ilgari massivlar uzunlik bo'yicha qisqartirilardi — persist
// kutish paytida boshqa handler yozgan yozuv ham o'chib ketardi.
var CURRENT_OP = "";
var OP_SEQ = 0;
function newOpId(prefix) {
  return `${prefix || "op"}:${Date.now().toString(36)}${(++OP_SEQ).toString(36)}`;
}
// Sinxron mutatsiya blokini belgilaydi; `await` dan OLDIN `end()` chaqiriladi.
function opSet(id) {
  const prev = CURRENT_OP;
  CURRENT_OP = id;
  return () => {
    CURRENT_OP = prev;
  };
}
function opStart(prefix) {
  return opSet(newOpId(prefix));
}
// Snapshot `op` ni saqlaydi; rollback faqat o'sha operatsiya yozuvlarini oladi.
function dropOpRows(arr, snap, fallbackLen) {
  if (!Array.isArray(arr)) return [];
  if (!snap || !snap.op) return arr.length > (fallbackLen || 0) ? arr.slice(0, fallbackLen || 0) : arr;
  return arr.filter((x) => !(x && x.opId === snap.op));
}
/* ===========================================================================
 * INSTANSLARARO HOLAT TRANZAKSIYASI (`app_state`)
 *
 * Muammo: har bir Node.js jarayoni butun holatni xotirada ushlab, butun JSON
 * hujjatni bitta qatorga yozadi. Ikki instans bir vaqtda pul yozsa, keyingi
 * yozuv oldingisini bosib ketardi (lost update) — balans va jurnal ajralardi.
 *
 * Yechim (qatlamlar):
 *  1. PostgreSQL advisory lock (`gxb:state`) — butun o'qish → tekshirish →
 *     mutatsiya → yozish zanjiri shu qulf ostida. Qulf alohida ulanishda
 *     turadi; ulanish uzilsa Postgres uni bo'shatadi.
 *  2. Qulf ostida holat BAZADAN qayta o'qiladi (`syncDown`) va xotiraga
 *     JOYIDA ko'chiriladi (`liveSync`) — handler ushlab turgan obyektlar
 *     yangi qiymatlarni ko'radi, ya'ni tekshiruvlar eng so'nggi holat bo'yicha
 *     bajariladi (eski snapshot bilan qaror qabul qilinmaydi).
 *  3. Yozuv `rev` bo'yicha CAS bilan — qulfdan tashqarida qolgan eski nusxa
 *     hech qachon yangi ma'lumotni jimgina bosib ketolmaydi.
 *  4. Qulf olinmasa yoki holatni o'qib bo'lmasa, pul amali BAJARILMAYDI va
 *     `save_failed` qaytadi — foydalanuvchiga yolg'on muvaffaqiyat xabari yo'q.
 *
 * Fayl rejimi (lokal, `DATABASE_URL` yo'q) — bitta jarayon, qulf kerak emas.
 * ========================================================================= */
var STATE_CONN = null;
var STATE_CONN_BUSY = false;
var STATE_LOCK_KEY = "gxb:state";
var STATE_LOCK_TIMEOUT_MS = 20000;

async function stateClient() {
  if (!lockViaPg()) return null;
  if (STATE_CONN) return STATE_CONN;
  if (STATE_CONN_BUSY) return null;
  STATE_CONN_BUSY = true;
  try {
    const pgMod = await import("pg");
    const pg = pgMod.default || pgMod;
    const c = new pg.Client(pgConfig(DATABASE_URL));
    await c.connect();
    // Ulanish uzilsa Postgres qulfni o'zi bo'shatadi; biz esa buni xato deb
    // hisoblaymiz — tranzaksiya `lock_lost` bilan yakunlanadi va rollback bo'ladi.
    c.on("error", (e) => {
      console.error("Holat qulfi ulanishi uzildi:", e && e.message || e);
      STATE_CONN = null;
    });
    STATE_CONN = c;
    return c;
  } catch (e) {
    console.error("Holat qulfi ulanishi ochilmadi:", e && e.message || e);
    return null;
  } finally {
    STATE_CONN_BUSY = false;
  }
}
async function acquireStateLock(timeoutMs) {
  if (!lockViaPg()) return { ok: true, client: null };
  const c = await stateClient();
  if (!c) return { ok: false, reason: "no_conn" };
  const deadline = Date.now() + (Number(timeoutMs) || STATE_LOCK_TIMEOUT_MS);
  for (;;) {
    let r;
    try {
      // hashtextextended — 64-bitli, determinist kalit (polling qulfi bilan
      // bir xil uslub); kalit `gxb:state` prefiksi bilan polling kalitlaridan
      // ajralgan, shuning uchun ular bir-birini bloklamaydi.
      r = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [STATE_LOCK_KEY]);
    } catch (e) {
      console.error("Holat qulfini olishda xato:", e && e.message || e);
      return { ok: false, reason: "lock_error" };
    }
    if (r.rows[0] && r.rows[0].ok) return { ok: true, client: c };
    if (Date.now() >= deadline) return { ok: false, reason: "lock_timeout" };
    await new Promise((res) => setTimeout(res, 40 + Math.floor(Math.random() * 60)));
  }
}
async function releaseStateLock(c) {
  if (!c) return;
  try {
    await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [STATE_LOCK_KEY]);
  } catch {}
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function idOf(o) {
  if (!o || typeof o !== "object") return "";
  return o.id || o.telegramId || o.key || "";
}
// Bitta yozuv (obyekt) uchun uch tomonlama merge. `base` — oxirgi kelishilgan
// holat, `ours` — bizning xotiramiz, `theirs` — bazadagi yangi holat.
function mergeRecord(base, ours, theirs) {
  if (!ours || !theirs) return ours;
  if (sameJson(ours, base)) return theirs;
  if (sameJson(theirs, base)) return ours;
  if (typeof ours !== "object" || typeof theirs !== "object") return ours;
  if (Array.isArray(ours) || Array.isArray(theirs)) return ours;
  return mergeTop(base && typeof base === "object" ? base : {}, ours, theirs);
}
// `id` li massivlar (orders, tasks, transactions, ...) — kalit bo'yicha merge.
function mergeList(base, ours, theirs) {
  if (!Array.isArray(ours) || !Array.isArray(theirs)) return ours;
  const keyed = (arr) => arr.every((x) => x && typeof x === "object" && idOf(x));
  if (!keyed(ours) || !keyed(theirs)) return ours;
  const bi = new Map((Array.isArray(base) ? base : []).map((x) => [idOf(x), x]));
  const oi = new Map(ours.map((x) => [idOf(x), x]));
  const ti = new Map(theirs.map((x) => [idOf(x), x]));
  const out = [];
  for (const t of theirs) {
    const id = idOf(t);
    const b = bi.get(id);
    const o = oi.get(id);
    if (!o) {
      // Bizda yo'q: agar avval ham yo'q bo'lsa — o'sha instans qo'shgan.
      if (!b) out.push(t);
      continue;
    }
    out.push(mergeRecord(b, o, t));
  }
  for (const o of ours) {
    const id = idOf(o);
    if (!ti.has(id) && !bi.has(id)) out.push(o); // biz qo'shgan yangi yozuv
  }
  return out;
}
// Butun holat uchun uch tomonlama merge (kalit → yozuv darajasida).
function mergeTop(base, ours, theirs) {
  const b = base && typeof base === "object" ? base : {};
  const o = ours && typeof ours === "object" ? ours : {};
  const t = theirs && typeof theirs === "object" ? theirs : {};
  const out = {};
  for (const k of new Set([...Object.keys(t), ...Object.keys(o)])) {
    const bv = b[k];
    const ov = o[k];
    const tv = t[k];
    if (!(k in o)) {
      out[k] = tv;
      continue;
    }
    if (!(k in t)) {
      if (!sameJson(ov, bv)) out[k] = ov; // biz qo'shgan/o'zgartirgan — saqlanadi
      continue;
    }
    if (sameJson(ov, bv)) {
      out[k] = tv;
      continue;
    }
    if (sameJson(tv, bv)) {
      out[k] = ov;
      continue;
    }
    if (Array.isArray(ov) && Array.isArray(tv)) {
      out[k] = mergeList(bv, ov, tv);
      continue;
    }
    if (ov && tv && typeof ov === "object" && typeof tv === "object") {
      const rec = {};
      const bb = bv && typeof bv === "object" ? bv : {};
      for (const kk of new Set([...Object.keys(tv), ...Object.keys(ov)])) {
        if (!(kk in ov)) {
          rec[kk] = tv[kk];
          continue;
        }
        if (!(kk in tv)) {
          if (!sameJson(ov[kk], bb[kk])) rec[kk] = ov[kk];
          continue;
        }
        rec[kk] = mergeRecord(bb[kk], ov[kk], tv[kk]);
      }
      out[k] = rec;
      continue;
    }
    // Skalyar: oxirgi yozuvchi yutadi. `seq` faqat o'sadi.
    out[k] = k === "seq" && typeof ov === "number" && typeof tv === "number" ? Math.max(ov, tv) : ov;
  }
  return out;
}
// Bazadagi holatni xotiraga JOYIDA ko'chiradi. `db`, `db.users[id]` va massiv
// elementlarining IDENTIFIKLIGI saqlanadi — ishlab turgan handler'lar ushlab
// turgan havolalar (`u`, `t`, `o`) yangi qiymatlarni ko'radi.
function liveSync(fresh) {
  if (!fresh || typeof fresh !== "object") return false;
  const cur = db || {};
  const keep = new Set(Object.keys(fresh));
  for (const k of Object.keys(cur)) if (!keep.has(k)) delete cur[k];
  for (const k of keep) {
    const fv = fresh[k];
    const cv = cur[k];
    if (Array.isArray(fv)) {
      if (!Array.isArray(cv)) {
        cur[k] = fv;
        continue;
      }
      const map = new Map();
      for (const x of cv) if (x && typeof x === "object") {
        const id = idOf(x);
        if (id) map.set(id, x);
      }
      const out = [];
      for (const x of fv) {
        const id = x && typeof x === "object" ? idOf(x) : "";
        const hit = id ? map.get(id) : null;
        if (hit && x && typeof x === "object" && typeof hit === "object") {
          restoreInto(hit, x);
          out.push(hit);
        } else out.push(x);
      }
      cur[k] = out;
      continue;
    }
    if (fv && typeof fv === "object") {
      if (!cv || typeof cv !== "object" || Array.isArray(cv)) {
        cur[k] = fv;
        continue;
      }
      const keep2 = new Set(Object.keys(fv));
      for (const kk of Object.keys(cv)) if (!keep2.has(kk)) delete cv[kk];
      for (const kk of Object.keys(fv)) {
        const x = fv[kk];
        const y = cv[kk];
        if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) restoreInto(y, x);
        else cv[kk] = x;
      }
      continue;
    }
    cur[k] = fv;
  }
  LAST_STATE = JSON.stringify(db);
  // Birlashgan natija bazadagi matnga teng bo'lmasligi mumkin — keyingi
  // saqlash oddiy yozuv bo'lib qoladi (`persistNow()` o'tkazib yubormaydi).
  DB_STATE = "";
  return true;
}
// Qulf ostida: bazadagi eng so'nggi holatni o'qib, xotira bilan BIRLASHTIRIB
// qo'llaymiz. Mahalliy saqlanmagan o'zgarishlar yo'qolmaydi (ular `ours`),
// boshqa instansning yozuvlari ham yo'qolmaydi (ular `theirs`).
async function syncDown() {
  if (!dbPool) return { ok: true };
  let row;
  try {
    const r = await dbPool.query("SELECT data, rev FROM app_state WHERE id = 1");
    if (!r.rows.length) return { ok: false, reason: "no_row" };
    row = r.rows[0];
  } catch (e) {
    console.error("Holatni qayta o'qish xatosi:", e && e.message || e);
    return { ok: false, reason: "read_error" };
  }
  const rev = Number(row.rev) || 0;
  if (!LAST_STATE) {
    liveSync(row.data);
    STATE_REV = rev;
    DB_STATE = JSON.stringify(db);
    return { ok: true };
  }
  if (rev === STATE_REV) return { ok: true }; // boshqa instans yozmagan
  let base = {};
  try {
    base = JSON.parse(LAST_STATE);
  } catch {}
  let ours = {};
  try {
    ours = JSON.parse(JSON.stringify(db));
  } catch {}
  const merged = mergeTop(base, ours, row.data);
  liveSync(merged);
  STATE_REV = rev;
  return { ok: true };
}
// INSTANSLARARO KRITIK BO'LIM: qulf → eng so'nggi holat → `fn()` → qulfni
// bo'shatish. Qaytaradi: `{ ok: true, value }` yoki `{ ok: false, reason }`.
// `ok: false` — pul amali BAJARILMAGAN deb hisoblanishi shart (`save_failed`).
async function withStateTx(fn) {
  const st = LOCK_CTX.getStore();
  // Allaqachon shu tranzaksiya ichidamiz — qulf qayta olinmaydi, lekin natija
  // HAM bir xil konvertda qaytadi (`{ok,value}`), aks holda chaqiruvchi
  // muvaffaqiyatli yozuvni xato deb o'ylardi.
  if (st && st.state) return { ok: true, value: await fn() };
  const run = async () => {
    const store = LOCK_CTX.getStore();
    const acq = await acquireStateLock();
    if (!acq.ok) {
      console.error(`Holat qulfi olinmadi (${acq.reason}) — amal bajarilmadi`);
      return { ok: false, reason: acq.reason };
    }
    if (store) store.state = true;
    try {
      const sync = await syncDown();
      if (!sync.ok) return { ok: false, reason: sync.reason };
      const value = await fn();
      return { ok: true, value };
    } catch (e) {
      console.error("Holat tranzaksiyasi xatosi:", e && e.message || e);
      return { ok: false, reason: "tx_error" };
    } finally {
      if (store) store.state = false;
      await releaseStateLock(acq.client);
    }
  };
  if (st && st.save) return run();
  return withSaveLock(run);
}
// Darhol saqlash; yiqilsa `rollback()` bajariladi va `false` qaytadi. Shu tufayli
// saqlamagan pul amali uchun foydalanuvchiga muvaffaqiyat xabari yuborilmaydi.
async function flushOrRollback(rollback) {
  // Saqlash + rollback — bitta qulf ostida: oraga boshqa yozuv kirmaydi.
  return withSaveLock(async () => {
    if (await flushSaveAwaited()) return true;
    try {
      if (rollback) rollback();
    } catch (e) {
      console.error("rollback xatosi:", e && e.message || e);
    }
    return false;
  });
}
// Ichki audit yozuvi: HTTP so'rovi talab qilinmaydi va tarix qisqartirilmaydi
// (rad etilgan qaytim kabi hodisalar yo'qolmasligi kerak).
function auditSys(action, target, meta) {
  try {
    db.auditLog.push({
      id: nid("log"),
      at: nowStr(),
      actor: "system",
      role: "system",
      action: String(action || ""),
      target: String(target || ""),
      meta: meta ? String(meta).slice(0, 300) : "",
      ip: ""
    });
  } catch (e) {
    console.error("auditSys xatosi:", e && e.message || e);
  }
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
// Telegram nosozlik turlari. Har bir tur ALOHIDA ishlanadi: 401 token
// muammosi, 403 huquq/block, 400 noto'g'ri so'rov, 429 rate limit, 5xx esa
// vaqtinchalik server xatosi. Ilgari hammasi bitta "xato" bo'lib qolardi.
var TG_ERR = {
  AUTH: "auth",
  BLOCKED: "blocked",
  BAD_REQUEST: "bad_request",
  RATE_LIMIT: "rate_limit",
  SERVER: "server",
  NETWORK: "network",
  NETWORK_TIMEOUT: "network_timeout",
  NO_RIGHTS: "no_rights",
  NOT_FOUND: "not_found",
  UNKNOWN: "unknown"
};
function classifyTgFailure(r) {
  if (!r || r.ok) return { errKind: "", transient: false, retryAfter: 0 };
  // tgWith javobni allaqachon tasniflagan bo'lsa (masalan HTTP 502 HTML),
  // qayta tasniflash uni yo'qotib qo'yardi.
  if (r.errKind) {
    return {
      errKind: r.errKind,
      transient: !!r.transient,
      retryAfter: Math.max(0, Number(r.parameters && r.parameters.retry_after) || Number(r.retryAfter) || 0)
    };
  }
  const code = Number(r.error_code) || 0;
  const d = String(r.description || "");
  const retryAfter = Math.max(0, Number(r.parameters && r.parameters.retry_after) || 0);
  if (r.network) {
    const timeout = /timeout|timed out|aborted/i.test(String(r.errKind || "") + " " + d);
    return { errKind: timeout ? TG_ERR.NETWORK_TIMEOUT : TG_ERR.NETWORK, transient: true, retryAfter };
  }
  // 429 — faqat retry_after tugagandan keyin urinamiz (spec §2).
  if (code === 429) return { errKind: TG_ERR.RATE_LIMIT, transient: true, retryAfter };
  // 401 — token/autentifikatsiya. Vaqtinchalik deb belgilanadi, chunki bu
  // hech qachon "bot administrator emas" degan fakt emas; admin xabardor qilinadi.
  if (code === 401) return { errKind: TG_ERR.AUTH, transient: true, retryAfter: 0, authError: true };
  if (code === 403) return { errKind: TG_ERR.BLOCKED, transient: false, retryAfter: 0 };
  if (code >= 500) return { errKind: TG_ERR.SERVER, transient: true, retryAfter };
  if (/chat not found|peer_id_invalid|channel_invalid|username not occupied|no channel found/i.test(d)) {
    return { errKind: TG_ERR.NOT_FOUND, transient: false, retryAfter: 0 };
  }
  if (/not enough rights|chat_admin_required|have no rights|member list is inaccessible|bot is not a member/i.test(d)) {
    return { errKind: TG_ERR.NO_RIGHTS, transient: false, retryAfter: 0 };
  }
  if (code === 400) return { errKind: TG_ERR.BAD_REQUEST, transient: false, retryAfter: 0 };
  if (/timeout|timed out|ECONN|EAI_AGAIN|socket hang up|fetch failed|network/i.test(d)) {
    return { errKind: TG_ERR.NETWORK, transient: true, retryAfter };
  }
  return { errKind: TG_ERR.UNKNOWN, transient: false, retryAfter: 0 };
}
// HTTP holati ham saqlanadi: Render proksisi "502 Bad Gateway" HTML qaytarsa
// `r.json()` yiqilardi va xato tarmoq xatosi deb noto'g'ri tasniflanardi.
// Bir nechta signalni birlashtirish (timeout + tashqi bekor qilish).
function anySignal(signals) {
  const list = (signals || []).filter(Boolean);
  if (!list.length) return void 0;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") return AbortSignal.any(list);
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ac.abort();
      break;
    }
    s.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac.signal;
}
async function tgWith(bot, method, params = {}, timeoutMs = 35e3, signal = null) {
  const token = (bot && bot.token) || "";
  const askedAt = Date.now();
  if (!token) {
    return { ok: false, error_code: 0, description: "Bot tokeni yo'q", errKind: TG_ERR.AUTH, transient: false, failedMethod: method, askedAt };
  }
  let httpStatus = 0;
  let raw = "";
  try {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: anySignal([AbortSignal.timeout(timeoutMs), signal])
    });
    httpStatus = r.status;
    raw = await r.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      const kind = httpStatus === 429 ? TG_ERR.RATE_LIMIT
        : httpStatus >= 500 ? TG_ERR.SERVER
        : httpStatus === 401 ? TG_ERR.AUTH
        : httpStatus === 403 ? TG_ERR.BLOCKED
        : TG_ERR.UNKNOWN;
      return {
        ok: false,
        error_code: 0,
        http_status: httpStatus,
        description: `HTTP ${httpStatus}: ${raw.slice(0, 200).replace(/\s+/g, " ").trim() || "(bo'sh javob)"}`,
        errKind: kind,
        transient: kind === TG_ERR.SERVER || kind === TG_ERR.RATE_LIMIT,
        failedMethod: method,
        askedAt
      };
    }
    if (data.ok) return data;
    return { ...data, http_status: httpStatus, failedMethod: method, askedAt, ...classifyTgFailure(data) };
  } catch (e) {
    const name = String((e && e.name) || "Error");
    const msg = String((e && e.message) || e);
    const aborted = !!(signal && signal.aborted);
    const timeout = /timeout|aborted/i.test(name + " " + msg);
    if (aborted) {
      return { ok: false, aborted: true, error_code: 0, description: "aborted", errKind: TG_ERR.NETWORK, transient: true, failedMethod: method, askedAt };
    }
    return {
      ok: false,
      error_code: 0,
      http_status: httpStatus,
      description: `${name}: ${msg}`.slice(0, 240),
      network: true,
      errKind: timeout ? TG_ERR.NETWORK_TIMEOUT : TG_ERR.NETWORK,
      transient: true,
      failedMethod: method,
      askedAt,
      raw: raw.slice(0, 200)
    };
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
// A'zolikni tekshirish — natija bilan birga SABAB ham qaytadi. Sababsiz
// "error" keyinchalik "obunadan chiqdi" yoki "bot huquqsiz" bilan
// aralashtirilib ketardi.
// A'zolik tekshiruvi uchun kutish vaqti (testda qisqartiriladi).
var TG_CHECK_TIMEOUT_MS = Math.max(500, Number(process.env.TG_CHECK_TIMEOUT_MS) || 15e3);
async function checkMemberWith(bot, chat, userId, ctx = {}) {
  const r = await tgWith(bot, "getChatMember", { chat_id: chat, user_id: userId }, TG_CHECK_TIMEOUT_MS);
  if (r.ok) {
    const st = r.result.status;
    if (["member", "administrator", "creator"].includes(st)) return { result: "member", reason: "" };
    if (st === "restricted") return r.result.is_member ? { result: "member", reason: "" } : { result: "not_member", reason: "restricted" };
    return { result: "not_member", reason: "status_" + st };
  }
  if (/user not found|PARTICIPANT_ID_INVALID/i.test(r.description || "")) return { result: "not_member", reason: "user_invalid" };
  const f = classifyTgFailure(r);
  // 401 — token muammosi. Bu hech qachon "obunadan chiqdi" ham, "bot admin
  // emas" ham emas; administratorga darhol xabar beriladi.
  if (f.errKind === TG_ERR.AUTH && ctx.record !== false) {
    alertAdmins("tg_401", "\u26A0\uFE0F <b>Telegram 401 Unauthorized</b>\n\nBot tokeni yaroqsiz ko\u2018rinadi. Tekshiruvlar vaqtincha to\u2018xtatilmaydi, lekin natijalar ishonchsiz. Tokenni tekshiring: Render \u2192 Environment \u2192 TELEGRAM_BOT_TOKEN.");
  }
  // Har bir nosozlik to'liq diagnostika bilan bazaga va logga yoziladi.
  const diag = ctx.record === false ? null : recordVerifyFailure(tgDiag(r, "getChatMember", { chatId: chat, userId, ...ctx }));
  return {
    result: "error",
    reason: f.errKind || TG_ERR.UNKNOWN,
    transient: !!f.transient,
    retryAfter: Number(f.retryAfter) || 0,
    diag,
    description: String(r.description || "")
  };
}
// A'zolikni tekshirish. Joriy bot kanalda admin bo'lmasa (Telegram doimiy xato
// qaytaradi), kanalda admin bo'lgan BOSHQA bot bilan qayta uriniladi — shuning
// uchun «bitta bot admin bo'lsa yetarli» amalda ham bajariladi.
async function checkMemberInfo(chat, userId, ctx = {}) {
  const cur = curBot();
  const first = await checkMemberWith(cur, chat, userId, ctx);
  if (first.result !== "error" || first.transient) return first;
  // Doimiy xato (bot admin emas / huquq yo'q) — admin huquqi bor BOSHQA
  // botlar bilan qayta urinamiz. Ro'yxat 3 ta bilan cheklanmaydi: aks holda
  // 4+ bot bo'lganda admin bot zaxira ro'yxatiga tushmay qolishi mumkin.
  // Admin botni birinchi qilib chiqamiz (botAdminBotId ma'lum bo'lsa).
  const others = botsForChecks().filter((b) => b && b.token && !(cur && b.id === cur.id));
  for (const b of others) {
    const alt = await checkMemberWith(b, chat, userId, { ...ctx, record: false });
    if (alt.result !== "error") return { ...alt, viaBot: b.id };
    if (alt.transient) return first;
  }
  return first;
}
async function checkMember(chat, userId) {
  return (await checkMemberInfo(chat, userId)).result;
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
    tasks_none: "📋 <b>Hozircha vazifa yo‘q</b>\n\nSababi: {reason}\n\n{balance}",
    tasks_reason_orders: "hozir tizimda faol buyurtma yo‘q — hech kim obunachi buyurtma qilmagan. Keyinroq yana urinib ko‘ring.",
    tasks_reason_done: "siz mavjud barcha kanallarga obuna bo‘lib bo‘lgansiz. Yangi buyurtma tushishi bilan vazifa shu yerda paydo bo‘ladi.",
    tasks_reason_own: "mavjud buyurtmalar sizning kanalingizga tegishli — o‘z kanalingiz vazifa bo‘lib chiqmaydi.",
    tasks_supply: "\nℹ️ Hozir tizimda {o} ta faol buyurtma, sizga mos {b} ta kanal bor — hammasi shu ro‘yxatda.",
    tasks_already: "\n\n♻️ Bu kanal(lar) sizda allaqachon bor. Yangi buyurtmalar tushganda shu yerda paydo bo‘ladi.",
    auto_order_note: "\n\n🛒 <b>Avtomatik buyurtma</b>\n{qty} kreditingiz “{title}” kanaliga obunachi buyurtmasiga aylantirildi.",
    ch_order_hint: "\n\n💡 {a} kreditingiz bor. Kanalingizni tanlab “🛒 Buyurtma berish” orqali obunachi buyurtma qiling — miqdorni o‘zingiz kiritasiz.",
    tasks_title: "📋 <b>Vazifalar: {n} ta kanal</b>\n\n1. Havoladan kanalga kiring\n2. Obuna bo‘ling\n3. “✅ Obuna bo‘ldim” tugmasini bosing — bot tekshiradi\n\nHar bir kanal qatorida: 🔗 havola va <b>⚠️ Shikoyat</b>.\n\nHar bir obuna uchun: <b>+{reward} kredit</b>\n\n",
    tasks_btn_done: "✅ Obuna bo‘ldim",
    tasks_btn_refresh: "🔄 Yangilash",
    tasks_btn_next: "➡️ Keyingi 10 ta",
    ch_title: "📢 <b>Kanallaringiz: {n} ta</b>\n\n{list}\n\n{balance}",
    ch_none: "Hali kanal ulanmagan. Ulash uchun:\n1. Botni kanalingizga <b>administrator</b> qiling\n2. “➕ Kanal qo‘shish” tugmasini bosing\n3. Kanal manzilini yuboring (masalan: @kanal_nomi)",
    ch_add: "➕ Kanal qo‘shish",
    ch_code_in: "🔑 Kod kiritish",
    ch_back: "⬅️ Orqaga",
    ch_buy: "🛒 Buyurtma berish",
    ch_buy_all: "⚡ Kreditimga buyurtma",
    ord_all_low: "⚡ Bitta tugma bilan buyurtma uchun kamida 10 kredit kerak. Hozir: {max}.",
    ch_unlink: "🗑 Kanalni uzish",
    ch_controller: "nazoratchi",
    ord_title: "🛒 <b>Buyurtmalaringiz: {n} ta</b>\n{balance}\n\n{list}",
    ord_none: "Hali buyurtma bermagansiz.\n\n“📢 Kanallarim” → kanalingizni tanlang → nechta obunachi kerakligini yozing.",
    ord_qty: "🛒 <b>{title}</b>\n\nNechta obunachi kerakligini yozing (10–10000).\n• Narx: {unit} kredit / 1 ta\n• {balance}\n• Shu kredit bilan ko‘pi bilan: {max} ta\n\nBekor qilish: /cancel",
    ord_summary: "📝 <b>Buyurtma xulosasi</b>\n\n• {title}\n• Miqdor: <b>{qty}</b> ta\n• Narx: {unit} × {qty} = <b>{total}</b> kredit\n• Buyurtmadan keyingi balans: {left} kredit\n\nTasdiqlasangiz kredit band qilinadi.",
    ord_yes: "✅ Tasdiqlash",
    ord_no: "❌ Bekor qilish",
    ord_created: "🛒 <b>Buyurtma qabul qilindi!</b>\n\n• {title}\n• Miqdor: {qty}\n• Narx: {total} kredit (band qilindi)\n\nObunachilar navbat bilan qo‘shiladi.",
    save_err: "⚠️ Ma’lumotni saqlashda xatolik yuz berdi. Amal bajarilmadi — birozdan so‘ng qayta urinib ko‘ring.",
    ord_token_missing: "⚠️ Buyurtma ma’lumoti eskirgan yoki tasdiqlash kaliti yo‘q. Qaytadan boshlang: Kanallarim → kanal → miqdor.",
    ord_inflight: "⏳ Buyurtma yaratilmoqda. Takroriy bosish yangi buyurtma yaratmaydi — bir necha soniyadan so‘ng holatni tekshiring.",
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
    tasks_none: "📋 <b>Заданий пока нет</b>\n\nПричина: {reason}\n\n{balance}",
    tasks_reason_orders: "сейчас нет активных заказов — никто ещё не заказывал подписчиков. Попробуйте позже.",
    tasks_reason_done: "вы уже подписаны на все доступные каналы. Новые задания появятся здесь после новых заказов.",
    tasks_reason_own: "доступные заказы относятся к вашему каналу — на свой канал задание не выдаётся.",
    tasks_supply: "\nℹ️ Сейчас в системе {o} активных заказов, для вас доступно {b} каналов — все они в списке.",
    tasks_already: "\n\n♻️ Этот канал уже есть в вашем списке. Новые задания появятся после новых заказов.",
    auto_order_note: "\n\n🛒 <b>Автоматический заказ</b>\n{qty} ваших кредитов превращены в заказ подписчиков для “{title}”.",
    ch_order_hint: "\n\n💡 У вас {a} кредитов. Выберите канал и нажмите “🛒 Заказать” — количество вводите сами.",
    tasks_title: "📋 <b>Задания: {n} каналов</b>\n\n1. Откройте канал по ссылке\n2. Подпишитесь\n3. Нажмите “✅ Я подписался” — бот проверит\n\nВ строке каждого канала: 🔗 ссылка и <b>⚠️ Жалоба</b>.\n\nЗа каждую подписку: <b>+{reward} кредитов</b>\n\n",
    tasks_btn_done: "✅ Я подписался",
    tasks_btn_refresh: "🔄 Обновить",
    tasks_btn_next: "➡️ Следующие 10",
    ch_title: "📢 <b>Ваши каналы: {n}</b>\n\n{list}\n\n{balance}",
    ch_none: "Канал ещё не добавлен:\n1. Сделайте бота <b>администратором</b> канала\n2. Нажмите “➕ Добавить канал”\n3. Отправьте адрес (например: @kanal_nomi)",
    ch_add: "➕ Добавить канал",
    ch_code_in: "🔑 Ввести код",
    ch_back: "⬅️ Назад",
    ch_buy: "🛒 Заказать",
    ch_buy_all: "⚡ На все кредиты",
    ord_all_low: "⚡ Для заказа одной кнопкой нужно минимум 10 кредитов. Сейчас: {max}.",
    ch_unlink: "🗑 Отключить канал",
    ch_controller: "контроллер",
    ord_title: "🛒 <b>Ваши заказы: {n}</b>\n{balance}\n\n{list}",
    ord_none: "Заказов пока нет.\n\n“📢 Мои каналы” → выберите канал → укажите количество.",
    ord_qty: "🛒 <b>{title}</b>\n\nСколько подписчиков нужно? (10–10000)\n• Цена: {unit} кредитов за 1\n• {balance}\n• Максимум на баланс: {max}\n\nОтмена: /cancel",
    ord_summary: "📝 <b>Проверьте заказ</b>\n\n• {title}\n• Количество: <b>{qty}</b>\n• Цена: {unit} × {qty} = <b>{total}</b> кредитов\n• Баланс после заказа: {left}\n\nПосле подтверждения кредиты будут зарезервированы.",
    ord_yes: "✅ Подтвердить",
    ord_no: "❌ Отмена",
    ord_created: "🛒 <b>Заказ принят!</b>\n\n• {title}\n• Количество: {qty}\n• Цена: {total} кредитов (резерв)\n\nПодписчики добавляются по очереди.",
    save_err: "⚠️ Не удалось сохранить данные. Действие не выполнено — попробуйте ещё раз.",
    ord_token_missing: "⚠️ Данные заказа устарели или отсутствует ключ подтверждения. Начните заново: Мои каналы → канал → количество.",
    ord_inflight: "⏳ Заказ создаётся. Повторное нажатие не создаст новый заказ — проверьте статус через несколько секунд.",
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
    tasks_none: "📋 <b>No tasks yet</b>\n\nReason: {reason}\n\n{balance}",
    tasks_reason_orders: "there are no active orders right now — nobody has ordered subscribers yet. Try again later.",
    tasks_reason_done: "you are already subscribed to every available channel. New tasks will appear here as soon as new orders arrive.",
    tasks_reason_own: "the available orders belong to your own channel — your channel never appears as a task for you.",
    tasks_supply: "\nℹ️ There are {o} active orders in the system and {b} channels available for you — all of them are listed.",
    tasks_already: "\n\n♻️ You already have this channel. New tasks will appear after new orders.",
    auto_order_note: "\n\n🛒 <b>Automatic order</b>\n{qty} of your credits were turned into a subscriber order for “{title}”.",
    ch_order_hint: "\n\n💡 You have {a} credits. Pick a channel and press “🛒 Order” — you enter the quantity yourself.",
    tasks_title: "📋 <b>Tasks: {n} channels</b>\n\n1. Open the channel link\n2. Subscribe\n3. Press “✅ I subscribed” — the bot verifies\n\nEach channel row has 🔗 link and <b>⚠️ Complaint</b>.\n\nPer subscription: <b>+{reward} credits</b>\n\n",
    tasks_btn_done: "✅ I subscribed",
    tasks_btn_refresh: "🔄 Refresh",
    tasks_btn_next: "➡️ Next 10",
    ch_title: "📢 <b>Your channels: {n}</b>\n\n{list}\n\n{balance}",
    ch_none: "No channel yet:\n1. Make the bot an <b>administrator</b>\n2. Press “➕ Add channel”\n3. Send the address (e.g. @my_channel)",
    ch_add: "➕ Add channel",
    ch_code_in: "🔑 Enter code",
    ch_back: "⬅️ Back",
    ch_buy: "🛒 Place order",
    ch_buy_all: "⚡ Use all credits",
    ord_all_low: "⚡ A one-tap order needs at least 10 credits. You have: {max}.",
    ch_unlink: "🗑 Disconnect channel",
    ch_controller: "controller",
    ord_title: "🛒 <b>Your orders: {n}</b>\n{balance}\n\n{list}",
    ord_none: "No orders yet.\n\n“📢 My channels” → pick a channel → enter quantity.",
    ord_qty: "🛒 <b>{title}</b>\n\nHow many subscribers? (10–10000)\n• Price: {unit} credits each\n• {balance}\n• Maximum with this balance: {max}\n\nCancel: /cancel",
    ord_summary: "📝 <b>Order summary</b>\n\n• {title}\n• Quantity: <b>{qty}</b>\n• Price: {unit} × {qty} = <b>{total}</b> credits\n• Balance after order: {left}\n\nCredits are reserved after confirmation.",
    ord_yes: "✅ Confirm",
    ord_no: "❌ Cancel",
    ord_created: "🛒 <b>Order accepted!</b>\n\n• {title}\n• Quantity: {qty}\n• Price: {total} credits (reserved)\n\nSubscribers are added in queue order.",
    save_err: "⚠️ Could not save the data. The action was not applied — please try again shortly.",
    ord_token_missing: "⚠️ Order details are stale or the confirmation key is missing. Start again: My channels → channel → quantity.",
    ord_inflight: "⏳ The order is being created. Repeating the tap will not create another order — check the status in a few seconds.",
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
  "start_ask_channel": "📢 <b>Kanalingizni botga ulang</b>\n\nO‘z kanalingizga obunachi buyurtma qilish uchun kanalni botga ulashingiz kerak:\n\n1. Kanalingizga botni <b>administrator</b> qiling\n2. «{btn}» tugmasini bosing\n3. Kanal manzilini yuboring: <code>@mening_kanalim</code>{bonus}\n\nBekor qilish: /cancel",
  "choose_lang": "🌐 <b>Tilni tanlang</b>\n\nKeyingi qadamlar tanlangan tilda ko‘rsatiladi.",
  "ch_added": "📢 <b>Kanal ulandi!</b>\n\n• {title} (@{username})\n• Bot admin huquqi: tasdiqlangan ✅",
  "ch_added_bonus": "\n\n🎁 Kanal ulaganingiz uchun <b>+{bonus} kredit</b> sovg‘a!\n💰 Balans: {bal} kredit",
  "verify_none": "Tekshiradigan vazifangiz yo‘q.\n\nAvval “📋 Vazifalar” tugmasini bosing.",
  "verify_ok": "✅ <b>Tekshirildi!</b>\n\n• Tasdiqlandi: <b>{ok} ta</b>\n• Mukofot: <b>+{reward} kredit</b>\n• Hozirgi balans: <b>{bal} kredit</b>",
  "choose_menu": "Kerakli amalni pastdagi menyudan tanlang.",
  "cancelled": "Bekor qilindi.",
  "lang_saved": "✅ Til o‘zgartirildi.",
  "ord_fifo_short": "🛒 <b>Buyurtma qabul qilindi!</b>\n\n• {title}\n• Miqdor: {qty}\n• Narx: {total} kredit (band qilindi)",
  "ch_err_address": "❌ Manzil noto‘g‘ri. Kanalingiz manzilini yuboring, masalan: <code>@mening_kanalim</code>\n\nBekor qilish: /cancel",
  "ch_err_channel": "❌ <b>Kanalni ochib bo‘lmadi.</b>\n\nSabab: Telegram bu manzilni topmadi yoki kanal o‘chirilgan/yopiq.\n\n• Kanal <b>ommaviy (public)</b> bo‘lishi shart\n• Manzil @ bilan yozilsin: <code>@mening_kanalim</code>\n\nBoshqa manzil yuboring yoki /cancel bosing.",
  "ch_err_noadmin": "❌ <b>Bot bu kanalda administrator emas.</b>\n\nBu xato faqat Telegram botni kanal a’zosi sifatida ko‘rmaganda chiqadi.\n\nKanal sozlamalari → <b>Administratorlar</b> → botni qo‘shing (obunachilarni ko‘rish huquqi bilan) → manzilni qayta yuboring.",
  "ch_err_rights": "🔒 <b>Bot administrator, lekin huquqi yetarli emas.</b>\n\nTelegram botga kanal a’zolarini o‘qishga ruxsat bermadi.\n\nKanal sozlamalari → Administratorlar → bot → <b>“Obunachilarni ko‘rish”</b> va <b>“Foydalanuvchilarni taklif qilish”</b> huquqlarini yoqing, so‘ng manzilni qayta yuboring.",
  "ch_err_user": "❌ <b>Sizda bu kanalni boshqarish huquqi yo‘q.</b>\n\nFaqat o‘zingiz egasi yoki administratori bo‘lgan kanalni ulash mumkin.\n\nBoshqa odamning kanali bo‘lsa — egasidan bir martalik nazoratchi kodini so‘rang va “🔑 Kod kiritish” dan foydalaning.",
  "ch_err_api": "⚠️ <b>Telegram hozir javob bermadi.</b>\n\nBu vaqtinchalik texnik xato (tarmoq yoki Telegram serveri). Sizda ayb yo‘q va bot admin emas degan xulosa chiqarilmaydi.\n\nBir necha daqiqadan so‘ng manzilni qayta yuboring.",
  "ch_rights_warn": "\n\n⚠️ Bot administrator, lekin “foydalanuvchilarni taklif qilish” huquqi o‘chirilgan. A’zolikni tekshirish ishlaydi; kanal sozlamalarida bu huquqni yoqib qo‘yish tavsiya etiladi.",
  "ch_bots_missing": "\n\nℹ️ <b>Bu kanalda administrator bo‘lmagan botlar:</b> {bots}.\n\nKanal ishlayapti — <b>kamida bitta</b> bot administrator bo‘lishi yetarli. Bu botlar orqali tekshiruv bajarilmaydi; qo‘shimcha ishonchlilik uchun ularni ham kanalga administrator qilishingiz mumkin.",
  "ch_lost_warn": "⛔ <b>Diqqat:</b> bot bu kanalda administrator emas. Yangi vazifa berilmaydi va buyurtma qabul qilinmaydi. Kanal sozlamalari → Administratorlar → botni qo‘shing, so‘ng kanalni qayta ulang.",
  "ch_err_order": "⛔ <b>Buyurtma yaratilmadi.</b>\n\nSabab: <b>{title}</b> kanalida bot huquqi tasdiqlanmadi. Kredit band qilinmadi.",
  "ch_admin_lost_msg": "⚠️ <b>{title}</b> kanalida botning administrator huquqi yo‘qolgan.\n\nShu sababli kanalga <b>yangi vazifa berilmaydi</b> va faol buyurtmalar to‘xtatildi. Kredit va tarix saqlanadi.\n\nTuzatish: kanal sozlamalari → Administratorlar → botni qo‘shib, “Kanallarim” → kanal → qayta ulang.",
  "ch_admin_restored_msg": "✅ <b>{title}</b> kanalida bot huquqi tiklandi. Kanal yana vazifa qabul qiladi.",
  "verify_perm_err": "\n\n⛔ {n} ta kanalni tekshirib bo‘lmadi: bot ularda administrator emas yoki kanal o‘chirilgan. Bu obunadan chiqish deb hisoblanmaydi — kanal egalariga xabar yuborildi.",
  "verify_temp_err": "\n\n⚠️ {n} ta kanalda Telegram vaqtincha javob bermadi (texnik xato). Sizda ayb yo‘q — keyinroq o‘zi qayta tekshiriladi.",
  "set_notif_btn": "🔔 Bildirishnomalar",
  "set_security_btn": "🛡 Hisob xavfsizligi",
  "set_accounts_btn": "📱 Telegram hisoblari",
  "set_main_btn": "🏠 Asosiy menyu",
  "set_main_msg": "🏠 Asosiy menyu.",
  "set_notif_title": "🔔 <b>Bildirishnomalar</b>\n\nHar bir turkumni alohida yoqish/o‘chirish mumkin — darhol saqlanadi.\n\n• Yangi tasdiqlangan obunachilar: {sub}\n• Referal bonuslari: {ref}\n• Buyurtma holati: {ord}\n• Texnik xabarlar: {tech}\n• Soatlik hisobot: {hourly}\n\n🛡 Xavfsizlik bildirishnomalari alohida — ularni o‘chirib bo‘lmaydi.",
  "nt_sub": "👥 Yangi obunachilar",
  "nt_ref": "🎁 Referal bonuslari",
  "nt_ord": "🛒 Buyurtma holati",
  "nt_tech": "🛠 Texnik xabarlar",
  "set_sec_title": "🛡 <b>Hisob xavfsizligi</b>\n\n👤 Hisob: <code>{id}</code>\n📌 Holat: {status}\n🕒 Oxirgi faollik: {last}\n\n🔐 <b>Kirish</b>\nBot faqat Telegram orqali ishlaydi — alohida parol yo‘q. Hisobingizga faqat shu Telegram akkaunti kiradi; boshqa qurilmadan kirish uchun Telegram hisobingiz himoyasi (2FA) ishlatiladi.\n\n🔔 <b>Xavfsizlik bildirishnomalari:</b> doim yoniq (o‘chirilmaydi) — shubhali harakat, blok va huquq o‘zgarishlari shu chatga keladi.\n\nTizimda saqlanadigan sessiya: faqat shu bot chati (veb-panel sessiyalari bot hisobiga ta’sir qilmaydi).",
  "sec_report_btn": "🚨 Shubhali kirish haqida xabar",
  "sec_report_prompt": "🚨 <b>Xavfsizlik haqida xabar</b>\n\nNima sodir bo‘lganini bitta xabar bilan yozing (masalan: men obuna bo‘lmagan kanalga vazifa berilgan). Xabar adminga darhol boradi.\n\nBekor qilish: /cancel",
  "sec_ok": "✅ Xabaringiz yuborildi. Admin tekshiradi.",
  "st_active": "faol",
  "st_blocked": "bloklangan",
  "set_acc_title": "📱 <b>Telegram hisoblari</b>\n\n👤 <b>Shaxsiy akkaunt</b> (botga kiradigan hisob)\n• ID: <code>{id}</code>\n• Username: {username}\n• Ism: {name}\n• Til: {lang}\n\n📢 <b>Sizga bog‘langan kanallar: {n} ta</b>\n{list}\n\nℹ️ Shaxsiy akkaunt va kanal — alohida narsalar: akkaunt botga kiradi, kanal esa obunachi yig‘adigan manzil. Bitta akkaunt bir nechta kanalni boshqarishi mumkin.",
  "acc_ch_line": "• <b>{title}</b> (@{username}) — {role} · bot: {bot}",
  "acc_role_owner": "egasi",
  "acc_role_ctl": "nazoratchi",
  "acc_bot_ok": "admin ✅",
  "acc_bot_no": "admin emas ⛔",
  "acc_none": "— hali kanal ulanmagan"
});
Object.assign(STR.ru, {
  "paused": "⏸ Задания временно приостановлены. Попробуйте позже.",
  "ig_off": "📸 Раздел Instagram пока отключён.",
  "ig_note": "⚠️ В Instagram подтверждение основано на вашем слове — проверяет администратор.",
  "ch_detail": "📢 <b>{title}</b>\n@{username}\n🆔 <code>{cid}</code>\n\nЗаказано: {req}\n✅ Подтверждено: {ver}\n👥 Активные: {act}\n➖ Отписались: {unsub}\n⏳ В ожидании: {pend}\n\n🔑 Контроллеры: {ctl}\n⚠️ Обращения: {cmp}\n\n🛒 <b>История заказов:</b>\n{hist}\n\n{balance}",
  "ch_add_steps": "📢 <b>Добавление канала — 3 шага</b>\n\n1. Сделайте бота <b>администратором</b>\n2. Отправьте адрес канала, например: <code>@moy_kanal</code>\n3. Бот проверит и добавит\n\nОтмена: /cancel",
  "start_ask_channel": "📢 <b>Подключите свой канал к боту</b>\n\nЧтобы заказывать подписчиков на свой канал, подключите его к боту:\n\n1. Сделайте бота <b>администратором</b> канала\n2. Нажмите «{btn}»\n3. Отправьте адрес канала: <code>@moy_kanal</code>{bonus}\n\nОтмена: /cancel",
  "choose_lang": "🌐 <b>Выберите язык</b>\n\nДальнейшие шаги будут показаны на выбранном языке.",
  "ch_added": "📢 <b>Канал добавлен!</b>\n\n• {title} (@{username})\n• Права администратора: подтверждены ✅",
  "ch_added_bonus": "\n\n🎁 За добавление канала <b>+{bonus} кредитов</b>!\n💰 Баланс: {bal}",
  "verify_none": "Нет заданий для проверки.\n\nСначала нажмите “📋 Задания”.",
  "verify_ok": "✅ <b>Проверено!</b>\n\n• Подтверждено: <b>{ok}</b>\n• Награда: <b>+{reward} кредитов</b>\n• Баланс: <b>{bal}</b>",
  "choose_menu": "Выберите действие в меню ниже.",
  "cancelled": "Отменено.",
  "lang_saved": "✅ Язык изменён.",
  "ord_fifo_short": "🛒 <b>Заказ принят!</b>\n\n• {title}\n• Количество: {qty}\n• Цена: {total} кредитов (резерв)",
  "ch_err_address": "❌ Неверный адрес. Отправьте адрес канала, например: <code>@moy_kanal</code>\n\nОтмена: /cancel",
  "ch_err_channel": "❌ <b>Канал не удалось открыть.</b>\n\nПричина: Telegram не нашёл адрес, либо канал удалён/закрыт.\n\n• Канал должен быть <b>публичным</b>\n• Адрес с @: <code>@moy_kanal</code>\n\nОтправьте другой адрес или /cancel.",
  "ch_err_noadmin": "❌ <b>Бот не администратор этого канала.</b>\n\nЭта ошибка возникает только когда Telegram не видит бота в канале.\n\nНастройки канала → <b>Администраторы</b> → добавьте бота (с правом просмотра участников) → отправьте адрес снова.",
  "ch_err_rights": "🔒 <b>Бот администратор, но прав недостаточно.</b>\n\nTelegram не разрешил боту читать участников канала.\n\nНастройки канала → Администраторы → бот → включите <b>«Просмотр участников»</b> и <b>«Приглашение пользователей»</b>, затем отправьте адрес снова.",
  "ch_err_user": "❌ <b>У вас нет прав на управление этим каналом.</b>\n\nДобавить можно только канал, где вы владелец или администратор.\n\nЕсли канал чужой — попросите одноразовый код контроллера и используйте «🔑 Ввести код».",
  "ch_err_api": "⚠️ <b>Telegram сейчас не ответил.</b>\n\nЭто временная техническая ошибка (сеть или сервер Telegram). Вашей вины нет, и вывод «бот не администратор» НЕ делается.\n\nОтправьте адрес снова через несколько минут.",
  "ch_rights_warn": "\n\n⚠️ Бот администратор, но право «приглашать пользователей» отключено. Проверка подписки работает; рекомендуем включить это право.",
  "ch_bots_missing": "\n\nℹ️ <b>Боты, не являющиеся администраторами этого канала:</b> {bots}.\n\nКанал работает — достаточно, чтобы <b>хотя бы один</b> бот был администратором. Проверка через этих ботов не выполняется; для надёжности можно добавить и их.",
  "ch_lost_warn": "⛔ <b>Внимание:</b> бот не администратор этого канала. Новые задания не выдаются, заказы не принимаются. Настройки канала → Администраторы → добавьте бота, затем подключите канал заново.",
  "ch_err_order": "⛔ <b>Заказ не создан.</b>\n\nПричина: права бота в канале <b>{title}</b> не подтверждены. Кредиты не зарезервированы.",
  "ch_admin_lost_msg": "⚠️ В канале <b>{title}</b> бот потерял права администратора.\n\nПоэтому новые задания в канал <b>не выдаются</b>, активные заказы приостановлены. Кредиты и история сохранены.\n\nИсправление: Настройки канала → Администраторы → добавьте бота, затем «Мои каналы» → канал → подключите снова.",
  "ch_admin_restored_msg": "✅ Права бота в канале <b>{title}</b> восстановлены. Канал снова принимает задания.",
  "verify_perm_err": "\n\n⛔ {n} канал(ов) проверить не удалось: бот там не администратор или канал удалён. Это не считается отпиской — владельцам каналов отправлено уведомление.",
  "verify_temp_err": "\n\n⚠️ По {n} каналам Telegram временно не ответил. Вашей вины нет — проверка повторится автоматически.",
  "set_notif_btn": "🔔 Уведомления",
  "set_security_btn": "🛡 Безопасность",
  "set_accounts_btn": "📱 Telegram-аккаунты",
  "set_main_btn": "🏠 Главное меню",
  "set_main_msg": "🏠 Главное меню.",
  "set_notif_title": "🔔 <b>Уведомления</b>\n\nКаждый тип можно включить/отключить отдельно — сохраняется сразу.\n\n• Новые подтверждённые подписчики: {sub}\n• Реферальные бонусы: {ref}\n• Статус заказов: {ord}\n• Технические сообщения: {tech}\n• Ежечасный отчёт: {hourly}\n\n🛡 Уведомления безопасности — отдельно, их нельзя отключить.",
  "nt_sub": "👥 Новые подписчики",
  "nt_ref": "🎁 Реферальные бонусы",
  "nt_ord": "🛒 Статус заказов",
  "nt_tech": "🛠 Технические",
  "set_sec_title": "🛡 <b>Безопасность аккаунта</b>\n\n👤 Аккаунт: <code>{id}</code>\n📌 Статус: {status}\n🕒 Последняя активность: {last}\n\n🔐 <b>Вход</b>\nБот работает только через Telegram — отдельного пароля нет. В аккаунт входит только этот Telegram-аккаунт; для защиты используйте 2FA Telegram.\n\n🔔 <b>Уведомления безопасности:</b> всегда включены — подозрительная активность, блокировки и изменения прав приходят в этот чат.\n\nСессия в системе: только этот чат с ботом (сессии веб-панели не влияют на аккаунт бота).",
  "sec_report_btn": "🚨 Сообщить о подозрительном входе",
  "sec_report_prompt": "🚨 <b>Сообщение о безопасности</b>\n\nОпишите ситуацию одним сообщением (например: задание выдано на канал, на который я не подписывался). Сообщение сразу уйдёт администратору.\n\nОтмена: /cancel",
  "sec_ok": "✅ Сообщение отправлено. Администратор проверит.",
  "st_active": "активен",
  "st_blocked": "заблокирован",
  "set_acc_title": "📱 <b>Telegram-аккаунты</b>\n\n👤 <b>Личный аккаунт</b> (тот, что пишет боту)\n• ID: <code>{id}</code>\n• Username: {username}\n• Имя: {name}\n• Язык: {lang}\n\n📢 <b>Связанные каналы: {n}</b>\n{list}\n\nℹ️ Личный аккаунт и канал — разные вещи: аккаунт входит в бота, канал собирает подписчиков. Один аккаунт может управлять несколькими каналами.",
  "acc_ch_line": "• <b>{title}</b> (@{username}) — {role} · бот: {bot}",
  "acc_role_owner": "владелец",
  "acc_role_ctl": "контроллер",
  "acc_bot_ok": "админ ✅",
  "acc_bot_no": "не админ ⛔",
  "acc_none": "— канал пока не подключён"
});
Object.assign(STR.en, {
  "paused": "⏸ Tasks are temporarily paused. Try later.",
  "ig_off": "📸 The Instagram module is currently off.",
  "ig_note": "⚠️ Instagram confirmation is based on your word — reviewed by an admin.",
  "ch_detail": "📢 <b>{title}</b>\n@{username}\n🆔 <code>{cid}</code>\n\nRequested: {req}\n✅ Verified: {ver}\n👥 Active: {act}\n➖ Unsubscribed: {unsub}\n⏳ Pending: {pend}\n\n🔑 Controllers: {ctl}\n⚠️ Complaints: {cmp}\n\n🛒 <b>Order history:</b>\n{hist}\n\n{balance}",
  "ch_add_steps": "📢 <b>Add a channel — 3 steps</b>\n\n1. Make the bot an <b>administrator</b>\n2. Send the channel address, e.g. <code>@my_channel</code>\n3. The bot verifies and adds it\n\nCancel: /cancel",
  "start_ask_channel": "📢 <b>Connect your channel to the bot</b>\n\nTo order subscribers for your channel, link it to the bot:\n\n1. Make the bot an <b>administrator</b> of your channel\n2. Press “{btn}”\n3. Send the channel address: <code>@my_channel</code>{bonus}\n\nCancel: /cancel",
  "choose_lang": "🌐 <b>Choose a language</b>\n\nNext steps will be shown in the selected language.",
  "ch_added": "📢 <b>Channel added!</b>\n\n• {title} (@{username})\n• Admin rights: verified ✅",
  "ch_added_bonus": "\n\n🎁 <b>+{bonus} credits</b> for linking your channel!\n💰 Balance: {bal}",
  "verify_none": "No tasks to check.\n\nPress “📋 Tasks” first.",
  "verify_ok": "✅ <b>Checked!</b>\n\n• Verified: <b>{ok}</b>\n• Reward: <b>+{reward} credits</b>\n• Balance: <b>{bal}</b>",
  "choose_menu": "Choose an action from the menu below.",
  "cancelled": "Cancelled.",
  "lang_saved": "✅ Language changed.",
  "ch_err_address": "❌ Invalid address. Send your channel address, e.g. <code>@my_channel</code>\n\nCancel: /cancel",
  "ch_err_channel": "❌ <b>Could not open the channel.</b>\n\nReason: Telegram did not find the address, or the channel is deleted/private.\n\n• The channel must be <b>public</b>\n• The address must start with @: <code>@my_channel</code>\n\nSend another address or /cancel.",
  "ch_err_noadmin": "❌ <b>The bot is not an administrator of this channel.</b>\n\nThis error appears only when Telegram does not see the bot in the channel.\n\nChannel settings → <b>Administrators</b> → add the bot (with permission to view members) → send the address again.",
  "ch_err_rights": "🔒 <b>The bot is an administrator, but its permissions are insufficient.</b>\n\nTelegram did not allow the bot to read channel members.\n\nChannel settings → Administrators → bot → enable <b>“View members”</b> and <b>“Invite users”</b>, then send the address again.",
  "ch_err_user": "❌ <b>You do not have management rights for this channel.</b>\n\nYou can add only a channel where you are the owner or an administrator.\n\nFor someone else's channel — ask the owner for a one-time controller code and use “🔑 Enter code”.",
  "ch_err_api": "⚠️ <b>Telegram did not respond right now.</b>\n\nThis is a temporary technical error (network or Telegram server). It is not your fault, and it is NOT treated as “the bot is not an administrator”.\n\nSend the address again in a few minutes.",
  "ch_rights_warn": "\n\n⚠️ The bot is an administrator, but “invite users” is disabled. Membership checks work; enabling that right is recommended.",
  "ch_bots_missing": "\n\nℹ️ <b>Bots that are not administrators of this channel:</b> {bots}.\n\nThe channel works — <b>at least one</b> bot with administrator rights is enough. Checks are not performed through these bots; you can add them for extra reliability.",
  "ch_lost_warn": "⛔ <b>Attention:</b> the bot is not an administrator of this channel. New tasks are not issued and orders are not accepted. Channel settings → Administrators → add the bot, then link the channel again.",
  "ch_err_order": "⛔ <b>Order was not created.</b>\n\nReason: the bot's rights in <b>{title}</b> could not be confirmed. No credits were reserved.",
  "ch_admin_lost_msg": "⚠️ The bot lost administrator rights in <b>{title}</b>.\n\nNew tasks for this channel are <b>not issued</b> and active orders are paused. Credits and history are preserved.\n\nFix: Channel settings → Administrators → add the bot, then “My channels” → channel → link again.",
  "ch_admin_restored_msg": "✅ Bot rights in <b>{title}</b> are restored. The channel accepts tasks again.",
  "verify_perm_err": "\n\n⛔ {n} channel(s) could not be checked: the bot is not an administrator there or the channel was deleted. This is not counted as an unsubscribe — channel owners were notified.",
  "verify_temp_err": "\n\n⚠️ Telegram temporarily failed for {n} channel(s). Not your fault — the check will repeat automatically.",
  "set_notif_btn": "🔔 Notifications",
  "set_security_btn": "🛡 Account security",
  "set_accounts_btn": "📱 Telegram accounts",
  "set_main_btn": "🏠 Main menu",
  "set_main_msg": "🏠 Main menu.",
  "set_notif_title": "🔔 <b>Notifications</b>\n\nEach type can be toggled separately — saved instantly.\n\n• New verified subscribers: {sub}\n• Referral bonuses: {ref}\n• Order status: {ord}\n• Technical messages: {tech}\n• Hourly report: {hourly}\n\n🛡 Security notifications are separate and cannot be turned off.",
  "nt_sub": "👥 New subscribers",
  "nt_ref": "🎁 Referral bonuses",
  "nt_ord": "🛒 Order status",
  "nt_tech": "🛠 Technical",
  "set_sec_title": "🛡 <b>Account security</b>\n\n👤 Account: <code>{id}</code>\n📌 Status: {status}\n🕒 Last activity: {last}\n\n🔐 <b>Sign-in</b>\nThe bot works only through Telegram — there is no separate password. Only this Telegram account can enter it; use Telegram 2FA to protect it.\n\n🔔 <b>Security notifications:</b> always on — suspicious activity, blocks and rights changes arrive in this chat.\n\nSession stored by the system: only this bot chat (web panel sessions do not affect the bot account).",
  "sec_report_btn": "🚨 Report suspicious sign-in",
  "sec_report_prompt": "🚨 <b>Security report</b>\n\nDescribe what happened in one message (e.g. a task was placed on a channel I never subscribed to). It goes straight to the admin.\n\nCancel: /cancel",
  "sec_ok": "✅ Report sent. An admin will review it.",
  "st_active": "active",
  "st_blocked": "blocked",
  "set_acc_title": "📱 <b>Telegram accounts</b>\n\n👤 <b>Personal account</b> (the one using the bot)\n• ID: <code>{id}</code>\n• Username: {username}\n• Name: {name}\n• Language: {lang}\n\n📢 <b>Channels linked to you: {n}</b>\n{list}\n\nℹ️ A personal account and a channel are different: the account uses the bot, the channel collects subscribers. One account can manage several channels.",
  "acc_ch_line": "• <b>{title}</b> (@{username}) — {role} · bot: {bot}",
  "acc_role_owner": "owner",
  "acc_role_ctl": "controller",
  "acc_bot_ok": "admin ✅",
  "acc_bot_no": "not admin ⛔",
  "acc_none": "— no channel linked yet",
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
// Tekshiruv nosozligi xabarlari (spec §6). Foydalanuvchi "Telegram buzuq"
// degan umumiy matnni emas, ANIQ sababni ko'radi.
Object.assign(STR.uz, {
  verify_perm_err: "\n\n⛔ {n} ta kanalni tekshirib bo‘lmadi — sabab: {reason}. Bu obunadan chiqish deb hisoblanmaydi.",
  verify_retry_saved: "\n\n⚠️ {n} ta kanalni hozircha tekshirib bo‘lmadi — sabab: {reason}. Bu sizning aybingiz emas: qayta tekshiruv saqlandi, taxminan {mins} daqiqadan keyin avtomatik bajariladi.",
  verify_temp_err: "\n\n⚠️ {n} ta kanalni hozircha tekshirib bo‘lmadi — sabab: {reason}. Bu sizning aybingiz emas. Birozdan keyin “✅ Obuna bo‘ldim” tugmasini qayta bosing.",
  vr_no_rights: "bot bu kanalda administrator emas yoki kerakli huquqi yo‘q",
  vr_not_found: "kanal topilmadi yoki o‘chirilgan",
  vr_blocked: "bot kanaldan chiqarilgan yoki bloklangan",
  vr_bad_request: "kanal ID si noto‘g‘ri yoki kanal yopiq",
  vr_temp: "Telegram vaqtincha javob bermadi",
  vr_unknown: "Telegram noma’lum xato qaytardi"
});
Object.assign(STR.ru, {
  verify_perm_err: "\n\n⛔ Не удалось проверить каналов: {n} — причина: {reason}. Это не считается отпиской.",
  verify_retry_saved: "\n\n⚠️ Пока не удалось проверить каналов: {n} — причина: {reason}. Вашей вины нет: повторная проверка сохранена и выполнится автоматически примерно через {mins} мин.",
  verify_temp_err: "\n\n⚠️ Пока не удалось проверить каналов: {n} — причина: {reason}. Вашей вины нет. Через некоторое время нажмите «✅ Я подписался» ещё раз.",
  vr_no_rights: "бот не администратор канала или у него нет нужных прав",
  vr_not_found: "канал не найден или удалён",
  vr_blocked: "бот удалён из канала или заблокирован",
  vr_bad_request: "неверный ID канала или канал закрыт",
  vr_temp: "Telegram временно не ответил",
  vr_unknown: "Telegram вернул неизвестную ошибку"
});
Object.assign(STR.en, {
  verify_perm_err: "\n\n⛔ {n} channel(s) could not be checked — reason: {reason}. This is not counted as an unsubscribe.",
  verify_retry_saved: "\n\n⚠️ {n} channel(s) could not be checked yet — reason: {reason}. Not your fault: a retry has been queued and will run automatically in about {mins} min.",
  verify_temp_err: "\n\n⚠️ {n} channel(s) could not be checked yet — reason: {reason}. Not your fault. Press “✅ I subscribed” again a bit later.",
  vr_no_rights: "the bot is not an administrator of that channel or lacks the required rights",
  vr_not_found: "the channel was not found or was deleted",
  vr_blocked: "the bot was removed from the channel or blocked",
  vr_bad_request: "invalid channel ID or the channel is private",
  vr_temp: "Telegram temporarily did not respond",
  vr_unknown: "Telegram returned an unknown error"
});
function verifyReasonText(u, kind) {
  const map = {
    [TG_ERR.NO_RIGHTS]: "vr_no_rights",
    [TG_ERR.NOT_FOUND]: "vr_not_found",
    channel_missing: "vr_not_found",
    [TG_ERR.BLOCKED]: "vr_blocked",
    [TG_ERR.BAD_REQUEST]: "vr_bad_request",
    [TG_ERR.NETWORK]: "vr_temp",
    [TG_ERR.NETWORK_TIMEOUT]: "vr_temp",
    [TG_ERR.SERVER]: "vr_temp",
    [TG_ERR.RATE_LIMIT]: "vr_temp",
    [TG_ERR.AUTH]: "vr_temp",
    api: "vr_temp"
  };
  return T(u, map[kind] || "vr_unknown");
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
    db.users[key] = {
      id: `u-${from.id}`,
      telegramId: from.id,
      username: from.username,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id),
      language: ["uz", "ru", "en"].includes(String(from.language_code || "").slice(0, 2)) ? String(from.language_code).slice(0, 2) : "uz",
      credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
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
    // Sovg'a `getUser()` ichida emas, chaqiruvchi (async) joyda beriladi:
    // Postgres rejimida yozuvni kutish kerak, `getUser()` esa sinxron.
    if (Math.max(0, Number(S().creditRewardSignup) || 0) > 0) db.users[key].signupPending = true;
  }
  const u = db.users[key];
  u.chatId = chatId;
  if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
  u.botId = (curBot() || {}).id || u.botId || "";
  u.username = from.username;
  u.displayName = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || u.displayName;
  return { user: u, isNew };
}
// Har bir kredit harakati jurnalga yoziladi. `idempotencyKey` berilsa, shu
// kalit bilan yozuv mavjud bo'lsa hech narsa qo'shilmaydi — takroriy mukofot
// yoki takroriy qaytimning oldini oladi (spec §8).
function addTx(u, amount, type, description, extra = {}) {
  const key = extra.idempotencyKey || "";
  if (key && db.transactions.some((t) => t.idempotencyKey === key)) return false;
  db.transactions.push({
    id: nid("tx"),
    userId: u.id,
    userName: u.displayName,
    amount,
    type,
    description,
    balanceAfter: u.credits.available,
    createdAt: nowStr(),
    idempotencyKey: key,
    ...(CURRENT_OP ? { opId: CURRENT_OP } : {}),
    ...extra
  });
  // Jurnal chegarasi — `LOG_CAPS.transactions`. Undan oshgan eng eski yozuvlar
  // maintenance'da olib tashlanadi (JSONB snapshot cheksiz o'smasin).
  if (db.transactions.length === 2e4) console.warn("Tranzaksiyalar 20000 taga yetdi — eng eski yozuvlar chegaradan oshsa olib tashlanadi.");
  return true;
}
// Admin qo'lda tuzatishi (qo'shish/ayirish). Ilgari balans `Math.max(0, ...)`
// bilan klamplenardi va jurnalga to'liq summa yozilardi — natijada manfiy
// qoldiq holatida balans bilan jurnal farq qilardi. Endi:
//  - jurnal va balans birga, bitta sinxron blokda o'zgaradi;
//  - manfiy qoldiqqa olib keladigan tuzatish rad etiladi (jurnal buzilmaydi);
//  - `idempotencyKey` berilsa, takroriy so'rov (double-click, retry) ikkinchi
//    marta qo'llanmaydi.
function adminAdjust(t, n, reason, idempotencyKey) {
  if (!t || !Number.isFinite(n) || !n) return { ok: false, reason: "invalid" };
  const next = t.credits.available + n;
  if (next < 0) return { ok: false, reason: "insufficient", balance: t.credits.available };
  const key = String(idempotencyKey || "");
  if (key && db.transactions.some((x) => x.idempotencyKey === key)) {
    return { ok: false, reason: "duplicate", balance: t.credits.available };
  }
  const ok = addTx(t, n, "admin_adjustment", reason, { idempotencyKey: key, adminAdjust: true });
  if (!ok) return { ok: false, reason: "duplicate", balance: t.credits.available };
  t.credits.available = next;
  db.transactions[db.transactions.length - 1].balanceAfter = next;
  return { ok: true, balance: next };
}
// Admin tuzatishi + DARHOL saqlash. Saqlash yiqilsa tuzatish qaytariladi va
// natija `save_failed` bo'ladi — chaqiruvchi muvaffaqiyat xabarini yubormaydi.
async function applyAdminAdjust(t, n, reason, idempotencyKey) {
  // Instanslararo kritik bo'lim: qulf → eng so'nggi holat → mutatsiya → yozuv.
  // Ikki instans bir foydalanuvchiga parallel tuzatish yuborsa, ikkinchisi
  // birinchisining yozuvini yo'qotmaydi (qayta o'qilgan holat ustida ishlaydi).
  const res = await withStateTx(async () => {
    const endOp = opStart("adj");
    const snap = creditsSnapshot(t);
    const adj = adminAdjust(t, n, reason, idempotencyKey);
    endOp();
    if (!adj.ok) return adj;
    if (!(await flushOrRollback(() => creditsRestore(t, snap))))
      return { ok: false, reason: "save_failed", balance: t.credits.available };
    return adj;
  });
  if (!res.ok) return { ok: false, reason: "save_failed", balance: t.credits.available };
  return res.value;
}
// Ro'yxatdan o'tish sovg'asi (bir marta, jurnal yozuvi bilan, darhol saqlanadi).
// Qaytaradi: berilgan summa yoki `0` (o'chirilgan) / `-1` (saqlanmadi).
async function grantSignupBonus(u) {
  if (!u || !u.signupPending) return 0;
  const res = await withStateTx(async () => {
    // Qayta o'qilgan holatda boshqa instans sovg'ani allaqachon bergan bo'lishi
    // mumkin — bayroq yangilangan (`liveSync` havolani saqlaydi).
    if (!u.signupPending) return 0;
    u.signupPending = false;
    const bonus = Math.max(0, Number(S().creditRewardSignup) || 0);
    if (!(bonus > 0)) return 0;
    const endOp = opStart("signup");
    const snap = creditsSnapshot(u);
    if (!addTx(u, bonus, "signup_bonus", "Ro'yxatdan o'tish sovg'asi", { idempotencyKey: `signup:${u.id}` })) {
      endOp();
      return 0;
    }
    u.credits.available = (Number(u.credits.available) || 0) + bonus;
    u.credits.signupBonus = bonus;
    db.transactions[db.transactions.length - 1].balanceAfter = u.credits.available;
    endOp();
    if (!(await flushOrRollback(() => creditsRestore(u, snap)))) {
      // Saqlanmadi: sovg'a qaytarildi va BAYROQ qayta qo'yildi — foydalanuvchi
      // keyingi xabarida yana urinamiz (idempotency kaliti hali bo'sh).
      u.signupPending = true;
      console.error(`signup_bonus saqlanmadi (${u.id}) — sovg'a qaytarildi`);
      return -1;
    }
    return bonus;
  });
  if (!res.ok) {
    u.signupPending = true;
    console.error(`signup_bonus: holat tranzaksiyasi bajarilmadi (${u.id}, ${res.reason})`);
    return -1;
  }
  return res.value;
}
// Kanal ulash sovg'asi (bir marta). Qaytaradi: summa, `0` (berilmagan) yoki
// `-1` (saqlanmadi — sovg'a qaytarildi).
async function grantChannelLinkBonus(u, ch) {
  if (!u || u.channelBonusGiven) return 0;
  const res = await withStateTx(async () => {
    const linkBonus = u.channelBonusGiven ? 0 : Math.max(0, Number(S().creditRewardChannelLink) || 0);
    if (!(linkBonus > 0)) return 0;
    const endOp = opStart("chlink");
    const snap = creditsSnapshot(u);
    u.channelBonusGiven = true;
    u.credits.available = (Number(u.credits.available) || 0) + linkBonus;
    addTx(u, linkBonus, "channel_link_bonus", "Kanal ulandi: " + ch.title, { idempotencyKey: `chlink:${ch.id}` });
    db.transactions[db.transactions.length - 1].balanceAfter = u.credits.available;
    endOp();
    if (!(await flushOrRollback(() => {
      creditsRestore(u, snap);
      u.channelBonusGiven = false;
    }))) {
      console.error(`channel_link_bonus saqlanmadi (${u.id}) — sovg'a qaytarildi`);
      return -1;
    }
    return linkBonus;
  });
  if (!res.ok) {
    u.channelBonusGiven = false;
    console.error(`channel_link_bonus: holat tranzaksiyasi bajarilmadi (${u.id}, ${res.reason})`);
    return -1;
  }
  return res.value;
}
// Balansdagi kreditni foydalanuvchining o'z kanaliga avtomatik buyurtmaga
// aylantiradi (1 kredit = 1 obunachi). Shu tufayli kredit bo'sh turmaydi va
// navbatda boshqa foydalanuvchilar uchun vazifa paydo bo'ladi.
function autoOrderFromBalance(u) {
  if (!u || !S().autoOrderCredits || S().areOrdersFrozen || S().isBotPaused) return null;
  const chs = db.channels.filter((c) => c.ownerId === u.id);
  if (!chs.length) return null;
  const unit = Math.max(1, perSub());
  const qty = Math.floor((Number(u.credits.available) || 0) / unit);
  if (qty < 1) return null;
  const activeOf = (c) => db.orders.filter((o) => o.destinationId === c.id && o.status === "active").sort((a, b) => a.seq - b.seq)[0];
  const withOrder = chs.find((c) => activeOf(c));
  // Spec §6: buyurtmani foydalanuvchi o'zi yaratadi (miqdorni o'zi kiritadi).
  // Shuning uchun faqat MAVJUD faol buyurtmaga kredit qo'shamiz; buyurtma
  // bo'lmasa kredit yig'ilib turadi va bir tugma bilan buyurtmaga aylanadi.
  if (!withOrder) return null;
  const ch = withOrder;
  const cost = qty * unit;
  u.credits.available -= cost;
  u.credits.reserved += cost;
  let o = activeOf(ch);
  if (o) {
    o.requestedQuantity += qty;
    o.pendingQuantity += qty;
    o.totalCost = (o.totalCost || 0) + cost;
    // Bepul birliklardan iborat buyurtmaga pullik birlik qo'shilsa, birlik
    // narxi yozilishi shart — aks holda tasdiqlashda `reserved` hech qachon
    // kamaymaydi va kredit qaytarilmaydi.
    if (!(Number(o.unitCost) > 0)) o.unitCost = unit;
  } else {
    o = {
      id: nid("ord"),
      seq: ++db.seq,
      userId: u.id,
      userName: u.displayName,
      destinationId: ch.id,
      destinationTitle: ch.title,
      platform: "telegram",
      requestedQuantity: qty,
      verifiedQuantity: 0,
      pendingQuantity: qty,
      cancelledQuantity: 0,
      unitCost: unit,
      totalCost: cost,
      freeUnits: 0,
      status: "active",
      source: "auto_balance",
      createdAt: nowStr(),
      ...(CURRENT_OP ? { opId: CURRENT_OP } : {})
    };
    db.orders.push(o);
    u.activeOrdersCount = (u.activeOrdersCount || 0) + 1;
  }
  ch.totalRequested += qty;
  ch.pendingSubscriptions += qty;
  addTx(u, -cost, "order_spend", "Avtomatik buyurtma: " + ch.title + " x" + qty, { orderId: o.id, idempotencyKey: `reserve:${o.id}:${o.requestedQuantity}` });
  save();
  return { channel: ch, qty, cost, order: o };
}
// OPEN — hali yakunlanmagan barcha vazifalar (ichki tekshiruv uchun).
// FIFO — faqat navbatga qaytariladigan va foydalanuvchiga ko'rsatiladigan
// holatlar. CHECK_ERROR bu yerda YO'Q: vaqtinchalik xato olgan vazifa navbatga
// qaytmaydi, uni faqat TASK_CHECK jobi qayta tekshiradi (spec §2).
var OPEN = /* @__PURE__ */ new Set(["ACTIVE", "PENDING", "RECHECK", "CHECK_ERROR"]);
var FIFO = /* @__PURE__ */ new Set(["ACTIVE", "PENDING"]);
var destOf = (id) => db.channels.find((c) => c.id === id) || db.igProfiles.find((p) => p.id === id);
var orderAssigned = (o) => db.tasks.filter((t) => t.orderId === o.id && t.status !== "CANCELLED").length;
// Berilgan foydalanuvchiga nechta yangi vazifa biriktirish (FIFO: buyurtma seq bo'yicha).
function assignFresh(u, platform, need) {
  const added = [];
  const orders = db.orders.filter((o) => o.status === "active" && o.platform === platform && o.userId !== u.id).sort((a, b) => a.seq - b.seq);
  for (const o of orders) {
    if (added.length >= need) break;
    const dest = destOf(o.destinationId);
    if (!dest) continue;
    // Pauza qilingan, uzilgan yoki bot huquqini yo'qotgan kanalga yangi vazifa
    // berilmaydi (spec §1.9, §7).
    if (dest.disconnectedAt || (dest.status && dest.status !== "active")) continue;
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
    added.push(t);
  }
  if (added.length) save();
  return added;
}
function getBatch(u, platform) {
  const open = db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && FIFO.has(t.status)).sort((a, b) => a.queueSequence - b.queueSequence);
  if (open.length < 10) assignFresh(u, platform, 10 - open.length);
  return db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && FIFO.has(t.status)).sort((a, b) => a.queueSequence - b.queueSequence).slice(0, 10);
}
// Nima uchun navbatda shuncha kanal borligini tushuntirish uchun hisob-kitob.
function taskSupply(u, platform) {
  const active = db.orders.filter((o) => o.status === "active" && o.platform === platform);
  let mine = 0, own = 0, seen = 0;
  for (const o of active) {
    const dest = destOf(o.destinationId);
    if (!dest) continue;
    if (platform === "telegram" && (dest.ownerId === u.id || (dest.controllers || []).some((c) => c.userId === u.id))) {
      own++;
      continue;
    }
    if (db.tasks.some((t2) => t2.assignedTo === u.id && t2.destinationId === o.destinationId && (t2.status !== "CANCELLED" || t2.unsubscribed))) {
      seen++;
      continue;
    }
    mine++;
  }
  return { activeOrders: active.length, mine, own, seen };
}
// Foydalanuvchi oldingi 10 tani tugatmasa ham keyingi 10 tani ko'rishi mumkin (spec §7).
function getNextBatch(u, platform) {
  const before = new Set(db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform).map((t) => t.id));
  assignFresh(u, platform, 10);
  const fresh = db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && FIFO.has(t.status) && !before.has(t.id)).sort((a, b) => a.queueSequence - b.queueSequence);
  if (fresh.length) return fresh.slice(0, 10);
  // Yangi vazifa yo'q — mavjudlarini qaytaramiz va buni matnda aytamiz.
  return getBatch(u, platform).map((t) => ({ ...t, noMore: true }));
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
// ===== A'zolik registri (memberships) =====
// Har bir ma'lum (foydalanuvchi, kanal) juftligi uchun yagona yozuv. 24 soatlik
// qayta tekshiruv navbati shu yozuvga tayanadi.
var MEM_RECHECK_MS = 24 * 36e5;
var MEM_RECHECK_JITTER_MS = 3 * 36e5;
function memRecheckDelay() {
  // 24 soat + 0..3 soat jitter — barcha tekshiruvlar bir vaqtga to'planmaydi.
  return MEM_RECHECK_MS + Math.floor(Math.random() * MEM_RECHECK_JITTER_MS);
}
function ensureMembership(userId, channelId) {
  let m = db.memberships.find((x) => x.userId === userId && x.channelId === channelId);
  if (m) return m;
  const t = (/* @__PURE__ */ new Date()).toISOString();
  m = {
    id: nid("mem"),
    userId,
    channelId,
    status: "PENDING",
    firstSeenAt: t,
    firstVerifiedAt: "",
    lastCheckedAt: "",
    nextCheckAt: "",
    lastMembershipChangeAt: "",
    lastCheckResult: "",
    consecutiveCheckErrors: 0,
    createdAt: t,
    updatedAt: t,
    ...(CURRENT_OP ? { opId: CURRENT_OP } : {})
  };
  db.memberships.push(m);
  return m;
}
function membershipEvent(userId, channelId, eventType, oldStatus, newStatus, source, apiResult, taskId) {
  db.membershipEvents.push({
    id: nid("mev"),
    userId,
    channelId,
    eventType,
    oldStatus: oldStatus || "",
    newStatus: newStatus || "",
    source: source || "",
    eventTime: (/* @__PURE__ */ new Date()).toISOString(),
    apiResult: apiResult || "",
    relatedTaskId: taskId || "",
    ...(CURRENT_OP ? { opId: CURRENT_OP } : {})
  });
  if (db.membershipEvents.length > 5e4) db.membershipEvents.splice(0, 1e4);
}
// Rejalashtirilgan tekshiruvni baza navbatiga yozadi (in-memory timer emas).
function scheduleMembershipCheck(m, atMs, jobType = "RECHECK") {
  const at = new Date(atMs).toISOString();
  m.nextCheckAt = at;
  m.updatedAt = at;
  // Bu a'zolik uchun ochiq job bo'lsa — uni qayta rejalashtiramiz, yangisini
  // yaratmaymiz. Ilgari kalit soat oynasi bo'yicha edi va DONE bo'lgan eski
  // job ham kalitni band qilardi: yangi tekshiruv yaratilmasdan nextCheckAt
  // yangilanib, a'zolik jimgina kuzatuvdan chiqib ketardi.
  const open = db.verificationJobs.find(
    (j) => j.membershipId === m.id && j.jobType === jobType && (j.status === "PENDING" || j.status === "RUNNING")
  );
  if (open) {
    if (open.status === "PENDING") open.scheduledAt = at;
    return null;
  }
  const key = `verify:${jobType}:${m.userId}:${m.channelId}:${atMs}`;
  if (db.verificationJobs.some((j) => j.idempotencyKey === key)) return null;
  const job = {
    id: nid("job"),
    membershipId: m.id,
    userId: m.userId,
    channelId: m.channelId,
    jobType,
    scheduledAt: at,
    status: "PENDING",
    attemptCount: 0,
    lastError: "",
    lockedAt: "",
    completedAt: "",
    idempotencyKey: key,
    ...(CURRENT_OP ? { opId: CURRENT_OP } : {})
  };
  db.verificationJobs.push(job);
  return job;
}
// Vazifa tekshiruvini qayta urinish navbatiga yozadi (restart-safe).
// Ilgari `retryAt` faqat yozilardi, lekin uni HECH KIM o'qimasdi: xato olgan
// vazifa faqat foydalanuvchi tugmani yana bosganda tekshirilardi.
function scheduleTaskCheck(t, atMs) {
  const at = new Date(atMs).toISOString();
  const open = db.verificationJobs.find(
    (j) => j.jobType === "TASK_CHECK" && j.taskId === t.id && (j.status === "PENDING" || j.status === "RUNNING")
  );
  if (open) {
    if (open.status === "PENDING") open.scheduledAt = at;
    return open;
  }
  const key = `taskcheck:${t.id}:${Math.round(atMs / 1e4)}`;
  if (db.verificationJobs.some((j) => j.idempotencyKey === key)) return null;
  const job = {
    id: nid("job"),
    membershipId: "",
    taskId: t.id,
    userId: t.assignedTo,
    channelId: t.destinationId,
    jobType: "TASK_CHECK",
    scheduledAt: at,
    status: "PENDING",
    attemptCount: 0,
    lastError: "",
    lastErrorCode: 0,
    lockedAt: "",
    completedAt: "",
    idempotencyKey: key,
    ...(CURRENT_OP ? { opId: CURRENT_OP } : {})
  };
  db.verificationJobs.push(job);
  return job;
}
// Eski holatda qolib ketgan vazifalar uchun qayta urinish jobi (migratsiya).
function repairTaskChecks() {
  let n = 0;
  for (const t of db.tasks) {
    if (t.status !== "CHECK_ERROR" && t.status !== "RECHECK") continue;
    // RECHECK endi FIFO'da ko'rsatilmaydi — yagona yo'l TASK_CHECK jobi.
    t.status = "CHECK_ERROR";
    const open = db.verificationJobs.some(
      (j) => j.jobType === "TASK_CHECK" && j.taskId === t.id && (j.status === "PENDING" || j.status === "RUNNING")
    );
    if (open) continue;
    const delay = retryDelayMs(t.consecutiveCheckErrors || 1, 0);
    if (scheduleTaskCheck(t, Date.now() + delay)) n++;
  }
  return n;
}
function cancelTaskCheck(taskId) {
  let n = 0;
  for (const j of db.verificationJobs) {
    if (j.jobType === "TASK_CHECK" && j.taskId === taskId && j.status === "PENDING") {
      j.status = "CANCELLED";
      j.completedAt = new Date().toISOString();
      n++;
    }
  }
  return n;
}
function taskForPair(userId, channelId) {
  return db.tasks.filter((t) => t.assignedTo === userId && t.destinationId === channelId)
    .sort((a, b) => b.queueSequence - a.queueSequence)[0];
}
function markUnsubscribed(userId, channelId) {
  const t = taskForPair(userId, channelId);
  if (t && t.status === "VERIFIED") {
    t.status = "CANCELLED";
    t.unsubscribed = true;
    t.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    const o = db.orders.find((x) => x.id === t.orderId);
    if (o && o.status === "active") {
      o.verifiedQuantity = Math.max(0, o.verifiedQuantity - 1);
      o.pendingQuantity++;
    }
  }
  const dest = destOf(channelId);
  if (dest) {
    dest.verifiedSubscribers = Math.max(0, (dest.verifiedSubscribers || 0) - 1);
    dest.activeSubscribers = Math.max(0, (dest.activeSubscribers || 0) - 1);
    dest.unsubscribedCount = (dest.unsubscribedCount || 0) + 1;
  }
  return t;
}
// Qayta obuna bo'ldi — statistika tiklanadi, lekin YANGI kredit berilmaydi.
function markRejoined(userId, channelId) {
  const t = taskForPair(userId, channelId);
  if (t && t.unsubscribed) {
    t.status = "VERIFIED";
    t.unsubscribed = false;
    t.rejoined = true;
    t.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
    const o = db.orders.find((x) => x.id === t.orderId);
    if (o && o.status === "active") {
      o.verifiedQuantity++;
      o.pendingQuantity = Math.max(0, o.pendingQuantity - 1);
    }
    const dest = destOf(channelId);
    if (dest) {
      dest.verifiedSubscribers = (dest.verifiedSubscribers || 0) + 1;
      dest.activeSubscribers = (dest.activeSubscribers || 0) + 1;
    }
    return t;
  }
  return null;
}
// Bir vaqtda kelgan ikkinchi chaqiruvni to'sadigan to'plam (job + tugma).
var APPLYING_TASKS = /* @__PURE__ */ new Set();
// Vazifani tasdiqlash — ATOMAR va IDEMPOTENT (spec §1).
//  - `reward:<taskId>` — yagona himoya kaliti. Kalit jurnalda bo'lsa funksiya
//    hech qanday hisoblagichga tegmaydi; jurnal yozilmasa ham shunday.
//  - Butun tana sinxron (await yo'q): jurnal yozuvi, available, reserved,
//    spent, order.verifiedQuantity va task.status bir operatsiya sifatida
//    bajariladi — oraliq holat hech qachon ko'rinmaydi.
//  - Istisno bo'lsa barcha o'zgarishlar orqaga qaytariladi (yarimta natija yo'q).
//  - VERIFIED / SELF_CONFIRMED / CANCELLED vazifa hech qachon qayta yozilmaydi.
function applyVerified(u, t) {
  if (!u || !t) return 0;
  const key = `reward:${t.id}`;
  if (t.status === "VERIFIED" || t.status === "SELF_CONFIRMED" || t.status === "CANCELLED") return 0;
  if (APPLYING_TASKS.has(t.id)) return 0;
  if (db.transactions.some((x) => x.idempotencyKey === key)) return 0;
  const o = db.orders.find((x) => x.id === t.orderId);
  if (!o || o.status === "cancelled" || o.status === "completed") {
    t.status = "CANCELLED";
    return 0;
  }
  const self = t.platform === "instagram";
  // O'zi tasdiqlagan (Instagram) amal TASDIQLANGAN mukofot bermaydi (spec §2):
  // standart qiymat 0, alohida `selfReportedRewards` hisoblagichiga yoziladi.
  const reward = self ? Math.max(0, Number(S().creditRewardInstagramSelfConfirmed) || 0) : Math.max(0, Number(t.rewardCredits) || 0);
  const dest = destOf(o.destinationId);
  const memBefore = !self && db.memberships.find((m) => m.userId === u.id && m.channelId === t.destinationId) || null;
  const snap = {
    task: { status: t.status, verifiedAt: t.verifiedAt, checkedAt: t.checkedAt },
    order: { verifiedQuantity: o.verifiedQuantity, pendingQuantity: o.pendingQuantity, freeUnits: o.freeUnits, status: o.status, completedAt: o.completedAt },
    user: { available: u.credits.available, reserved: u.credits.reserved, spent: u.credits.spent, verifiedRewards: u.credits.verifiedRewards, selfReportedRewards: u.credits.selfReportedRewards, completedTasksCount: u.completedTasksCount, activeOrdersCount: u.activeOrdersCount },
    dest: dest ? { verifiedSubscribers: dest.verifiedSubscribers, activeSubscribers: dest.activeSubscribers, pendingSubscriptions: dest.pendingSubscriptions, pendingFollowers: dest.pendingFollowers, selfReportedFollowers: dest.selfReportedFollowers } : null,
    mem: memBefore ? { ...memBefore } : null,
    len: { tx: db.transactions.length, log: db.verifyLog.length, ev: db.membershipEvents.length, job: db.verificationJobs.length, mem: db.memberships.length }
  };
  APPLYING_TASKS.add(t.id);
  try {
    // 1) Jurnal yozuvi BIRINCHI. Kalit band bo'lsa — hech narsa o'zgarmaydi.
    const desc = reward > 0 ? `${self ? "Instagram (o\u2018zi tasdiqlagan)" : "Telegram"}: ${t.destinationTitle}` : `${t.destinationTitle} (Instagram \u2014 o\u2018zi tasdiqlagan, kredit berilmadi)`;
    const okTx = addTx(u, reward, "reward_task", desc, {
      orderId: o.id,
      channelId: t.destinationId,
      relatedTaskId: t.id,
      idempotencyKey: key,
      ...(reward > 0 ? {} : { nonPayable: true })
    });
    if (!okTx) return 0;
    // 2) Vazifa va buyurtma.
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
    if (dest) {
      if (self) {
        dest.selfReportedFollowers = (dest.selfReportedFollowers || 0) + 1;
        dest.pendingFollowers = Math.max(0, dest.pendingFollowers - 1);
      } else {
        dest.verifiedSubscribers = (dest.verifiedSubscribers || 0) + 1;
        dest.activeSubscribers = (dest.activeSubscribers || 0) + 1;
        dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - 1);
      }
    }
    // 3) Mukofotni oluvchining hamyoni va hisoblagichlari.
    if (reward > 0) {
      u.credits.available += reward;
      self ? u.credits.selfReportedRewards += reward : u.credits.verifiedRewards += reward;
    }
    u.completedTasksCount++;
    // 4) A'zolik registri + 24 soatlik qayta tekshiruv (faqat Telegram).
    if (!self) {
      const m = ensureMembership(u.id, t.destinationId);
      const oldStatus = m.status;
      const at = (/* @__PURE__ */ new Date()).toISOString();
      m.status = "ACTIVE";
      m.firstVerifiedAt = m.firstVerifiedAt || at;
      m.lastCheckedAt = at;
      m.lastCheckResult = "member";
      m.consecutiveCheckErrors = 0;
      m.updatedAt = at;
      if (oldStatus !== "ACTIVE") {
        m.lastMembershipChangeAt = at;
        membershipEvent(u.id, t.destinationId, oldStatus === "CANCELLED" ? "REJOINED" : "FIRST_VERIFIED", oldStatus, "ACTIVE", "task_verify", "member", t.id);
      }
      scheduleMembershipCheck(m, Date.now() + memRecheckDelay());
    }
    db.verifyLog.push({ ownerId: o.userId, title: t.destinationTitle, platform: t.platform, source: self ? "self" : "verified", at: Date.now(), ...(CURRENT_OP ? { opId: CURRENT_OP } : {}) });
    if (db.verifyLog.length > 5e4) db.verifyLog.splice(0, 1e4);
    // 5) Jurnaldagi yakuniy balans — yozuvdan keyingi haqiqiy qiymat.
    db.transactions[db.transactions.length - 1].balanceAfter = u.credits.available;
    checkOrderComplete(o);
    return reward;
  } catch (e) {
    // Atomarlik: yarimta natija qolmaydi — jurnal va barcha hisoblagichlar
    // chaqiruvdan oldingi holatga qaytariladi.
    db.transactions.length = snap.len.tx;
    db.verifyLog.length = snap.len.log;
    db.membershipEvents.length = snap.len.ev;
    db.verificationJobs.length = snap.len.job;
    db.memberships.length = snap.len.mem;
    Object.assign(t, snap.task);
    Object.assign(o, snap.order);
    Object.assign(u.credits, { available: snap.user.available, reserved: snap.user.reserved, spent: snap.user.spent, verifiedRewards: snap.user.verifiedRewards, selfReportedRewards: snap.user.selfReportedRewards });
    u.completedTasksCount = snap.user.completedTasksCount;
    u.activeOrdersCount = snap.user.activeOrdersCount;
    if (snap.dest && dest) Object.assign(dest, snap.dest);
    if (snap.mem && memBefore) Object.assign(memBefore, snap.mem);
    console.error(`applyVerified qaytarildi (${t.id}):`, e && e.message || e);
    return 0;
  } finally {
    APPLYING_TASKS.delete(t.id);
  }
}
// `opts.defer` berilsa bildirishnoma darhol yuborilmaydi, massivga yig'iladi —
// pul amali bazaga yozilgandan keyingina yuboriladi (rollback bo'lsa yo'q).
async function qualifyReferralCore(u, opts) {
  const ref = db.referrals.find((r) => r.referredUserId === u.id);
  if (!ref) return;
  if (ref.bonusIssued) return; // bonus faqat BIR marta
  if (ref.referrerId === u.id) return; // o'zini referal qilish taqiqlanadi
  const referrer = userById(ref.referrerId);
  if (!referrer || referrer.status === "blocked") return;
  ref.hasCompletedTask = true;
  ref.isVerified = true;
  ref.verifiedAt ||= nowStr();
  const q = qualifyReferral(ref, true, S().creditRewardReferral);
  if (!q.isEligible) return;
  // Malakali referal = TASDIQLANGAN Telegram obunasi (applyVerified orqali kelgan
  // reward). `SELF_CONFIRMED`/Instagram yo'li bu funksiyani chaqirmaydi.
  const amount = Math.max(0, Number(q.rewardCredits) || 0);
  // Alohida chaqiruvda o'z operatsiyamiz; `noSave` bo'lsa chaqiruvchining op'i.
  const endOp = opts && opts.noSave ? null : opStart("ref");
  const snap = creditsSnapshot(referrer);
  const refBefore = { bonusAmount: ref.bonusAmount, bonusIssued: ref.bonusIssued, awaitingChoice: ref.awaitingChoice, paidAt: ref.paidAt };
  if (amount > 0) {
    const before = Number(referrer.credits.available) || 0;
    // `REFERRAL_REWARD` — bitta umumiy hamyonga tushadigan oddiy kirim yozuvi.
    // Idempotency kaliti takroriy to'lovni to'liq yopadi.
    if (!addTx(referrer, amount, "REFERRAL_REWARD", `Referal bonusi: ${u.displayName}`, { idempotencyKey: `refreward:${ref.id}`, referralId: ref.id })) return;
    referrer.credits.available = before + amount;
    db.transactions[db.transactions.length - 1].balanceAfter = referrer.credits.available;
  }
  ref.bonusAmount = amount;
  ref.bonusIssued = true;
  ref.awaitingChoice = false;
  ref.paidAt = nowStr();
  u.isReferralVerified = true;
  // Pul amali — bildirishnomadan OLDIN saqlanadi; saqlanmasa hammasi qaytariladi.
  // `opts.noSave` — chaqiruvchi (verifyBatch / TASK_CHECK) hammasini bitta
  // atomar yozuvda saqlaydi, shu bilan oraliq yozuv va drift bo'lmaydi.
  if (!(opts && opts.noSave)) {
    if (endOp) endOp();
    if (!(await flushOrRollback(() => {
      creditsRestore(referrer, snap);
      Object.assign(ref, refBefore);
      u.isReferralVerified = false;
    }))) return;
  }
  const sendNotice = () => {
    if (notifOn(referrer, "referrals"))
      notify(referrer, `\u{1F465} Do‘stingiz <b>${esc(u.displayName)}</b> birinchi vazifasini bajardi!\n\n\u{1F381} <b>${amount} kredit</b> referal bonusi hisobingizga qo‘shildi. Hozirgi balans: <b>${referrer.credits.available}</b> kredit.`);
  };
  if (opts && Array.isArray(opts.defer)) opts.defer.push(sendNotice);
  else sendNotice();
}
// Referal malakasi + yagona 300 kredit. `noSave` berilsa chaqiruvchi
// tranzaksiyasi ichida ishlaydi; aks holda O'ZI instanslararo qulf ostida
// bajariladi — ikki instans bir vaqtda malakani tekshirsa ham `bonusIssued`
// va `refreward:<id>` idempotency kaliti ikkinchi to'lovni to'sadi.
async function tryQualifyReferral(u, opts) {
  if (opts && opts.noSave) return qualifyReferralCore(u, opts);
  const res = await withStateTx(() => qualifyReferralCore(u, opts));
  if (!res.ok) console.error(`referal mukofoti bajarilmadi (${u && u.id}, ${res.reason})`);
  return res.ok ? res.value : undefined;
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
// Tasdiqlash + mukofot + referal — BITTA saqlash birligi. Saqlash yiqilsa
// hamma o'zgarish qaytariladi: aks holda keyingi aloqasiz `save()` bu
// tasdiqlanmagan mukofotni bazaga yozib yuborardi (balans va ledger birga
// o'zgarib, foydalanuvchi esa "saqlanmadi" xabarini olgan bo'lardi).
function verifyRollbackSnapshot(u, batch, op) {
  const taskIds = [...new Set((batch || []).map((t) => t.id))];
  const orderIds = [...new Set((batch || []).map((t) => t.orderId).filter(Boolean))];
  const destIds = [...new Set((batch || []).map((t) => t.destinationId).filter(Boolean))];
  const ref = db.referrals.find((r) => r.referredUserId === u.id) || null;
  const referrer = ref ? userById(ref.referrerId) : null;
  return {
    op: op || CURRENT_OP,
    user: deepCopy(u),
    referrerId: referrer ? referrer.id : "",
    referrer: referrer ? deepCopy(referrer) : null,
    tasks: taskIds.map((id) => [id, deepCopy(db.tasks.find((t) => t.id === id))]).filter((x) => x[1]),
    orders: orderIds.map((id) => [id, deepCopy(db.orders.find((o) => o.id === id))]).filter((x) => x[1]),
    dests: destIds.map((id) => [id, deepCopy(destOf(id))]).filter((x) => x[1]),
    refId: ref ? ref.id : "",
    ref: ref ? deepCopy(ref) : null,
    // Bu operatsiya tegishi mumkin bo'lgan joblar (obyekt sifatida tiklanadi).
    jobs: db.verificationJobs
      .filter((j) => taskIds.includes(j.taskId) || (ref && j.userId === u.id))
      .map((j) => [j.id, deepCopy(j)]),
    len: { tx: db.transactions.length, ev: db.membershipEvents.length, log: db.verifyLog.length }
  };
}
function verifyRollbackApply(snap, u) {
  if (!snap) return;
  if (u) restoreInto(u, snap.user);
  if (snap.ref && snap.referrer) {
    const r = userById(snap.referrerId);
    if (r) restoreInto(r, snap.referrer);
  }
  for (const [id, v] of snap.tasks) {
    const t = db.tasks.find((x) => x.id === id);
    if (t) restoreInto(t, v);
  }
  for (const [id, v] of snap.orders) {
    const o = db.orders.find((x) => x.id === id);
    if (o) restoreInto(o, v);
  }
  for (const [id, v] of snap.dests) {
    const d = destOf(id);
    if (d) restoreInto(d, v);
  }
  if (snap.ref) {
    const ref = db.referrals.find((r) => r.id === snap.refId);
    if (ref) restoreInto(ref, snap.ref);
  }
  // Faqat SHU operatsiya yaratgan yozuvlar olib tashlanadi — boshqa handler
  // persist kutish paytida yozgan yozuvlar saqlanib qoladi.
  db.orders = dropOpRows(db.orders, snap, 0);
  db.verificationJobs = dropOpRows(db.verificationJobs, snap, 0);
  db.memberships = dropOpRows(db.memberships, snap, 0);
  db.transactions = dropOpRows(db.transactions, snap, snap.len.tx);
  db.membershipEvents = dropOpRows(db.membershipEvents, snap, snap.len.ev);
  db.verifyLog = dropOpRows(db.verifyLog, snap, snap.len.log);
  if (snap.jobs) {
    for (const [id, v] of snap.jobs) {
      const j = db.verificationJobs.find((x) => x.id === id);
      if (j) restoreInto(j, v);
    }
  }
}
async function verifyBatch(u, platform, chat) {
  // CHECK_ERROR vazifa foydalanuvchi tugmasi bilan QAYTA ishlanmaydi: uni faqat
  // doimiy TASK_CHECK jobi tekshiradi (spec §2). Shu tufayli job va tugma bir
  // vazifa uchun bir vaqtda ishlamaydi — dublikat reward yo'li yopiladi.
  const batch = db.tasks.filter((t) => t.assignedTo === u.id && t.platform === platform && OPEN.has(t.status) && t.status !== "CHECK_ERROR").sort((a, b) => a.queueSequence - b.queueSequence).slice(0, 10);
  if (!batch.length) return send(chat, T(u, "verify_none"), menuFor(u));
  // Saqlash yiqilsa shu holatga qaytamiz (rollback snapshot). Operatsiya ID
  // oldindan yaratiladi: tarmoq fazasida u SET QILINMAYDI (boshqa handlerlar
  // yozuvlari bizning op bilan belgilanib qolmasligi uchun).
  const opV = newOpId("vb");
  const refNotices = [];
  const lookup = {};
  let retriesSaved = 0;
  let firstRetryDelayMs = 0;
  if (platform === "telegram") {
    // Har bir vazifa MUSTAQIL tekshiriladi: bittasining yiqilishi qolgan
    // to'qqiztasini to'xtatmaydi (spec §5). Bir vaqtda ko'pi bilan
    // VERIFY_CONCURRENCY ta so'rov — Telegram'ni parallel so'rov bilan
    // bosib ketmaymiz (spec §4).
    const results = await mapLimit(batch, VERIFY_CONCURRENCY, async (t) => {
      const dest = destOf(t.destinationId);
      const ctx = { taskId: t.id, orderId: t.orderId, channelDbId: dest ? dest.id : "", stage: "task_verify" };
      if (!dest || !dest.channelId) {
        return { verified: false, isApiError: true, transient: false, reason: "channel_missing", diag: null };
      }
      try {
        const r = await checkMemberInfo(dest.channelId, u.telegramId, ctx);
        return {
          verified: r.result === "member",
          isApiError: r.result === "error",
          transient: !!r.transient,
          retryAfter: Number(r.retryAfter) || 0,
          reason: r.reason || TG_ERR.UNKNOWN,
          diag: r.diag || null
        };
      } catch (e) {
        // Kutilmagan istisno ham faqat shu vazifaga tegishli bo'lib qoladi.
        const diag = recordVerifyFailure(tgDiag(
          { description: String(e && e.message || e), error_code: 0, errKind: TG_ERR.UNKNOWN, transient: true },
          "getChatMember",
          { chatId: dest.channelId, userId: u.telegramId, ...ctx }
        ));
        return { verified: false, isApiError: true, transient: true, retryAfter: 0, reason: TG_ERR.UNKNOWN, diag };
      }
    });
    batch.forEach((t, i) => (lookup[t.id] = results[i]));
  } else {
    for (const t of batch) lookup[t.id] = { verified: Date.now() - Date.parse(t.createdAt) > 15e3 };
  }
  let out = null;
  let earned = 0;
  let auto = null;
  let vbSaved = true;
  let snapV = null;
  // Tarmoq fazasi tugadi — endi INSTANSLARARO qulf ostida FAQAT sinxron
  // mutatsiya va atomik yozuv. Holat qayta o'qiladi, shuning uchun boshqa
  // instans yozgan mukofot yo'qolmaydi va takroriy mukofot berilmaydi.
  const vbRes = await withStateTx(async () => {
  snapV = verifyRollbackSnapshot(u, batch, opV);
  out = processTaskBatchVerification(batch, lookup);
  // Operatsiya ID shu sinxron blokni belgilaydi (rollback faqat shu yozuvlarni oladi).
  const endOp = opSet(opV);
  // Har bir tekshiruv natijasi alohida saqlanadi (spec §3-A, 4-qadam).
  const checkedAt = (/* @__PURE__ */ new Date()).toISOString();
  for (const t of batch) {
    const real = db.tasks.find((x) => x.id === t.id);
    if (!real) continue;
    const res = lookup[t.id] || {};
    real.lastCheckResult = res.isApiError ? "error" : res.verified ? "member" : "not_member";
    real.checkedAt = checkedAt;
    if (res.isApiError) {
      real.consecutiveCheckErrors = (real.consecutiveCheckErrors || 0) + 1;
      real.lastCheckReason = res.reason || TG_ERR.UNKNOWN;
      // Haqiqiy Telegram javobi saqlanadi — umumiy matn bilan almashtirilmaydi.
      if (res.diag) {
        real.lastCheckError = {
          errorCode: res.diag.errorCode,
          description: res.diag.description,
          httpStatus: res.diag.httpStatus,
          retryAfter: res.diag.retryAfter,
          errKind: res.diag.errKind,
          at: res.diag.ts
        };
      }
      const delay = retryDelayMs(real.consecutiveCheckErrors, res.retryAfter || 0);
      real.retryAt = new Date(Date.now() + delay).toISOString();
      // Vaqtinchalik xato — doimiy navbatga yozamiz (restartdan keyin qoladi).
      if (res.transient) {
        if (scheduleTaskCheck(real, Date.now() + delay)) retriesSaved++;
        if (!firstRetryDelayMs) firstRetryDelayMs = delay;
      }
      // Doimiy xato (bot admin emas / kanal yo'q) — kanal holatini yangilaymiz.
      if (!res.transient && (res.reason === TG_ERR.NO_RIGHTS || res.reason === TG_ERR.NOT_FOUND || res.reason === "channel_missing")) {
        const dest = destOf(real.destinationId);
        if (dest && dest.channelId) markChannelPermissionLost(dest, res.reason);
      }
    } else {
      real.consecutiveCheckErrors = 0;
      real.retryAt = "";
      real.lastCheckError = null;
      cancelTaskCheck(real.id);
    }
  }
  let firstTg = false;
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
    if (!real) continue;
    // Vaqtinchalik xato olgan vazifa FIFO navbatiga qaytarilmaydi va
    // foydalanuvchiga qayta ko'rsatilmaydi — uni TASK_CHECK jobi tekshiradi.
    if (d.status === "CHECK_ERROR") {
      real.status = "CHECK_ERROR";
      real.isDeferred = false;
      continue;
    }
    const dst = destOf(real.destinationId);
    // Kanal yaroqsiz bo'lsa (huquq yo'qolgan / uzilgan) vazifa navbatga qaytmaydi.
    if (!dst || dst.disconnectedAt || (dst.status && dst.status !== "active")) {
      real.status = "CANCELLED";
      real.cancelReason = "channel_unavailable";
      continue;
    }
    real.status = d.status;
    real.isDeferred = true;
    real.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  // Referal bildirishnomasi saqlash TASDIQLANGANDAN keyin yuboriladi;
  // saqlashni bu funksiya emas, `verifyBatch()` bajaradi (bitta atomar birlik).
  if (firstTg) await tryQualifyReferral(u, { defer: refNotices, noSave: true });
  auto = autoOrderFromBalance(u);
  endOp();
  // Pul amali bajarildi — xabardan OLDIN atomik saqlaymiz (crash-safety §6):
  // 500 ms debounce oynasida jarayon o'lsa, foydalanuvchi ko'rgan mukofot
  // yo'qolmasligi kerak.
  if (earned > 0 || auto) {
    // Postgres rejimida yozuv HAQIQATAN bajarilishini kutamiz. Yiqilsa hamma
    // o'zgarish (mukofot, task, order, referal, avtobuyurtma) QAYTARILADI —
    // keyingi aloqasiz `save()` bu tasdiqlanmagan mukofotni yozib yubormaydi.
    // Saqlash + rollback qulf ostida: oraga boshqa yozuv kirmaydi.
    const saved = await withSaveLock(async () => {
      if (await flushSaveAwaited()) return true;
      verifyRollbackApply(snapV, u);
      return false;
    });
    if (!saved) vbSaved = false;
  } else save();
  });
  // Qulf olinmasa, holat o'qilmasa yoki yozuv yiqilsa — yolg'on muvaffaqiyat
  // xabari YO'Q va xotiradagi o'zgarishlar qaytariladi.
  if (!vbRes.ok || !vbSaved) {
    if (!vbSaved) verifyRollbackApply(snapV, u);
    console.error("verifyBatch: saqlanmadi — tasdiqlash va mukofot qaytarildi");
    return send(chat, T(u, "save_err"), menuFor(u));
  }
  for (const n of refNotices) n();
  const notDone = out.deferredTasks.filter((t) => t.status === "PENDING");
  let text = T(u, "verify_ok", { ok: out.verifiedTasks.length, reward: earned, bal: u.credits.available });
  if (auto && auto.cost > 0) text += T(u, "auto_order_note", { qty: auto.qty, title: esc(auto.channel.title) });
  if (notDone.length) text += `

⏳ <b>Hali obuna bo‘lmaganlar (${notDone.length} ta):</b>
` + notDone.map((t) => `• ${esc(t.destinationTitle)}`).join("\n") + `

Obuna bo‘lib, yana “✅ Obuna bo‘ldim” tugmasini bosing.`;
  // Texnik xato va kanal muammosi ALOHIDA ko'rsatiladi: ikkalasi bir xil xabar
  // bo'lsa, foydalanuvchi "Telegram buzuq" deb o'ylab qolardi.
  const permTasks = out.apiErrorTasks.filter((t) => {
    const l = lookup[t.id];
    return l && !l.transient;
  });
  const tempTasks = out.apiErrorTasks.filter((t) => {
    const l = lookup[t.id];
    return l && l.transient;
  });
  const permErr = permTasks.length;
  const tempErr = tempTasks.length;
  const reasonOf = (list) => {
    const first = list.map((t) => (lookup[t.id] || {}).reason).find(Boolean);
    return verifyReasonText(u, first);
  };
  if (permErr) text += T(u, "verify_perm_err", { n: permErr, reason: reasonOf(permTasks) });
  if (tempErr) {
    // "Qayta tekshiruv rejalashtirildi" deb faqat navbatga haqiqiy yozuv
    // tushgan bo'lsa aytamiz (spec §6).
    if (retriesSaved >= tempErr) {
      text += T(u, "verify_retry_saved", { n: tempErr, reason: reasonOf(tempTasks), mins: Math.max(1, Math.round(firstRetryDelayMs / 6e4)) });
    } else {
      text += T(u, "verify_temp_err", { n: tempErr, reason: reasonOf(tempTasks) });
    }
  }
  await send(chat, text, menuFor(u));
  if (!notDone.length && !out.apiErrorTasks.length) await showTasks(u, platform, chat);
}
function balanceLine(u) {
  return T(u, "bal", { a: u.credits.available, r: u.credits.reserved });
}
async function showTasks(u, platform, chat, next) {
  if (platform === "telegram" && S().isTelegramPaused) return send(chat, T(u, "paused"), menuFor(u));
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, T(u, "ig_off"), menuFor(u));
  // Bo‘sh turgan kreditni avtomatik buyurtmaga aylantiramiz (navbat to‘lishi uchun).
  // Balansni band qilish — pul amali: instanslararo qulf ostida.
  await withStateTx(() => autoOrderFromBalance(u));
  const batch = next ? getNextBatch(u, platform) : getBatch(u, platform);
  const supply = taskSupply(u, platform);
  if (!batch.length) {
    const key = !supply.activeOrders ? "tasks_reason_orders" : (supply.own > 0 && !supply.seen && !supply.mine) ? "tasks_reason_own" : "tasks_reason_done";
    return send(chat, T(u, "tasks_none", { reason: T(u, key), balance: balanceLine(u) }), menuFor(u));
  }
  const reward = batch[0].rewardCredits;
  let text = T(u, "tasks_title", { n: batch.length, reward }) +
    batch.map((t, i) => `${i + 1}. ${esc(t.destinationTitle)}${t.isDeferred ? " 🔁" : ""}`).join("\n") +
    (platform === "instagram" ? "\n\n" + T(u, "ig_note") : "");
  // 10 tadan kam bo'lsa — sababini aytamiz (bot buzmagan, buyurtma shuncha).
  if (batch.length < 10) text += T(u, "tasks_supply", { o: supply.activeOrders, b: batch.length });
  if (batch.some((t) => t.noMore)) text += T(u, "tasks_already");
  // Har bir kanal uchun bitta qator: havola + shikoyat tugmasi yonma-yon.
  const rows = batch.map((t, i) => {
    const row = [{ text: `🔗 ${i + 1}. ${t.destinationTitle}`.slice(0, 34), url: t.destinationUrl }];
    if (platform === "telegram") row.push({ text: "⚠️ Shikoyat", callback_data: `cmpd:${t.id}` });
    return row;
  });
  rows.push([{ text: T(u, "tasks_btn_done"), callback_data: `verify:${platform === "telegram" ? "tg" : "ig"}` }]);
  rows.push([{ text: T(u, "tasks_btn_refresh"), callback_data: `tasks:${platform === "telegram" ? "tg" : "ig"}` }, { text: T(u, "tasks_btn_next"), callback_data: `tasks:${platform === "telegram" ? "tg" : "ig"}:next` }]);
  return send(chat, text, inline(rows));
}
// Faqat faol kanallar ro'yxatda; uzilganlari tarix uchun bazada qoladi.
var channelsOf = (u) => db.channels.filter((c) => !c.disconnectedAt && (c.ownerId === u.id || (c.controllers || []).some((k) => k.userId === u.id)));
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
  // Kredit yig‘ilib, hali buyurtma berilmagan bo‘lsa — eslatamiz (spec §6).
  const hasActive = db.orders.some((o) => o.userId === u.id && o.status === "active");
  const hint = chs.length && !hasActive && u.credits.available >= 10 ? T(u, "ch_order_hint", { a: u.credits.available }) : "";
  return send(chat, T(u, "ch_title", { n: chs.length, list, balance: balanceLine(u) }) + hint, inline(rows));
}
// Kanal statistikasi sahifasi (spec §6): obunachi holatlari, buyurtma tarixi,
// shikoyatlar va nazoratchilar bir joyda.
async function showChannelDetail(u, ch, chat) {
  const os = db.orders.filter((o) => o.destinationId === ch.id).slice(-5).reverse();
  const cmps = db.complaints.filter((c) => c.destinationId === ch.id);
  const hist = os.length
    ? os.map((o) => `• ${o.requestedQuantity} — ${o.verifiedQuantity} • ${o.status === "active" ? "🟢" : o.status === "completed" ? "✅" : "⛔"}`).join("\n")
    : "—";
  const warn = ch.status === "permission_lost" || ch.botHasAdminRights === false ? T(u, "ch_lost_warn") : "";
  const text = (warn ? warn + "\n\n" : "") + T(u, "ch_detail", {
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
  if (u.credits.available >= 10) rows[0].push({ text: T(u, "ch_buy_all"), callback_data: `ordall:${ch.id}` });
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
var LANG_LABEL = { uz: "\u{1F1FA}\u{1F1FF} O\u2018zbekcha", ru: "\u{1F1F7}\u{1F1FA} \u0420\u0443\u0441\u0441\u043a\u0438\u0439", en: "\u{1F1EC}\u{1F1E7} English" };
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
    [{ text: T(u, "set_notif_btn"), callback_data: "setnotif" }],
    [{ text: T(u, "set_security_btn"), callback_data: "setsec" }, { text: T(u, "set_accounts_btn"), callback_data: "setacc" }],
    [{ text: T(u, "set_rates_btn"), callback_data: "setrates" }, { text: T(u, "set_info_btn"), callback_data: "setinfo" }],
    [{ text: T(u, "set_support_btn"), callback_data: "setsupport" }, { text: T(u, "my_tickets_btn"), callback_data: "setmyt" }],
    [{ text: T(u, "set_back"), callback_data: "settings" }, { text: T(u, "set_main_btn"), callback_data: "setmain" }]
  ]));
}
async function showNotifications(u, chat) {
  const mark = (ok) => (ok ? "\u2705" : "\u26D4");
  return send(chat, T(u, "set_notif_title", {
    sub: mark(notifOn(u, "subscribers")),
    ref: mark(notifOn(u, "referrals")),
    ord: mark(notifOn(u, "orders")),
    tech: mark(notifOn(u, "technical")),
    hourly: u.notifications ? "\u2705" : "\u26D4"
  }), inline([
    [{ text: T(u, "nt_sub") + " " + mark(notifOn(u, "subscribers")), callback_data: "nt:subscribers" }, { text: T(u, "nt_ref") + " " + mark(notifOn(u, "referrals")), callback_data: "nt:referrals" }],
    [{ text: T(u, "nt_ord") + " " + mark(notifOn(u, "orders")), callback_data: "nt:orders" }, { text: T(u, "nt_tech") + " " + mark(notifOn(u, "technical")), callback_data: "nt:technical" }],
    [{ text: (u.notifications ? T(u, "set_hourly_on") : T(u, "set_hourly_off")) + " \u2014 " + (u.notifications ? "\u2705" : "\u26D4"), callback_data: "notif" }],
    [{ text: T(u, "set_all_on"), callback_data: "ntall:on" }, { text: T(u, "set_all_off"), callback_data: "ntall:off" }],
    [{ text: T(u, "set_back"), callback_data: "settings" }]
  ]));
}
async function showSecurity(u, chat) {
  return send(chat, T(u, "set_sec_title", {
    id: u.telegramId,
    status: u.status === "blocked" ? T(u, "st_blocked") : T(u, "st_active"),
    last: esc(u.lastSeenAt || u.registeredAt || "\u2014")
  }), inline([
    [{ text: T(u, "sec_report_btn"), callback_data: "secrep" }],
    [{ text: T(u, "set_info_btn"), callback_data: "setinfo" }],
    [{ text: T(u, "set_back"), callback_data: "settings" }, { text: T(u, "set_main_btn"), callback_data: "setmain" }]
  ]));
}
async function showAccounts(u, chat) {
  const chs = channelsOf(u);
  const list = chs.length
    ? chs.map((c) => T(u, "acc_ch_line", {
        title: esc(c.title),
        username: esc(c.username),
        role: c.ownerId === u.id ? T(u, "acc_role_owner") : T(u, "acc_role_ctl"),
        bot: c.botHasAdminRights === false || c.status === "permission_lost" ? T(u, "acc_bot_no") : T(u, "acc_bot_ok")
      })).join("\n")
    : T(u, "acc_none");
  const rows = chs.slice(0, 6).map((c) => [{ text: `\u{1F4E2} ${c.title}`.slice(0, 32), callback_data: `chd:${c.id}` }]);
  rows.push([{ text: T(u, "ch_add"), callback_data: "chadd" }, { text: T(u, "b_channels"), callback_data: "chs:0" }]);
  rows.push([{ text: T(u, "set_back"), callback_data: "settings" }, { text: T(u, "set_main_btn"), callback_data: "setmain" }]);
  return send(chat, T(u, "set_acc_title", {
    id: u.telegramId,
    username: u.username ? "@" + esc(u.username) : "\u2014",
    name: esc(u.displayName || ""),
    lang: LANG_LABEL[langOf(u)],
    n: chs.length,
    list
  }), inline(rows));
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
  { key: "subs_down", label: "\u{1F4C9} Obunachilar kamayib ketdi" },
  { key: "order_stuck", label: "\u{23F3} Buyurtmam bajarilmayapti" },
  { key: "wrong_count", label: "\u{1F522} Obunachilar noto‘g‘ri hisoblanmoqda" },
  { key: "tech", label: "\u{1F6E0} Kanalimda texnik muammo bor" },
  { key: "unauth_order", label: "\u{1F6AB} Kanalimga ruxsatsiz buyurtma berilgan" },
  { key: "adult", label: "\u{1F51E} 18+ kontent" },
  { key: "other", label: "\u{1F4AC} Boshqa muammo" },
  { key: "own_words", label: "\u{270D}\u{FE0F} Shikoyatimni o‘zim yozaman" }
];
function catBtns() {
  return inline(CATEGORIES.map((c) => [{ text: c.label, callback_data: `cmpc:${c.key}` }]));
}
function catLabel(key) {
  const hit = CATEGORIES.find((c) => c.key === key);
  if (hit) return hit.label;
  const n = Number(key);
  return Number.isInteger(n) && CATEGORIES[n] ? CATEGORIES[n].label : null;
}

// Homiy kanallar alohida jadvalda saqlanadi — oddiy vazifalar bilan
// aralashtirilmaydi (spec §3-C, §4).
function ensureSponsorMembership(userId, sponsorId) {
  let r = db.sponsorMemberships.find((x) => x.userId === userId && x.sponsorId === sponsorId);
  if (!r) {
    r = { id: nid("sm"), userId, sponsorId, membershipStatus: "UNKNOWN", lastCheckedAt: "", lastCheckResult: "", updatedAt: "" };
    db.sponsorMemberships.push(r);
  }
  return r;
}
async function sponsorGate(u, chat) {
  const missing = [];
  for (const sp of db.sponsors.filter((s) => s.isActive && s.isMandatory)) {
    const res = await checkMember(sp.channelId, u.telegramId);
    const rec = ensureSponsorMembership(u.id, sp.id);
    rec.lastCheckedAt = (/* @__PURE__ */ new Date()).toISOString();
    rec.lastCheckResult = res;
    rec.membershipStatus = res === "member" ? "MEMBER" : res === "error" ? "CHECK_ERROR" : "NOT_MEMBER";
    rec.updatedAt = rec.lastCheckedAt;
    if (res === "not_member") missing.push(sp);
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
  // Manzil holati tekshiriladi: uzilgan yoki pauza qilingan kanalga buyurtma yo'q.
  if (dest.disconnectedAt || dest.status === "paused") return send(chat, TR(u, "\u23F8 Bu kanal vaqtincha to\u2018xtatilgan \u2014 yangi buyurtma qabul qilinmaydi."), menuFor(u));
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
  // `client_token` — MAJBURIY: buyurtma faqat shu kalit bilan yaratiladi va
  // kalit foydalanuvchi + manzil + miqdorga bog'lanadi (spec B).
  const token = crypto.randomBytes(8).toString("hex");
  if (!db.orderTokens) db.orderTokens = {};
  // Oldingi tasdiqlash kaliti bekor qilinadi: har bir tayyorlash yangi kalit
  // beradi, eski tugma esa buyurtma yarata olmaydi.
  const prev = u.state && u.state.token;
  if (prev && db.orderTokens[prev] && !db.orderTokens[prev].orderId && !db.orderTokens[prev].inflight) delete db.orderTokens[prev];
  db.orderTokens[token] = {
    token,
    userId: u.id,
    destId,
    qty,
    platform,
    createdAt: nowStr(),
    claimedAt: "",
    releasedAt: "",
    inflight: false,
    orderId: ""
  };
  // Faqat hajm uchun: ishlatilmoqda bo'lmagan juda eski tokenlar tozalanadi
  // (yaratilgan buyurtmalar va tarix tegilmaydi).
  const tks = Object.keys(db.orderTokens);
  if (tks.length > 500) for (const k of tks.slice(0, tks.length - 500)) if (!db.orderTokens[k].inflight) delete db.orderTokens[k];
  u.state = { type: "order_confirm", destId, qty, platform, unit, token };
  const title = esc(platform === "telegram" ? dest.title : "@" + dest.username);
  return send(chat, T(u, "ord_summary", {
    title,
    qty,
    unit,
    total: chk.totalCost,
    left: u.credits.available - chk.totalCost
  }), inline([
    [{ text: T(u, "ord_yes"), callback_data: `ordok:${token}` }, { text: T(u, "ord_no"), callback_data: "ordno:0" }]
  ]));
}
// Token tekshiruvi va "band qilish" — bitta SINXRON blok (await yo'q). Shu
// tufayli parallel 20 ta so'rovdan faqat bittasi buyurtma yaratadi.
function claimOrderToken(u, destId, qty, token) {
  const tk = String(token || "");
  if (!/^[0-9a-f]{16}$/.test(tk)) return { ok: false, text: "ord_token_missing" };
  if (!db.orderTokens || !db.orderTokens[tk]) return { ok: false, text: "ord_token_missing" };
  const rec = db.orderTokens[tk];
  if (rec.userId !== u.id) return { ok: false, text: "ord_token_missing" };
  if (rec.destId !== destId || Number(rec.qty) !== Number(qty)) return { ok: false, text: "ord_token_missing" };
  if (rec.orderId) {
    const o = db.orders.find((x) => x.id === rec.orderId);
    if (o) return { ok: true, order: o, rec };
    return { ok: false, text: "ord_token_missing" };
  }
  // `inflight` — jarayon ichida band (o'z instansimiz) yoki BOSHQA instansning
  // 60 sekundlik lease'i. Boshqasining lease'i eskirmagan bo'lsa, biz hech
  // narsa band qilmaymiz (parallel ikkinchi reservation yaratilmasin).
  if (rec.inflight) {
    const mine = rec.claimBy === INSTANCE_ID;
    const fresh = Date.now() - (Number(rec.claimedAtMs) || 0) < 60000;
    if (mine || fresh) return { ok: false, text: "ord_inflight", rec };
  }
  rec.inflight = true;
  rec.claimBy = INSTANCE_ID;
  rec.claimedAtMs = Date.now();
  rec.claimedAt = nowStr();
  return { ok: true, rec };
}
async function createOrderConfirmed(u, destId, qty, chat, token) {
  // Token tekshiruvi va band qilish — INSTANSLARARO qulf ostida, eng so'nggi
  // holat bo'yicha. Bir xil `client_token` bilan ikkinchi instans kelsa,
  // u mavjud buyurtmani ko'radi (yangi reservation YO'Q).
  const claim = await withStateTx(() => claimOrderToken(u, destId, qty, token));
  const g = claim.ok ? claim.value : { ok: false, text: "save_err" };
  if (!g.ok) return send(chat, T(u, g.text || "ord_token_missing"), menuFor(u));
  if (g.order) {
    u.state = null;
    save();
    return send(chat, T(u, "ord_created", { title: esc(g.order.destinationTitle), qty: g.order.requestedQuantity, total: g.order.totalCost }), menuFor(u));
  }
  let created = false;
  try {
    await createOrderConfirmedInner(u, destId, qty, chat, g.rec);
    created = !!g.rec.orderId;
  } finally {
    // Faqat O'Z lease'imizni bo'shatamiz — boshqa instansning bandligini
    // xotirada o'chirib, unga parallel reservation yo'lini ochmaymiz.
    if (!g.rec.claimBy || g.rec.claimBy === INSTANCE_ID) {
      g.rec.inflight = false;
      g.rec.claimBy = "";
    }
    if (!created) g.rec.releasedAt = nowStr();
    save();
  }
}
async function createOrderConfirmedInner(u, destId, qty, chat, rec) {
  const dest = destOf(destId);
  if (!dest) return send(chat, "Manzil topilmadi.", menuFor(u));
  if (dest.disconnectedAt || dest.status === "paused") {
    u.state = null;
    return send(chat, TR(u, "\u23F8 Bu kanal vaqtincha to\u2018xtatilgan \u2014 yangi buyurtma qabul qilinmaydi."), menuFor(u));
  }
  const platform = destId.startsWith("ig-") ? "instagram" : "telegram";
  if (S().areOrdersFrozen) return send(chat, TR(u, "\u{1F9CA} Buyurtmalar vaqtincha muzlatilgan."), menuFor(u));
  if (platform === "instagram" && !S().isInstagramEnabled) return send(chat, "\u{1F4F8} Instagram moduli o\u2018chirilgan.", menuFor(u));
  if (!Number.isInteger(qty) || qty < 10 || qty > 1e4) return send(chat, TR(u, "Son 10 dan 10 000 gacha bo\u2018lishi kerak. Qaytadan yozing:"));
  // Buyurtma yaratishdan OLDIN kanal holati va bot huquqi qayta tekshiriladi
  // (spec §1.8). Kredit faqat tekshiruvdan keyin band qilinadi.
  if (platform === "telegram" && dest.channelId) {
    // Bitta bot yetarli: kanalda KAMIDA BITTA yoqilgan bot (asosiy yoki
    // ishchi) administrator bo'lsa, buyurtma qabul qilinadi — a'zolikni shu
    // bot tekshiradi. Qolgan botlarning admin emasligi bloklamaydi.
    const perms = await inspectAllBotsAdmin(dest.channelId);
    const at = new Date().toISOString();
    dest.botAdmins = botAdminSnapshot(perms, at);
    dest.botsMissingAdmin = botsMissingAdmin(perms);
    dest.lastAdminCheckAt = at;
    // Freshness guard: 60 s dan eski natija qarorga kirmaydi.
    const verdict = botAdminVerdict(perms);
    const chosen = verdict.bot;
    const neg = verdict.negative || {};
    if (chosen) {
      dest.botAdminStatus = chosen.status;
      dest.botHasAdminRights = true;
      dest.botAdminBotId = chosen.botDbId;
      if (dest.status === "permission_lost") {
        dest.status = "active";
        dest.permissionLostAt = "";
        dest.permissionNotifiedAt = "";
      }
    } else if (verdict.durableNeg) {
      // Kamida bitta bot ANIQ "admin emas" deb javob berdi va hech bir bot
      // tasdiqlamadi — bitta botning API xatosi buni yashirmaydi (spec §4).
      // Kanal yopiladi, kredit band qilinmaydi, tarix o'chirilmaydi.
      const wasLost = dest.status === "permission_lost" && dest.botHasAdminRights === false;
      dest.botHasAdminRights = false;
      dest.botAdminStatus = neg.status === CHK.NOT_FOUND ? CHK.NOT_FOUND : CHK.NO_BOT;
      dest.status = "permission_lost";
      dest.permissionLostAt = dest.permissionLostAt || new Date().toISOString();
      dest.permissionLostReason = neg.status === CHK.NOT_FOUND ? "bot_not_found" : "no_admin";
      dest.permissionLostCheckedAt = at;
      if (!wasLost) auditSys("channel_permission_lost", dest.id, `reason=${dest.permissionLostReason} checkedAt=${at} via=order`);
      u.state = null;
      save();
      const owner = userById(dest.ownerId);
      if (owner && !dest.permissionNotifiedAt) {
        dest.permissionNotifiedAt = nowStr();
        if (notifOn(owner, "technical")) notify(owner, T(owner, "ch_admin_lost_msg", { title: esc(dest.title) }));
        save();
      }
      return send(chat, T(u, "ch_err_order", { title: esc(dest.title) }) + "\n\n" +
        T(u, neg.status === CHK.LIMITED ? "ch_err_rights" : "ch_err_noadmin"), menuFor(u));
    } else if ((verdict.fresh || []).some((r) => r && r.status === CHK.TOKEN)) {
      // Hech bir bot VERIFIED_ADMIN emas va kamida bitta botning tokeni
      // yaroqsiz — bu TEXNIK sabab (huquq yo'qligi emas). Kredit band
      // qilinmaydi, kanal `permission_lost` deb belgilanmaydi.
      dest.botAdminStatus = CHK.TOKEN;
      u.state = null;
      save();
      return send(chat, T(u, "ch_err_order", { title: esc(dest.title) }) + "\n\n" + T(u, "ch_err_api"), menuFor(u));
    } else {
      // Barcha javoblar noaniq (API xatosi/kutilmoqda) — buyurtma to'xtatilmaydi.
      save();
    }
  }
  const unit = perSub();
  const chk = calculateOrderAffordability(u.credits, qty, unit);
  if (!chk.canAfford) {
    u.state = null;
    return send(chat, TRV(u, "❌ <b>Kredit yetmayapti</b>\n\nKerak: {need} kredit\nSizda: {have} kredit\nYetmayapti: {short} kredit\n\nKredit ishlash uchun “📋 Vazifalar” tugmasini bosing — har bir obuna uchun {reward} kredit beriladi.", { need: chk.totalCost, have: u.credits.available, short: chk.shortage, reward: S().creditRewardTelegram }), menuFor(u));
  }
  // Reservation — INSTANSLARARO kritik bo'lim. Ichida token va balans QAYTA
  // tekshiriladi: tarmoq tekshiruvi (bot huquqi) davomida boshqa instans
  // yozgan bo'lsa, biz eski snapshot bilan band qilmaymiz.
  const txRes = await withStateTx(async () => {
  if (rec.orderId) {
    const prev = db.orders.find((x) => x.id === rec.orderId);
    if (prev) return { state: "exists", order: prev };
  }
  if (rec.inflight && rec.claimBy && rec.claimBy !== INSTANCE_ID) return { state: "busy" };
  rec.inflight = true;
  rec.claimBy = INSTANCE_ID;
  rec.claimedAtMs = Date.now();
  const chk2 = calculateOrderAffordability(u.credits, qty, perSub());
  if (!chk2.canAfford) return { state: "no_credit", chk: chk2 };
  const endOp = opStart("ord");
  const snap = creditsSnapshot(u);
  const destBefore = { totalRequested: dest.totalRequested, pendingSubscriptions: dest.pendingSubscriptions, pendingFollowers: dest.pendingFollowers };
  u.credits.available -= chk2.totalCost;
  u.credits.reserved += chk2.totalCost;
  u.activeOrdersCount = (Number(u.activeOrdersCount) || 0) + 1;
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
    totalCost: chk2.totalCost,
    freeUnits: 0,
    status: "active",
    createdAt: nowStr()
  };
  db.orders.push(o);
  platform === "telegram" ? (dest.totalRequested += qty, dest.pendingSubscriptions += qty) : (dest.totalRequested += qty, dest.pendingFollowers += qty);
  moderationScan("order", { userId: u.id, userName: u.displayName, channelId: o.destinationId, title: o.destinationTitle, qty });
  addTx(u, -chk2.totalCost, "order_spend", "Buyurtma: " + o.destinationTitle + " x" + qty, { orderId: o.id, idempotencyKey: `reserve:${o.id}` });
  rec.orderId = o.id;
  u.state = null;
  endOp();
  // Reservation xabardan OLDIN saqlanadi; saqlanmasa buyurtma va band qilingan
  // kredit qaytariladi (token ham bo'shatiladi) — muvaffaqiyat xabari YO'Q.
  if (!(await flushOrRollback(() => {
    db.orders = db.orders.filter((x) => x.id !== o.id);
    creditsRestore(u, snap);
    u.activeOrdersCount = Math.max(0, (Number(u.activeOrdersCount) || 0) - 1);
    dest.totalRequested = destBefore.totalRequested;
    dest.pendingSubscriptions = destBefore.pendingSubscriptions;
    dest.pendingFollowers = destBefore.pendingFollowers;
    rec.orderId = "";
  }))) return { state: "save_failed" };
  return { state: "created", order: o };
  });
  if (!txRes.ok) return send(chat, T(u, "save_err"), menuFor(u));
  const tres = txRes.value || { state: "save_failed" };
  if (tres.state === "exists") {
    u.state = null;
    return send(chat, T(u, "ord_created", { title: esc(tres.order.destinationTitle), qty: tres.order.requestedQuantity, total: tres.order.totalCost }), menuFor(u));
  }
  if (tres.state === "busy") return send(chat, T(u, "ord_inflight"), menuFor(u));
  if (tres.state === "no_credit") {
    u.state = null;
    return send(chat, TRV(u, "❌ <b>Kredit yetmayapti</b>\n\nKerak: {need} kredit\nSizda: {have} kredit", { need: tres.chk.totalCost, have: u.credits.available }), menuFor(u));
  }
  if (tres.state !== "created") return send(chat, T(u, "save_err"), menuFor(u));
  return send(chat, T(u, "ord_created", { title: esc(tres.order.destinationTitle), qty, total: tres.order.totalCost }), menuFor(u));
}
async function cancelOrder(u, orderId, chat) {
  // Instanslararo kritik bo'lim: qaytim tekshiruvi (`reserved` yetarliligi va
  // takroriy qaytim) QAYTA O'QILGAN holat ustida bajariladi. Ikki instans bir
  // buyurtmani bir vaqtda bekor qilsa, faqat bittasi qaytim yozadi.
  const txRes = await withStateTx(async () => {
  const o = db.orders.find((x) => x.id === orderId && x.userId === u.id);
  if (!o || o.status !== "active") return { state: "notfound" };
  const { refundableUnits, refundCredits } = calculateRefundAmount(o);
  const refundKey = `refund:${o.id}`;
  // Takroriy qaytim (jurnalda yozuv bor) — hech narsa o'zgartirilmaydi.
  if (refundCredits > 0 && db.transactions.some((t) => t.idempotencyKey === refundKey)) {
    auditSys("refund_rejected", o.id, "already_refunded");
    return { state: "already" };
  }
  // `reserved` yetarliligini TEKSHIRAMIZ — `Math.max(0, ...)` bilan yashirmaymiz.
  // Legacy nomuvofiqlik bo'lsa: amal rad etiladi, balans va jurnal tegilmaydi.
  if (refundCredits > 0 && Number(u.credits.reserved) + 1e-9 < refundCredits) {
    auditSys("refund_rejected", o.id, `reserved_insufficient reserved=${u.credits.reserved} required=${refundCredits} user=${u.id}`);
    console.error(`Qaytim rad etildi (${o.id}): reserved ${u.credits.reserved} < refund ${refundCredits}`);
    return { state: "insufficient" };
  }
  const endOp = opStart("refund");
  const snap = creditsSnapshot(u);
  const before = {
    cancelledQuantity: Number(o.cancelledQuantity) || 0,
    pendingQuantity: Number(o.pendingQuantity) || 0,
    completedAt: o.completedAt || "",
    activeOrders: Number(u.activeOrdersCount) || 0
  };
  const dest = destOf(o.destinationId);
  const destBefore = dest ? { pendingSubscriptions: dest.pendingSubscriptions, pendingFollowers: dest.pendingFollowers } : null;
  const touched = db.tasks.filter((t) => t.orderId === o.id && OPEN.has(t.status)).map((t) => t.id);
  o.cancelledQuantity = before.cancelledQuantity + refundableUnits;
  o.pendingQuantity = 0;
  o.status = "cancelled";
  o.completedAt = nowStr();
  u.credits.reserved -= refundCredits;
  u.credits.available += refundCredits;
  u.credits.refunded += refundCredits;
  u.activeOrdersCount = Math.max(0, before.activeOrders - 1);
  for (const t of db.tasks) if (touched.includes(t.id)) t.status = "CANCELLED";
  if (dest) {
    dest.pendingSubscriptions !== void 0 && (dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - refundableUnits));
    dest.pendingFollowers !== void 0 && (dest.pendingFollowers = Math.max(0, dest.pendingFollowers - refundableUnits));
  }
  if (refundCredits > 0)
    addTx(u, refundCredits, "order_refund", `Bekor qilingan buyurtma qaytimi: ${o.destinationTitle}`, { orderId: o.id, idempotencyKey: refundKey });
  endOp();
  // Qaytim xabardan OLDIN saqlanadi; saqlanmasa hammasi qaytariladi.
  if (!(await flushOrRollback(() => {
    o.status = "active";
    o.cancelledQuantity = before.cancelledQuantity;
    o.pendingQuantity = before.pendingQuantity;
    o.completedAt = before.completedAt;
    creditsRestore(u, snap);
    u.activeOrdersCount = before.activeOrders;
    if (dest && destBefore) {
      dest.pendingSubscriptions = destBefore.pendingSubscriptions;
      dest.pendingFollowers = destBefore.pendingFollowers;
    }
    for (const t of db.tasks) if (touched.includes(t.id)) t.status = "PENDING";
  })))
    return { state: "save_failed" };
  return { state: "ok", verified: o.verifiedQuantity, refundableUnits, refundCredits };
  });
  const cs = txRes.ok && txRes.value ? txRes.value : { state: "save_failed" };
  if (cs.state === "notfound") return send(chat, TR(u, "Buyurtma topilmadi yoki allaqachon yopilgan."), menuFor(u));
  if (cs.state === "already") return send(chat, TR(u, "⚠️ Bu buyurtma uchun qaytim allaqachon berilgan."), menuFor(u));
  if (cs.state === "insufficient") return send(chat, TR(u, "⚠️ Qaytimni hozir bajarib bo‘lmadi (hisob ma’lumotida nomuvofiqlik). Balans o‘zgartirilmadi — admin tekshiradi."), menuFor(u));
  if (cs.state !== "ok") return send(chat, T(u, "save_err"), menuFor(u));
  return send(chat, TRV(u, "↩️ <b>Buyurtma bekor qilindi</b>\n\nKelgan obunachilar saqlanadi ({verified} ta), bajarilmagan {unfulfilled} ta uchun <b>{refund} kredit</b> qaytarildi.\n{balance}", { verified: cs.verified, unfulfilled: cs.refundableUnits, refund: cs.refundCredits, balance: balanceLine(u) }), menuFor(u));
}
// Kanal holati bo'yicha xabar kaliti (spec §1.5 — har xato alohida tushuntiriladi).
var CH_ERR_KEY = {
  bot_not_admin: "ch_err_noadmin",
  insufficient_permissions: "ch_err_rights",
  channel_inaccessible: "ch_err_channel",
  user_no_rights: "ch_err_user",
  api_error: "ch_err_api",
  // Bot tekshiruvining yangi holatlari: token/kutilmoqda — texnik xato,
  // kanal mavjud emas — kanal xatosi, qisqartirilgan huquq — huquq xatosi.
  invalid_token: "ch_err_api",
  check_pending: "ch_err_api",
  bot_not_found: "ch_err_channel",
  missing_permissions: "ch_err_rights"
};
function chErrText(u, res) {
  if (res.reason === "bad_address") return T(u, "ch_err_address");
  return T(u, CH_ERR_KEY[res.status] || "ch_err_channel");
}
// Kanalda admin bo'lmagan botlar haqida ogohlantirish (asosiy + ishchi).
function botsMissingText(u, results) {
  const miss = botsMissingAdmin(results);
  return miss.length ? T(u, "ch_bots_missing", { bots: esc(miss.join(", ")) }) : "";
}
async function addChannel(u, text, chat) {
  // To'liq tekshiruv: kanal → bot administratorligi → bot huquqlari →
  // foydalanuvchining boshqaruv huquqi. `getChat` yolg'iz adminlikni isbotlamaydi.
  const res = await verifyChannelForOwner(text, u.telegramId);
  if (!res.ok) {
    // Holat (u.state) saqlanadi — foydalanuvchi tuzatib qayta yuborishi mumkin.
    return send(chat, chErrText(u, res), menuFor(u));
  }
  const ch = res.chat;
  const uname = res.username;
  const existing = db.channels.find((c) => c.channelId === String(ch.id) && c.ownerId === u.id && c.disconnectedAt);
  if (existing) {
    // Avval uzilgan kanal qayta ulanmoqda — tarix saqlanadi, yangi yozuv yaratilmaydi.
    existing.status = "active";
    existing.disconnectedAt = "";
    existing.title = ch.title;
    existing.username = ch.username || uname;
    existing.botHasAdminRights = true;
    existing.botAdminStatus = res.bot ? res.bot.status : CHK.OK;
    existing.botRightsLimited = !!(res.bot && res.bot.limited);
    existing.botAdminBotId = res.bot ? res.bot.botDbId : "";
    existing.lastAdminCheckAt = new Date().toISOString();
    existing.botAdmins = botAdminSnapshot(res.bots, new Date().toISOString());
    existing.botsMissingAdmin = botsMissingAdmin(res.bots);
    existing.permissionLostAt = "";
    existing.permissionNotifiedAt = "";
    u.state = null;
    save();
    return send(chat, T(u, "ch_added", { title: esc(ch.title), username: esc(ch.username || uname) }) + TR(u, "\n♻️ Kanal qayta ulandi — oldingi tarix saqlanib qoldi.") + botsMissingText(u, res.bots), menuFor(u));
  }
  const existing2 = db.channels.find((c) => c.channelId === String(ch.id) && !c.disconnectedAt);
  if (existing2) {
    u.state = null;
    return send(chat, existing2.ownerId === u.id ? TR(u, "Bu kanal allaqachon ulangan — qayta ulash shart emas.") : TR(u, "❌ Bu kanal boshqa foydalanuvchida ulangan.\n\nUning egasi sizga bir martalik kod bersa, “🔑 Kod kiritish” orqali nazoratchi bo‘lasiz."), menuFor(u));
  }
  db.channels.push({
    id: nid("ch"),
    channelId: String(ch.id),
    title: ch.title,
    username: ch.username || uname,
    ownerId: u.id,
    ownerName: u.displayName,
    botHasAdminRights: true,
    botAdminStatus: res.bot ? res.bot.status : CHK.OK,
    botRightsLimited: !!(res.bot && res.bot.limited),
    botAdmins: botAdminSnapshot(res.bots, new Date().toISOString()),
    botAdminBotId: res.bot ? res.bot.botDbId : "",
    botsMissingAdmin: botsMissingAdmin(res.bots),
    lastAdminCheckAt: new Date().toISOString(),
    permissionLostAt: "",
    permissionNotifiedAt: "",
    totalRequested: 0,
    verifiedSubscribers: 0,
    activeSubscribers: 0,
    unsubscribedCount: 0,
    pendingSubscriptions: 0,
    controllers: [],
    status: "active",
    createdAt: nowStr()
  });
  // Bir martalik sovg'a: kanalini birinchi marta ulagan foydalanuvchiga.
  // `grantChannelLinkBonus()` sovg'ani darhol saqlaydi va saqlanmasa `-1`
  // qaytaradi — bu holda foydalanuvchiga summa ko'rsatilmaydi.
  const granted = await grantChannelLinkBonus(u, ch);
  const linkBonus = Math.max(0, granted);
  const bonusOk = granted >= 0;
  u.state = null;
  if (linkBonus <= 0 || !bonusOk) save();
  moderationScan("channel", { userId: u.id, userName: u.displayName, channelId: String(ch.id), title: ch.title, username: ch.username || uname });
  const head = T(u, "ch_added", { title: esc(ch.title), username: esc(ch.username || uname) });
  const autoRes = await withStateTx(() => autoOrderFromBalance(u));
  const autoCh = autoRes.ok ? autoRes.value : null;
  const tail = (res.bot && res.bot.limited ? T(u, "ch_rights_warn") : "") +
    botsMissingText(u, res.bots) +
    (linkBonus > 0 && bonusOk ? T(u, "ch_added_bonus", { bonus: linkBonus, bal: u.credits.available }) : "") +
    (!bonusOk ? "\n\n" + T(u, "save_err") : "") +
    (autoCh ? T(u, "auto_order_note", { qty: autoCh.qty, title: esc(autoCh.channel.title) }) : "");
  return send(chat, head + tail, menuFor(u));
}
var BOT_ID = 0;
// --- Kanal administratorligini tekshirish (spec §1) ---
// Har bir nosozlik ALOHIDA holat bilan qaytadi. Avvalgi kodda hammasi bitta
// `false` ga tiqilardi: tarmoq uzilishi ham, huquq yetishmasligi ham, kanal
// o'chirilgani ham bir xil "bot administrator emas" degan xulosaga olib
// kelardi. Bu noto'g'ri xulosa — API xatosi administratorlikning isboti emas.
var CHK = {
  OK: "ok",
  NO_BOT: "bot_not_admin",
  NO_RIGHTS: "insufficient_permissions",
  NO_CHANNEL: "channel_inaccessible",
  NO_USER: "user_no_rights",
  API: "api_error",
  // Bot administratorligi holatlari (spec §3). Har biri ALOHIDA:
  // `api_error` va `check_pending` hech qachon `bot_not_admin` ga aylanmaydi.
  TOKEN: "invalid_token",
  NOT_FOUND: "bot_not_found",
  LIMITED: "missing_permissions",
  PENDING: "check_pending"
};
// Bot tekshiruvining "doimiy salbiy" natijalari — faqat shular kanal huquqi
// yo'qolgani haqida xulosa berishga asos bo'ladi.
var BOT_DURABLE_NEG = [CHK.NO_BOT, CHK.NOT_FOUND];
// Bot administrator emasligi haqidagi xabar ro'yxatiga kiradigan holatlar
// (token/API muammosi egasining aybi emas — ro'yxatga kirmaydi).
var BOT_MISSING_STATES = [CHK.NO_BOT, CHK.NOT_FOUND];
// Telegram xatosini "vaqtinchalik" va "doimiy" ga ajratamiz. Doimiy xato
// (chat not found, not enough rights) — kanal holati haqidagi fakt. Vaqtinchalik
// xato (timeout, 5xx, 429) esa umuman xulosa chiqarishga asos bo'lmaydi.
function tgFailureKind(r) {
  if (!r || r.ok) return "";
  const k = r.errKind || classifyTgFailure(r).errKind;
  if (k === TG_ERR.NOT_FOUND) return "not_found";
  if (k === TG_ERR.NO_RIGHTS) return "no_rights";
  if ([TG_ERR.NETWORK, TG_ERR.NETWORK_TIMEOUT, TG_ERR.SERVER, TG_ERR.RATE_LIMIT, TG_ERR.AUTH].includes(k)) return "transient";
  return "permanent";
}
// Nosozlikni yagona diagnostika yozuviga aylantiradi. Joblar va jurnal shu
// shaklni ishlatadi — hech qayerda "Telegram API xatosi" kabi umumiy matn
// bilan almashtirilmaydi.
function tgDiag(r, method, ctx = {}) {
  const f = r && r.errKind ? r : classifyTgFailure(r);
  return {
    method: method || r.failedMethod || "",
    chatId: ctx.chatId != null ? String(ctx.chatId) : "",
    userId: ctx.userId != null ? String(ctx.userId) : "",
    taskId: ctx.taskId || "",
    orderId: ctx.orderId || "",
    channelDbId: ctx.channelDbId || "",
    stage: ctx.stage || "",
    errorCode: Number(r && r.error_code) || 0,
    description: String((r && r.description) || "").slice(0, 300),
    httpStatus: Number(r && r.http_status) || 0,
    retryAfter: Number(f.retryAfter) || 0,
    errKind: f.errKind || TG_ERR.UNKNOWN,
    transient: !!f.transient,
    ts: new Date().toISOString()
  };
}
// Har bir nosozlik bazaga yoziladi va to'liq holda logga chiqadi (spec §1).
var VERIFY_ERRORS_MAX = 5e3;
function recordVerifyFailure(diag) {
  if (!diag) return null;
  const rec = { id: nid("verr"), ...diag };
  if (!Array.isArray(db.verifyErrors)) db.verifyErrors = [];
  db.verifyErrors.push(rec);
  if (db.verifyErrors.length > VERIFY_ERRORS_MAX) db.verifyErrors.splice(0, db.verifyErrors.length - VERIFY_ERRORS_MAX);
  console.error(`[verify-error] ${JSON.stringify(rec)}`);
  return rec;
}
// 401 (token) va 403 (block) — administrator darhol bilishi kerak, lekin
// bir xil xabar bilan spam qilinmaydi.
var ADMIN_ALERTS = /* @__PURE__ */ new Map();
function alertAdmins(key, text, cooldownMs = 18e5) {
  const last = ADMIN_ALERTS.get(key) || 0;
  if (Date.now() - last < cooldownMs) return false;
  ADMIN_ALERTS.set(key, Date.now());
  for (const a of ADMIN_IDS) send(a, text).catch(() => {});
  return true;
}
// Vaqtinchalik xatodan keyingi kutish: 429 bo'lsa retry_after, aks holda
// eksponensial backoff (5 daqiqadan 6 soatgacha).
function retryDelayMs(attempt, retryAfterSec = 0) {
  if (retryAfterSec > 0) return Math.min(6 * 36e5, retryAfterSec * 1e3 + 1e3);
  return Math.min(6 * 36e5, 5 * 6e4 * Math.pow(2, Math.min(6, Math.max(0, attempt))));
}
// Cheklangan parallellik: bir vaqtda barcha so'rovlarni otib yubormaymiz.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
function botIdOf() {
  const b = curBot();
  return (b && b.botId) || BOT_ID || 0;
}
// Bot kanalda administratormi va kerakli huquqlari bormi?
// `getChat` dan alohida tekshiriladi — kanal mavjudligi administratorlikni
// isbotlamaydi (spec §1: "getChat alone is not enough").
// Kanalda AYNAN SHU bot administrator ekanini tekshiradi.
// Muhim: har bir bot O'Z tokeni va O'Z `botId` si bilan tekshiriladi. Ilgari
// ishchi botning `botId` si bo'sh bo'lsa asosiy botning id'si ishlatilardi va
// tekshiruv boshqa bot haqida xulosa chiqarardi (spec: ishchi botlar ham xuddi
// asosiy bot kabi tekshiriladi).
function botCheckMeta(bot, extra = {}) {
  return {
    botDbId: bot ? bot.id : "",
    botLabel: bot ? (bot.username ? "@" + bot.username : bot.id || "bot") : "bot",
    botId: Number(bot && bot.botId) || 0,
    role: bot ? bot.role || "worker" : "",
    // Natijaning haqiqiy olingan vaqti. Freshness guard (`botAdminVerdict`)
    // shu maydonga tayanadi — vaqtsiz natija ishonchsiz hisoblanadi.
    checkedAt: new Date().toISOString(),
    ...extra
  };
}
async function inspectBotAdminFor(bot, chatId) {
  if (!bot || !bot.token) return botCheckMeta(bot, { status: CHK.TOKEN, ok: false, reason: "bot_token_missing", transient: false, retryable: false });
  const botId = Number(bot.botId) || 0;
  // botId hali ma'lum emas (getMe tugamagan) — bu xulosa emas, KUTISH holati.
  if (!botId) return botCheckMeta(bot, { status: CHK.PENDING, ok: false, reason: "bot_id_missing", transient: true, retryable: true });
  const r = await tgWith(bot, "getChatMember", { chat_id: chatId, user_id: botId }, 15e3);
  if (!r.ok) return botCheckMeta(bot, botAdminFailure(r));
  const st = r.result.status;
  if (st === "creator") return botCheckMeta(bot, { status: CHK.OK, ok: true, botStatus: st, rights: null, missing: [], limited: false });
  if (st !== "administrator") return botCheckMeta(bot, { status: CHK.NO_BOT, ok: false, botStatus: st, reason: "bot_status_" + st, transient: false });
  const rights = r.result.permissions || null;
  const missing = [];
  if (rights && rights.can_invite_users === false) missing.push("can_invite_users");
  // Administrator, lekin huquqlar qisqartirilgan. A'zolikni o'qish uchun
  // administratorlik yetarli, shuning uchun bu bloklamaydi (`ok: true`) —
  // lekin holat ATAYIN `missing_permissions` deb ajratiladi va panelda
  // ko'rinadi; `pickAdminBot` to'liq huquqli botni ustun qo'yadi.
  return botCheckMeta(bot, {
    status: missing.length ? CHK.LIMITED : CHK.OK,
    ok: true,
    botStatus: st,
    rights,
    missing,
    limited: missing.length > 0,
    transient: false
  });
}
// `getChatMember` nosozligini aniq holatga aylantiradi. Muhim: 401, 403, 400,
// 429 va tarmoq xatolari BIR XIL "admin emas" degan xulosaga olib kelmaydi.
function botAdminFailure(r) {
  const f = classifyTgFailure(r);
  const desc = String((r && r.description) || "");
  const base = { transient: !!f.transient, retryAfter: Number(f.retryAfter) || 0, reason: f.errKind || TG_ERR.UNKNOWN };
  // 401 — token yaroqsiz. Bu kanal haqidagi fakt EMAS, lekin qayta urinish ham
  // foyda bermaydi: operator tokenni almashtirishi kerak.
  if (f.errKind === TG_ERR.AUTH) return { ...base, status: CHK.TOKEN, ok: false, transient: false, retryable: false, reason: "invalid_token" };
  // 429 / 5xx / tarmoq / timeout — xulosa YO'Q, keyin qayta uriniladi.
  if ([TG_ERR.RATE_LIMIT, TG_ERR.SERVER, TG_ERR.NETWORK, TG_ERR.NETWORK_TIMEOUT].includes(f.errKind)) {
    return { ...base, status: CHK.API, ok: false, transient: true, retryable: true };
  }
  // Bot kanaldan chiqarilgan / bloklangan / kanal o'chirilgan.
  if (f.errKind === TG_ERR.BLOCKED) return { ...base, status: CHK.NOT_FOUND, ok: false, transient: false, reason: "bot_removed_or_blocked" };
  if (f.errKind === TG_ERR.NOT_FOUND) return { ...base, status: CHK.NOT_FOUND, ok: false, transient: false, reason: "chat_not_found" };
  // Huquq yetishmasligi haqidagi aniq javoblar — bot haqiqatan admin emas.
  if (/not enough rights|chat_admin_required|have no rights|member list is inaccessible|bot is not a member/i.test(desc)) {
    return { ...base, status: CHK.NO_BOT, ok: false, transient: false, reason: "not_admin" };
  }
  if (f.errKind === TG_ERR.NO_RIGHTS) return { ...base, status: CHK.NO_BOT, ok: false, transient: false, reason: "not_admin" };
  // Noma'lum/400 — xulosa chiqarilmaydi, lekin "admin emas" ham deyilmaydi.
  return { ...base, status: CHK.API, ok: false, transient: !!f.transient, retryable: true, reason: f.errKind || "unknown" };
}
async function inspectBotAdmin(chatId) {
  return inspectBotAdminFor(curBot(), chatId);
}
// Tekshiriladigan botlar: asosiy bot birinchi, keyin yoqilgan ishchi botlar.
function botsForChecks() {
  const list = botsList().filter((b) => b && b.token && b.enabled !== false);
  return list.slice().sort((a, b) => (a.role === "main" ? 0 : 1) - (b.role === "main" ? 0 : 1));
}
// Kanalda BARCHA yoqilgan botlar administrator ekanini tekshiradi.
// Telegram'ni bosib ketmaslik uchun bir vaqtda 3 tadan ko'p so'rov yuborilmaydi.
async function inspectAllBotsAdmin(chatId) {
  const bots = botsForChecks();
  if (!bots.length) return [{ ...(await inspectBotAdmin(chatId)), botDbId: "env", botLabel: "env", role: "main" }];
  return mapLimit(bots, 3, (b) => inspectBotAdminFor(b, chatId));
}
// Natijalarni kanal yozuviga saqlash uchun ixcham ko'rinish.
function botAdminSnapshot(results, at) {
  const map = {};
  // Faqat HOZIR mavjud botlar. O'chirilgan (yoki boshqa sabab bilan
  // `botsList()` da yo'q) botning eski holati yangi snapshotga tushmaydi.
  const known = new Set(botsList().map((b) => b.id));
  for (const r of results || []) {
    if (!r || !r.botDbId) continue;
    if (r.botDbId !== "env" && !known.has(r.botDbId)) continue;
    map[r.botDbId] = {
      botId: r.botId || 0,
      label: r.botLabel || r.botDbId,
      role: r.role || "",
      status: r.status,
      ok: !!r.ok,
      limited: !!r.limited,
      missing: r.missing || [],
      reason: r.reason || "",
      transient: !!r.transient,
      // Har bir natijaning o'z vaqti (panel STALE belgisini shundan hisoblaydi).
      checkedAt: r.checkedAt || at
    };
  }
  return map;
}
// Administrator bo'lmagan botlar ro'yxati. Faqat DOIMIY salbiy natijalar
// (NOT_ADMIN / BOT_NOT_FOUND) kiradi — API xatosi, yaroqsiz token yoki
// kutilayotgan tekshiruv bu ro'yxatga tushmaydi (spec §3).
function botsMissingAdmin(results) {
  return (results || [])
    .filter((r) => r && !r.ok && !r.transient && BOT_MISSING_STATES.includes(r.status))
    // "chat not found" — kanalning o'zi mavjud emas; botni admin qilish
    // bo'yicha maslahat bu holatda noto'g'ri bo'lardi.
    .filter((r) => !(r.status === CHK.NOT_FOUND && r.reason === "chat_not_found"))
    .map((r) => r.botLabel || r.botDbId);
}
// Freshness: shu vaqtdan eski natija qarorga ta'sir qilmaydi. 60 soniya —
// bitta tekshiruv to'lqinining (15 s timeout × 3 parallel) ustki chegarasi.
var BOT_ADMIN_MAX_AGE_MS = 60e3;
function botAdminResultFresh(r, maxAgeMs, now) {
  const at = Date.parse((r && r.checkedAt) || "");
  if (!Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}
// Kanal bo'yicha umumiy xulosa: kamida bitta VERIFIED_ADMIN bormi va doimiy
// salbiy natija bormi? `null` — xulosa chiqarib bo'lmaydi (faqat API_ERROR).
// ESKI natijalar (checkedAt > maxAgeMs) na `ok`, na `durableNeg` uchun
// ishlatiladi: eski NOT_ADMIN yangi API_ERROR bilan qo'shilib noto'g'ri
// xulosa bermasin.
function botAdminVerdict(results, opts = {}) {
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : BOT_ADMIN_MAX_AGE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const list = (results || []).filter(Boolean);
  const fresh = list.filter((r) => botAdminResultFresh(r, maxAgeMs, now));
  const stale = list.length - fresh.length;
  const ok = fresh.filter((r) => r.ok);
  if (ok.length) return { ok: true, bot: pickAdminBot(fresh), durableNeg: false, fresh, stale };
  const neg = fresh.filter((r) => !r.transient && BOT_DURABLE_NEG.includes(r.status));
  return { ok: false, bot: null, durableNeg: neg.length > 0, negative: neg[0] || null, fresh, stale };
}
// «BITTA BOT YETARLI»: kanalda kamida bitta yoqilgan bot (asosiy yoki ishchi)
// administrator bo'lsa — a'zolikni tekshirish va vazifa berish mumkin.
// Qaysi bot ekani muhim emas; qolganlarining admin emasligi bloklamaydi,
// faqat ma'lumot sifatida saqlanadi va egasiga ogohlantirish beriladi.
// Tanlash tartibi: ayni damda xizmat qilayotgan bot → asosiy bot → birinchi ok.
function pickAdminBot(results, prefer) {
  const list = (results || []).filter((r) => r && r.ok);
  if (!list.length) return null;
  // To'liq huquqli bot qisqartirilgan huquqlidan ustun.
  const full = list.filter((r) => !r.limited);
  const pool = full.length ? full : list;
  const p = prefer || curBot();
  return (
    (p && pool.find((r) => r.botDbId === p.id)) ||
    pool.find((r) => r.role === "main") ||
    pool[0]
  );
}
// Kanalni qo'shayotgan foydalanuvchida boshqaruv huquqi bormi?
async function inspectUserRightsWith(bot, chatId, userId) {
  const r = await tgWith(bot, "getChatMember", { chat_id: chatId, user_id: userId }, 15e3);
  if (!r.ok) {
    const kind = tgFailureKind(r);
    if (kind === "transient") return { status: CHK.API, ok: false, reason: String(r.description || "api"), transient: true };
    if (kind === "no_rights") return { status: CHK.NO_RIGHTS, ok: false, reason: String(r.description || "no_rights") };
    return { status: CHK.NO_USER, ok: false, reason: String(r.description || kind) };
  }
  const st = r.result.status;
  if (st === "creator") return { status: CHK.OK, ok: true, userStatus: st };
  if (st === "administrator") {
    const p = r.result.permissions || null;
    // Administrator bo'lsa ham barcha boshqaruv huquqlari olib qo'yilgan bo'lishi mumkin.
    if (p && p.can_manage_chat === false && p.can_invite_users === false && p.can_post_messages === false && p.can_delete_messages === false) {
      return { status: CHK.NO_USER, ok: false, userStatus: st, reason: "no_management_rights" };
    }
    return { status: CHK.OK, ok: true, userStatus: st, rights: p };
  }
  return { status: CHK.NO_USER, ok: false, userStatus: st, reason: "user_status_" + st };
}
// Foydalanuvchi huquqi ham kanalda ADMIN bo'lgan bot orqali tekshiriladi:
// admin bo'lmagan joriy bot buni o'qiy olmaydi (bitta bot yetarli qoidasi).
async function inspectUserRights(chatId, userId, adminBots) {
  const order = [];
  const add = (b) => {
    if (b && b.token && !order.some((x) => x.id === b.id)) order.push(b);
  };
  for (const r of adminBots || []) {
    if (r && r.ok) add(botsList().find((b) => b.id === r.botDbId));
  }
  add(curBot());
  for (const b of botsForChecks()) add(b);
  let first = null;
  for (const b of order.slice(0, 4)) {
    const res = await inspectUserRightsWith(b, chatId, userId);
    if (res.ok) return res;
    if (!first) first = res;
    if (res.transient) return first;
  }
  // Hech qanday bot javob bermadi — `undefined` qaytarilsa chaqiruvchi
  // `user.ok` da yiqilardi. Xulosa o'rniga aniq API holati qaytaramiz.
  return first || { status: CHK.API, ok: false, reason: "no_bot_available", transient: true };
}
// Kanal manzilini (@username yoki t.me havola) telegram chat obyektiga aylantiradi.
async function resolveChannel(address) {
  const uname = String(address || "").trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9_]{4,}$/.test(uname)) return { status: CHK.NO_CHANNEL, ok: false, reason: "bad_address", username: uname };
  const info = await tg("getChat", { chat_id: "@" + uname }, 15e3);
  if (!info.ok) {
    const kind = tgFailureKind(info);
    if (kind === "transient") return { status: CHK.API, ok: false, reason: String(info.description || "api"), transient: true, username: uname };
    return { status: CHK.NO_CHANNEL, ok: false, reason: kind === "not_found" ? "not_found" : String(info.description || kind), username: uname };
  }
  const ch = info.result;
  if (ch.type !== "channel") return { status: CHK.NO_CHANNEL, ok: false, reason: "not_a_channel", username: uname };
  return { status: CHK.OK, ok: true, chat: ch, username: ch.username || uname };
}
// To'liq tekshiruv: kanal mavjudmi → bot administratormi → huquqlari →
// foydalanuvchida boshqaruv huquqi bormi. Har qadam alohida holat qaytaradi.
async function verifyChannelForOwner(address, userId) {
  const res = await resolveChannel(address);
  if (!res.ok) return res;
  const ch = res.chat;
  // Asosiy va ishchi — BARCHA yoqilgan botlar tekshiriladi: istalgan bot
  // foydalanuvchi so'roviga javob berib, obunani tekshirishi mumkin.
  // Kanalni ulash uchun hal qiluvchi tekshiruv — ASOSIY bot; ishchi botlarning
  // holati ogohlantirish sifatida ko'rsatiladi va buyurtma yaratishda bloklaydi.
  const bots = await inspectAllBotsAdmin(ch.id);
  const main = bots.find((b) => b.role === "main") || bots[0] || null;
  // Kanalni ulash uchun BITTA botning administratorligi yetarli.
  const bot = pickAdminBot(bots);
  if (!bot) {
    // Hech bir bot admin emas. Doimiy salbiy natija bo'lsa — aniq xulosa;
    // aks holda API xatosi/kutilmoqda (xulosa chiqarilmaydi, kanal
    // "admin emas" deb yozilmaydi).
    const verdict = botAdminVerdict(bots);
    const fail = verdict.durableNeg
      ? verdict.negative
      : bots.find((b) => b && b.status === CHK.TOKEN)
        || bots.find((b) => b && b.status === CHK.API)
        || main
        || (await inspectBotAdmin(ch.id));
    return { ...fail, chat: ch, username: res.username, bot: null, bots };
  }
  const user = await inspectUserRights(ch.id, userId, bots);
  if (!user.ok) return { ...user, chat: ch, username: res.username, bot, bots };
  return { status: CHK.OK, ok: true, chat: ch, username: res.username, bot, main, user, bots };
}
// Kanalda KAMIDA BITTA bot administrator bo'lsa `true` (bitta bot yetarli
// qoidasi). Bu "AYNAN SHU bot adminmi" degan savolga javob BERMAYDI — buning
// uchun `inspectBotAdminFor(bot, chatId)` ishlatiladi.
async function anyBotAdmin(chatId) {
  const results = await inspectAllBotsAdmin(chatId);
  return !!pickAdminBot(results);
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
// Yangi foydalanuvchiga kanalini botga ulashni taklif qilamiz: tugma mavjud
// `chadd` oqimini ochadi (botni administrator qilish + manzil yuborish).
function askChannelLink(u, chat) {
  const bonus = Math.max(0, Number(S().creditRewardChannelLink) || 0);
  return send(chat, T(u, "start_ask_channel", {
    btn: T(u, "ch_add"),
    bonus: bonus > 0 ? T(u, "bonus_line", { bonus }) : ""
  }), inline([[{ text: T(u, "ch_add"), callback_data: "chadd" }]]));
}
async function handleMessage(msg) {
  if (msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return;
  const chat = msg.chat.id;
  const text = (msg.text || "").trim();
  const { user: u, isNew } = getUser(msg.from, chat);
  if (u.signupPending) {
    const granted = await grantSignupBonus(u);
    if (granted > 0) console.log(`Yangi foydalanuvchi ${u.telegramId} — +${granted} kredit sovg'a`);
  }
  // Xavfsizlik sahifasida "oxirgi faollik"ni ko'rsatish uchun — soatiga bir marta.
  if (!u.lastSeenAt || String(u.lastSeenAt).slice(0, 13) !== nowStr().slice(0, 13)) u.lastSeenAt = nowStr();
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
      // Birinchi qadam — til tanlash. Til tanlangach (`langnew:<til>`) shu
      // tilda yo'riqnoma va kanal ulash so'rovi yuboriladi.
      await send(chat, T(u, "choose_lang"), inline([
        [{ text: "🇺🇿 O‘zbekcha", callback_data: "langnew:uz" }, { text: "🇷🇺 Русский", callback_data: "langnew:ru" }],
        [{ text: "🇬🇧 English", callback_data: "langnew:en" }]
      ]));
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
    if (st.type === "security") return submitComplaint(u, "Xavfsizlik (shubhali kirish)", text, chat);
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
  if (u.signupPending) await grantSignupBonus(u);
  if (u.status === "blocked") return;
  if (S().isBotPaused && !isAdmin(u.telegramId)) return;
  const [cmd, ...argParts] = String(cq.data || "").split(":");
  const arg = argParts.join(":");
  const key = `${cmd}:${arg}`;
  if (key === "sp:check") {
    if (await sponsorGate(u, chat)) return send(chat, TR(u, "\u2705 Rahmat! Endi botdan foydalanishingiz mumkin."), menuFor(u));
    return;
  }
  if (!await sponsorGate(u, chat)) return;
  switch (cmd) {
    case "tasks": {
      const [plat, mode] = String(arg || "").split(":");
      return showTasks(u, plat === "ig" ? "instagram" : "telegram", chat, mode === "next");
    }
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
    // Bir tugma bilan: barcha mavjud kreditga buyurtma (spec §6 ni tezlashtirish).
    case "ordall": {
      const d = destOf(arg);
      if (!d) return;
      const isTg = arg.startsWith("ch-");
      if (isTg && !channelsOf(u).some((c) => c.id === arg)) return;
      const qty = Math.floor(u.credits.available / Math.max(1, perSub()));
      if (qty < 10) return send(chat, T(u, "ord_all_low", { max: qty }), menuFor(u));
      return prepareOrder(u, arg, Math.min(1e4, qty), chat);
    }
    case "ordok": {
      const sc = u.state;
      if (!sc || sc.type !== "order_confirm") return send(chat, TR(u, "Buyurtma ma\u2019lumoti eskirgan. Qaytadan boshlang: Kanallarim \u2192 kanal \u2192 miqdor."), menuFor(u));
      // Token callback ma'lumotidan olinadi — u majburiy va foydalanuvchiga bog'langan.
      return createOrderConfirmed(u, sc.destId, sc.qty, chat, arg || sc.token);
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
        refunded += (await cancelOrderAdmin(o)).refundCredits || 0;
      }
      // Kanal yozuvi O'CHIRILMAYDI: tarix, a'zoliklar va oxirgi tasdiqlangan
      // obunachilar soni snapshot sifatida saqlanadi (spec §7, §19).
      ch.status = "disconnected";
      ch.disconnectedAt = nowStr();
      ch.lastConfirmedActiveSubscribers = ch.activeSubscribers || 0;
      ch.lastConfirmedVerifiedSubscribers = ch.verifiedSubscribers || 0;
      for (const t of db.tasks) if (t.destinationId === ch.id && OPEN.has(t.status)) t.status = "CANCELLED";
      // Uzilgan kanal uchun yangi monitoring job yaratilmaydi; mavjudlari yopiladi.
      for (const j of db.verificationJobs) {
        if (j.channelId === ch.id && j.status === "PENDING") {
          j.status = "DONE";
          j.completedAt = nowStr();
          j.lockedAt = "";
          j.lastError = "kanal uzilgan";
        }
      }
      for (const m of db.memberships) if (m.channelId === ch.id) m.nextCheckAt = "";
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
      return send(chat, T(u, "cmp_choose"), catBtns());
    case "cmpd": {
      const t = db.tasks.find((x) => x.id === arg && x.assignedTo === u.id);
      u.state = { type: "complaint_pick", destinationId: t ? t.destinationId : null, destinationTitle: t ? t.destinationTitle : null };
      return send(chat, `⚠️ <b>${esc(t ? t.destinationTitle : "—")}</b>\n\n` + T(u, "cmp_choose"), catBtns());
    }
    case "cmpc": {
      const c = catLabel(arg);
      if (!c) return;
      const dst = u.state && u.state.type === "complaint_pick" ? u.state : {};
      u.state = { type: "complaint", category: c, destinationId: dst.destinationId || null, destinationTitle: dst.destinationTitle || null };
      return send(chat, T(u, "cmp_enter", { cat: esc(c) }));
    }
    // "⬅️ Orqaga" tugmasi shu yerga keladi — avval bu case yo'q edi va
    // submenyudan qaytish umuman ishlamasdi.
    case "settings":
      return showSettings(u, chat);
    case "ntall": {
      if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
      const allOn = String(arg) !== "off";
      for (const k of ["subscribers", "referrals", "orders", "technical"]) u.notif[k] = allOn;
      save();
      return showNotifications(u, chat);
    }
    case "setnotif":
      return showNotifications(u, chat);
    case "setsec":
      return showSecurity(u, chat);
    case "setacc":
      return showAccounts(u, chat);
    case "setmain":
      u.state = null;
      save();
      return send(chat, T(u, "set_main_msg"), menuFor(u));
    case "secrep":
      u.state = { type: "security" };
      save();
      return send(chat, T(u, "sec_report_prompt"));
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
      return showNotifications(u, chat);
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
    case "langnew": {
      // Yangi foydalanuvchi tilni tanladi: endi yo'riqnoma va kanal ulash
      // so'rovi tanlangan tilda yuboriladi.
      if (!STR[arg]) return;
      u.language = arg;
      save();
      await send(chat, T(u, "lang_saved"), menuFor(u));
      await send(chat, guideText(u));
      return askChannelLink(u, chat);
    }
    case "nt": {
      if (!u.notif) u.notif = { subscribers: true, referrals: true, orders: true, technical: true };
      if (!(arg in u.notif)) return;
      u.notif[arg] = u.notif[arg] === false;
      save();
      return showNotifications(u, chat);
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
      if (!t || !Number.isFinite(n) || !n) return send(chat, "/addcredits TELEGRAM_ID SON [KALIT]");
      // Uchinchi argument — ixtiyoriy idempotency kaliti (takroriy buyruqning
      // oldini oladi). Berilmasa, buyruq at-least-once bo'lib qoladi.
      const key = args[2] ? `adminadj:tg:${u.telegramId}:${args[2]}` : "";
      // `applyAdminAdjust()` — tuzatish + darhol saqlash; saqlanmasa qaytariladi.
      const adj = await applyAdminAdjust(t, n, `Admin (${u.displayName})`, key);
      if (!adj.ok) {
        if (adj.reason === "save_failed") return send(chat, T(u, "save_err"));
        return send(chat, adj.reason === "insufficient" ? "Balans manfiy bo'lib qoladi — rad etildi." : "Bu kalit allaqachon qo'llangan.");
      }
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
        if (!await anyBotAdmin(info.result.id)) return send(chat, "\u274C Hech bir bot bu kanalda admin emas (obunani tekshirish uchun kerak).");
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
  // Faqat RASMIY tasdiqlangan obunalar hisoblanadi (spec §6.4). O'zi tasdiqlagan
  // Instagram amali (SELF_CONFIRMED) "tekshirilgan obunachi" deb ko'rsatilmaydi.
  const per = {};
  for (const e of db.verifyLog) {
    if (e.at < from || e.at >= to) continue;
    if (e.source === "self") continue;
    ((per[e.ownerId] ||= {})[e.title] ||= { n: 0, platform: e.platform }).n++;
  }
  // Yangi tasdiqlangan obuna bo'lmasa — xabar yuborilmaydi (spec §6.6).
  if (!Object.keys(per).length) return;
  const fmt = (ms) => new Date(ms + 5 * 36e5).toISOString().slice(11, 16);
  for (const [uid, items] of Object.entries(per)) {
    const u = userById(uid);
    if (!u) continue;
    // Idempotentlik: davr yozuvi bazada — restart bo'lsa ham takror yuborilmaydi.
    const pkey = `${uid}:${from}:subscribers`;
    if (db.notifPeriods.some((p) => p.key === pkey)) continue;
    if (!u.notifications || !notifOn(u, "subscribers")) {
      db.notifPeriods.push({ id: nid("np"), key: pkey, userId: uid, periodStart: from, periodEnd: to, notificationType: "subscribers", sentAt: "", status: "skipped" });
      continue;
    }
    db.notifPeriods.push({ id: nid("np"), key: pkey, userId: uid, periodStart: from, periodEnd: to, notificationType: "subscribers", sentAt: nowStr(), status: "sent" });
    u.lastNotifHour = hour;
    const tgN = Object.values(items).filter((i) => i.platform === "telegram").reduce((a, i) => a + i.n, 0);
    const igN = Object.values(items).filter((i) => i.platform === "instagram").reduce((a, i) => a + i.n, 0);
    const head = [tgN ? `\u{1F4E2} Telegram: +${tgN}` : "", igN ? `\u{1F4F8} Instagram: +${igN}` : ""].filter(Boolean).join("\n");
    await notify(u, `\u{1F550} <b>Soatlik hisobot (${fmt(from)} \u2013 ${fmt(to)})</b>

${head}

` + Object.entries(items).map(([t, i]) => `\u2022 ${esc(t)}: +${i.n}`).join("\n"));
  }
}
// ===== 24 soatlik a'zolik tekshiruvi ishchisi =====
// Navbat bazada (verificationJobs). Har bir tikda faqat cheklangan partiya
// olinadi, natija darhol yoziladi, keyingi tekshiruv 24 soat + jitter bilan
// rejalashtiriladi. Jarayon qulasa, navbat bazada qoladi (restart-safe).
var VERIFY_BATCH = Math.max(1, Number(process.env.VERIFY_BATCH) || 25);
// Bitta partiyada bir vaqtda yuboriladigan getChatMember so'rovlari soni.
var VERIFY_CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.VERIFY_CONCURRENCY) || 4));
var VERIFY_LOCK_MS = 10 * 6e4;
function recoverStaleJobs() {
  let n = 0;
  for (const j of db.verificationJobs) {
    if (j.status === "RUNNING" && Date.parse(j.lockedAt || "0") < Date.now() - VERIFY_LOCK_MS) {
      j.status = "PENDING";
      j.lockedAt = "";
      n++;
    }
  }
  return n;
}
async function runVerificationJob(job) {
  const at = () => (/* @__PURE__ */ new Date()).toISOString();
  job.status = "RUNNING";
  job.lockedAt = at();
  const u = userById(job.userId);
  const ch = db.channels.find((c) => c.id === job.channelId);
  const m = db.memberships.find((x) => x.id === job.membershipId) || ensureMembership(job.userId, job.channelId);
  // Kanal uzilgan yoki foydalanuvchi yo'q — monitoring to'xtaydi, tarix qoladi.
  if (!u || !ch || ch.disconnectedAt) {
    job.status = "DONE";
    job.completedAt = at();
    job.lockedAt = "";
    job.lastError = !u ? "foydalanuvchi yo'q" : !ch ? "kanal yo'q" : "kanal uzilgan";
    return "skipped";
  }
  // Diagnostika bilan tekshiramiz: xato sababi umumiy matn bilan
  // almashtirilmaydi, `job.lastError` da haqiqiy Telegram javobi qoladi.
  const info = await checkMemberInfo(ch.channelId, u.telegramId, { channelDbId: ch.id, stage: "recheck", userId: u.id });
  const r = info.result;
  const now = at();
  m.lastCheckedAt = now;
  m.updatedAt = now;
  if (r === "error") {
    // Texnik xato = obunadan chiqish EMAS.
    m.status = m.status === "ACTIVE" ? "ACTIVE" : "CHECK_ERROR";
    m.lastCheckResult = "error";
    m.lastCheckReason = info.reason || TG_ERR.UNKNOWN;
    m.consecutiveCheckErrors = (m.consecutiveCheckErrors || 0) + 1;
    membershipEvent(job.userId, job.channelId, "CHECK_ERROR", m.status, m.status, "recheck", info.reason || "error", "");
    job.attemptCount = (job.attemptCount || 0) + 1;
    job.lastError = `${info.reason || "error"}: ${String(info.description || "").slice(0, 160)}`;
    job.lastErrorCode = info.diag ? info.diag.errorCode : 0;
    job.lastHttpStatus = info.diag ? info.diag.httpStatus : 0;
    // 429 bo'lsa faqat retry_after tugagach, aks holda eksponensial backoff.
    const backoff = retryDelayMs(job.attemptCount, info.retryAfter || 0);
    job.status = "PENDING";
    job.lockedAt = "";
    job.scheduledAt = new Date(Date.now() + backoff).toISOString();
    m.nextCheckAt = job.scheduledAt;
    return "error";
  }
  job.attemptCount = 0;
  job.lastError = "";
  if (r === "member") {
    const oldStatus = m.status;
    const wasInactive = oldStatus !== "ACTIVE";
    // Holat o'zgarmagan muvaffaqiyatli tekshiruv jurnalga yozilmaydi — faqat
    // sanalar va hisoblagich yangilanadi (aks holda 1000 foydalanuvchida
    // yiliga ~365k yozuv to'planadi).
    const hadErrors = (m.consecutiveCheckErrors || 0) > 0;
    m.status = "ACTIVE";
    m.lastCheckResult = "member";
    m.lastHealthyCheckAt = now;
    m.consecutiveCheckErrors = 0;
    m.healthyCheckCount = (m.healthyCheckCount || 0) + 1;
    if (!m.firstVerifiedAt) m.firstVerifiedAt = now;
    if (wasInactive) {
      m.lastMembershipChangeAt = now;
      membershipEvent(job.userId, job.channelId, "REJOINED", oldStatus, "ACTIVE", "recheck", "member", "");
      markRejoined(job.userId, job.channelId);
    } else if (hadErrors) {
      // Xatodan keyin tiklanish — bu haqiqiy holat o'zgarishi, yoziladi.
      membershipEvent(job.userId, job.channelId, "RECHECK_ACTIVE", "ACTIVE", "ACTIVE", "recheck", "member", "");
    }
  } else {
    const old = m.status;
    m.status = "CANCELLED";
    m.lastCheckResult = "not_member";
    m.consecutiveCheckErrors = 0;
    if (old !== "CANCELLED") {
      m.lastMembershipChangeAt = now;
      membershipEvent(job.userId, job.channelId, "UNSUBSCRIBED", old, "CANCELLED", "recheck", "not_member", "");
      markUnsubscribed(job.userId, job.channelId);
    }
  }
  job.status = "DONE";
  job.completedAt = at();
  job.lockedAt = "";
  // Keyingi tekshiruv: 24 soat + jitter (navbatga yangi job).
  scheduleMembershipCheck(m, Date.now() + memRecheckDelay());
  return r;
}
// Saqlangan vazifa tekshiruvi: vaqtincha xato olgan vazifa navbatdan
// avtomatik qayta tekshiriladi. Mukofot faqat Telegram a'zolikni tasdiqlaganda
// beriladi va takroriy berilmaydi.
async function runTaskCheckJob(job) {
  const at = () => (/* @__PURE__ */ new Date()).toISOString();
  job.status = "RUNNING";
  job.lockedAt = at();
  const done = (why) => {
    job.status = "DONE";
    job.completedAt = at();
    job.lockedAt = "";
    job.lastError = why || "";
    return why || "done";
  };
  const t = db.tasks.find((x) => x.id === job.taskId);
  const u = t ? userById(t.assignedTo) : null;
  if (!t || !u) return done("vazifa yoki foydalanuvchi yo'q");
  if (!OPEN.has(t.status)) return done("vazifa allaqachon yopilgan");
  const dest = destOf(t.destinationId);
  if (!dest || !dest.channelId || dest.disconnectedAt || (dest.status && dest.status !== "active")) {
    // Kanal yaroqsiz (huquq yo'qolgan / uzilgan) — vazifa bekor qilinadi,
    // tarix o'chmaydi va CHECK_ERROR da osilib qolmaydi.
    t.status = "CANCELLED";
    t.cancelReason = "channel_unavailable";
    save();
    return done("kanal mavjud emas");
  }
  const info = await checkMemberInfo(dest.channelId, u.telegramId, {
    taskId: t.id,
    orderId: t.orderId,
    channelDbId: dest.id,
    stage: "task_retry"
  });
  t.checkedAt = at();
  if (info.result === "member") {
    // Mukofot pul amali: butun mutatsiya INSTANSLARARO qulf ostida — holat
    // qayta o'qiladi, shuning uchun parallel (boshqa instansdagi) tasdiqlash
    // yoki takroriy job dublikat mukofot bermaydi.
    const jobRes = await withStateTx(async () => {
    const endOp = opStart("job");
    const snapJ = verifyRollbackSnapshot(u, [t]);
    const notices = [];
    // Takroriy mukofot yo'q: applyVerified faqat hali tasdiqlanmagan vazifaga.
    let got = 0;
    if (t.status !== "VERIFIED" && t.status !== "SELF_CONFIRMED") got = applyVerified(u, t);
    // Referal malakasi: job yo'lida ham HAQIQIY `getChatMember` tasdig'i
    // hisoblanadi (bir marta — `bonusIssued`/idempotency himoyasi).
    if (got > 0 && t.platform === "telegram") await tryQualifyReferral(u, { defer: notices, noSave: true });
    t.consecutiveCheckErrors = 0;
    t.retryAt = "";
    t.lastCheckError = null;
    t.lastCheckResult = "member";
    endOp();
    if (got > 0) {
      const saved = await withSaveLock(async () => {
        if (await flushSaveAwaited()) return true;
        verifyRollbackApply(snapJ, u);
        return false;
      });
      if (!saved) return { saved: false, notices: [] };
    }
    save();
    return { saved: true, notices };
    });
    const jr = jobRes.ok && jobRes.value ? jobRes.value : { saved: false, notices: [] };
    if (!jr.saved) {
      job.status = "PENDING";
      job.lockedAt = "";
      job.attemptCount = (job.attemptCount || 0) + 1;
      job.lastError = "save_failed";
      job.scheduledAt = new Date(Date.now() + retryDelayMs(job.attemptCount)).toISOString();
      console.error(`TASK_CHECK (${job.id}): saqlanmadi — mukofot qaytarildi, job qayta rejalashtirildi`);
      save();
      return "save_failed";
    }
    for (const n of jr.notices) n();
    return done("");
  }
  if (info.result === "not_member") {
    // Obuna yo'q — vazifa FIFO navbatiga qaytadi (bu obunadan chiqish emas).
    t.status = "PENDING";
    t.isDeferred = true;
    t.consecutiveCheckErrors = 0;
    t.retryAt = "";
    t.lastCheckError = null;
    t.lastCheckResult = "not_member";
    save();
    return done("");
  }
  // Xato: haqiqiy sabab saqlanadi va backoff bilan qayta rejalashtiriladi.
  t.consecutiveCheckErrors = (t.consecutiveCheckErrors || 0) + 1;
  t.lastCheckReason = info.reason || TG_ERR.UNKNOWN;
  t.lastCheckResult = "error";
  if (info.diag) {
    t.lastCheckError = {
      errorCode: info.diag.errorCode,
      description: info.diag.description,
      httpStatus: info.diag.httpStatus,
      retryAfter: info.diag.retryAfter,
      errKind: info.diag.errKind,
      at: info.diag.ts
    };
  }
  const delay = retryDelayMs(t.consecutiveCheckErrors, info.retryAfter || 0);
  t.retryAt = new Date(Date.now() + delay).toISOString();
  job.attemptCount = (job.attemptCount || 0) + 1;
  job.lastError = `${info.reason || "error"}: ${String(info.description || "").slice(0, 160)}`;
  job.lastErrorCode = info.diag ? info.diag.errorCode : 0;
  job.lastHttpStatus = info.diag ? info.diag.httpStatus : 0;
  job.status = "PENDING";
  job.lockedAt = "";
  job.scheduledAt = new Date(Date.now() + delay).toISOString();
  save();
  return "error";
}
// Jobni faqat hali PENDING va muddati kelgan bo'lsa o'zlashtiramiz. Ikki
// jarayon bir vaqtda bir jobni olmasligi uchun qo'shimcha himoya (asosiy
// himoya — scheduler qulfi).
function claimJob(job) {
  const fresh = db.verificationJobs.find((j) => j.id === job.id);
  if (!fresh) return false;
  if (fresh.status !== "PENDING") return false;
  if (Date.parse(fresh.scheduledAt || "0") > Date.now()) return false;
  fresh.status = "RUNNING";
  fresh.lockedAt = new Date().toISOString();
  Object.assign(job, fresh);
  return true;
}
var MAINTENANCE_BUSY = false;
// Cheklangan partiya. Scheduler qulfi bir vaqtda faqat bitta jarayonda
// ishlashini kafolatlaydi (ikkinchi instans darhol 0 qaytaradi).
async function processVerificationJobs(limit = VERIFY_BATCH) {
  if (!await tryLock("scheduler")) return 0;
  try {
    const now = Date.now();
    const due = db.verificationJobs
      .filter((j) => j.status === "PENDING" && Date.parse(j.scheduledAt || "0") <= now)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
      .slice(0, limit);
    if (!due.length) return 0;
    let done = 0;
    for (const job of due) {
      if (!claimJob(job)) continue;
      try {
        if (job.jobType === "TASK_CHECK") await runTaskCheckJob(job);
        else await runVerificationJob(job);
        done++;
      } catch (e) {
        job.status = "PENDING";
        job.lockedAt = "";
        job.attemptCount = (job.attemptCount || 0) + 1;
        job.lastError = String(e && e.message || e).slice(0, 160);
        job.scheduledAt = new Date(Date.now() + retryDelayMs(job.attemptCount)).toISOString();
        console.error("A'zolik tekshiruvi xatosi:", job.lastError);
      }
      await new Promise((res) => setTimeout(res, 120));
    }
    save();
    return done;
  } finally {
    await releaseLock("scheduler");
  }
}
// (user_id, channel_id) juftligi bo'yicha yagona yozuv kafolatlanadi (spec §4).
// Eski ma'lumotda takror yozuv paydo bo'lgan bo'lsa — birlashtiriladi, tarix
// (events) o'chirilmaydi, ochiq joblar qolgan yozuvga bog'lanadi.
function dedupeMemberships() {
  const keepByPair = /* @__PURE__ */ new Map();
  const drop = /* @__PURE__ */ new Set();
  for (const m of db.memberships) {
    const k = m.userId + "|" + m.channelId;
    const keep = keepByPair.get(k);
    if (!keep) {
      keepByPair.set(k, m);
      continue;
    }
    if (m.status === "ACTIVE" && keep.status !== "ACTIVE") {
      keep.status = "ACTIVE";
      keep.lastCheckResult = m.lastCheckResult || keep.lastCheckResult;
    }
    keep.firstVerifiedAt = [keep.firstVerifiedAt, m.firstVerifiedAt].filter(Boolean).sort()[0] || "";
    keep.firstSeenAt = [keep.firstSeenAt, m.firstSeenAt].filter(Boolean).sort()[0] || "";
    keep.lastCheckedAt = [keep.lastCheckedAt, m.lastCheckedAt].filter(Boolean).sort().pop() || "";
    keep.lastMembershipChangeAt = [keep.lastMembershipChangeAt, m.lastMembershipChangeAt].filter(Boolean).sort().pop() || "";
    keep.nextCheckAt = keep.nextCheckAt || m.nextCheckAt || "";
    keep.consecutiveCheckErrors = Math.max(keep.consecutiveCheckErrors || 0, m.consecutiveCheckErrors || 0);
    for (const j of db.verificationJobs) if (j.membershipId === m.id) j.membershipId = keep.id;
    drop.add(m.id);
  }
  if (!drop.size) return 0;
  db.memberships = db.memberships.filter((m) => !drop.has(m.id));
  console.log(`A'zolik registridagi ${drop.size} ta takror yozuv birlashtirildi`);
  return drop.size;
}
// Mavjud (avval tasdiqlangan) a'zoliklar uchun registrni to'ldirish — eski
// ma'lumot yo'qolmaydi, keyingi tekshiruv navbatga qo'yiladi.
function migrateMemberships() {
  dedupeMemberships();
  let n = 0;
  const seen = /* @__PURE__ */ new Set();
  for (const t of db.tasks) {
    if (t.platform !== "telegram" || t.status !== "VERIFIED" || !t.destinationId) continue;
    const k = t.assignedTo + "|" + t.destinationId;
    if (seen.has(k)) continue;
    seen.add(k);
    const m = ensureMembership(t.assignedTo, t.destinationId);
    if (!m.firstVerifiedAt) {
      m.status = "ACTIVE";
      m.firstVerifiedAt = t.verifiedAt || (/* @__PURE__ */ new Date()).toISOString();
      m.lastCheckedAt = m.lastCheckedAt || t.checkedAt || "";
      m.lastCheckResult = "member";
      m.lastMembershipChangeAt = m.firstVerifiedAt;
      membershipEvent(t.assignedTo, t.destinationId, "FIRST_VERIFIED", "", "ACTIVE", "migration", "member", t.id);
      n++;
    }
    // Boshlang'ich tekshiruvlar bir kunga taqsimlanadi (bir vaqtda bosilmasin).
    if (!m.nextCheckAt) scheduleMembershipCheck(m, Date.now() + Math.floor(Math.random() * 24 * 36e5));
  }
  if (n) console.log(`A'zolik registriga ${n} ta eski obuna ko'chirildi`);
}
// Kanalda bot huquqi yo'qolgani ANIQLANDI — yangi vazifa berilmaydi, ochiq
// vazifalar yopiladi, egasiga bir marta xabar boradi (spec §1.9).
// Tarix (vazifalar, a'zoliklar, buyurtmalar) o'chirilmaydi.
function markChannelPermissionLost(dest, reason, checkedAt) {
  if (!dest || !dest.channelId) return false;
  const wasLost = dest.status === "permission_lost" && dest.botHasAdminRights === false;
  const at = checkedAt || new Date().toISOString();
  dest.botHasAdminRights = false;
  dest.botAdminStatus = reason === "no_rights" ? CHK.NO_RIGHTS
    : reason === "bot_not_found" ? CHK.NOT_FOUND
    : CHK.NO_BOT;
  dest.status = "permission_lost";
  dest.permissionLostAt = dest.permissionLostAt || nowStr();
  // Audit: qaror sababi va tekshiruv vaqti kanal yozuvida saqlanadi.
  dest.permissionLostReason = String(reason || "");
  dest.permissionLostCheckedAt = at;
  if (!wasLost) auditSys("channel_permission_lost", dest.id, `reason=${dest.permissionLostReason} checkedAt=${at}`);
  for (const t of db.tasks) {
    if (t.destinationId === dest.id && OPEN.has(t.status)) {
      t.status = "CANCELLED";
      t.cancelReason = "channel_permission_lost";
    }
  }
  if (!wasLost && !dest.permissionNotifiedAt) {
    dest.permissionNotifiedAt = nowStr();
    const owner = userById(dest.ownerId);
    if (owner && notifOn(owner, "technical")) notify(owner, T(owner, "ch_admin_lost_msg", { title: esc(dest.title) }));
  }
  return true;
}
// Kanal huquqlarini davriy tekshirish: cheklangan partiya, tarqatilgan holda.
// Har bir kanal 6 soatda ko'pi bilan bir marta tekshiriladi — 1000 kanal bo'lsa
// ham Telegram'ga yuklama tushmaydi (spec §8).
var CH_ADMIN_SWEEP_HOURS = 6;
var CH_ADMIN_SWEEP_BATCH = 5;
async function channelHealthSweep(opts) {
  // Sweep uchun ALOHIDA advisory qulf (`gxb:sweep`). U `gxb:scheduler`,
  // `gxb:state`, `gxb:poll:*` kalitlari bilan to'qnashmaydi. Qulfni olmagan
  // instans darhol 0 qaytaradi — parallel sweep va ikki marta Telegram
  // so'rovi bo'lmaydi. Qulf `finally` da bo'shatiladi (crashda sessiya
  // uzilishi bilan avtomatik tushadi).
  if (!await tryLock("sweep")) return 0;
  try {
  // `force` — operator qo'lda qayta tekshirishni so'radi (6 soatlik navbatni
  // kutmasdan). `channelId` — faqat bitta kanal (ichki id). Ikkalasi ham
  // ixtiyoriy; sukut bo'yicha odatdagi tarqatilgan tekshiruv ishlaydi.
  const force = !!(opts && opts.force);
  const only = String((opts && opts.channelId) || "");
  const now = Date.now();
  const due = db.channels
    .filter((c) => !c.disconnectedAt && c.channelId)
    .filter((c) => !only || c.id === only)
    .filter((c) => force || !c.lastAdminCheckAt || now - (Date.parse(c.lastAdminCheckAt) || 0) > CH_ADMIN_SWEEP_HOURS * 36e5)
    .sort((a, b) => (Date.parse(a.lastAdminCheckAt || 0) || 0) - (Date.parse(b.lastAdminCheckAt || 0) || 0));
  if (!due.length) return 0;
  let checked = 0;
  for (const ch of due.slice(0, CH_ADMIN_SWEEP_BATCH)) {
    // Asosiy + ishchi botlar — barchasi o'z tokeni bilan tekshiriladi.
    const at = new Date().toISOString();
    const bots = await inspectAllBotsAdmin(ch.channelId);
    ch.botAdmins = botAdminSnapshot(bots, at);
    // Freshness guard: 60 s dan eski natija na `ok`, na salbiy xulosaga
    // kirmaydi.
    const verdict = botAdminVerdict(bots);
    const chosen = verdict.bot;
    ch.lastAdminCheckAt = at;
    // Holatni faqat ANIQ natija bo'lganda yangilaymiz: API xatosi eski
    // tasdiqlangan holatni (masalan `ok`) o'chirib tashlamaydi.
    if (chosen) ch.botAdminStatus = chosen.status;
    // Bitta bot yetarli: kanal ishlayapti, qolgan botlar haqida egasiga bir
    // marta ma'lumot beriladi (kanal yopilmaydi).
    const miss = botsMissingAdmin(bots);
    ch.botsMissingAdmin = miss;
    const missKey = miss.join(",");
    if (miss.length && chosen && ch.botsMissingNotifiedFor !== missKey) {
      ch.botsMissingNotifiedFor = missKey;
      const owner = userById(ch.ownerId);
      if (owner && notifOn(owner, "technical")) notify(owner, T(owner, "ch_bots_missing", { bots: esc(miss.join(", ")) }));
    } else if (!miss.length) {
      ch.botsMissingNotifiedFor = "";
    }
    checked++;
    if (chosen) {
      const wasLost = ch.status === "permission_lost";
      ch.botHasAdminRights = true;
      ch.botAdminBotId = chosen.botDbId;
      ch.botRightsLimited = !!chosen.limited;
      if (wasLost) {
        ch.status = "active";
        ch.permissionLostAt = "";
        ch.permissionNotifiedAt = "";
        const owner = userById(ch.ownerId);
        if (owner && notifOn(owner, "technical")) notify(owner, T(owner, "ch_admin_restored_msg", { title: esc(ch.title) }));
      }
      continue;
    }
    // Hech bir bot VERIFIED_ADMIN emas. Xulosa FAQAT kamida bitta doimiy salbiy
    // natija (NOT_ADMIN / BOT_NOT_FOUND) bo'lsa chiqariladi. Bitta botning
    // API xatosi boshqa botlarning haqiqiy natijasini yashirmaydi (spec §4):
    // masalan, 1 bot API_ERROR + 2 bot NOT_ADMIN → kanal `permission_lost`.
    if (!verdict.durableNeg) {
      // Xulosa yo'q (API_ERROR/timeout/network/kutilmoqda). Faqat bitta aniq
      // holat — BARCHA botlarning tokeni yaroqsiz — operatorga ko'rinadigan
      // qilib yoziladi; kanal holati o'zgarmaydi.
      const fresh = verdict.fresh || [];
      if (fresh.length && fresh.every((r) => !r.ok && r.status === CHK.TOKEN)) {
        ch.botAdminStatus = CHK.TOKEN;
      }
      continue; // holat o'zgarmaydi
    }
    const neg = verdict.negative || {};
    markChannelPermissionLost(ch, neg.status === CHK.NOT_FOUND ? "bot_not_found" : "no_admin", at);
  }
  if (checked) save();
  return checked;
  } finally {
    await releaseLock("sweep");
  }
}
// Saqlanadigan jurnallar chegarasi. `app_state` — BITTA JSONB hujjat: massiv
// cheksiz o'ssa, HAR saqlash shu kattalikni yuboradi. Eng yangi yozuvlar
// qoladi, eng eskilari olib tashlanadi (`splice` — havola uzilmaydi).
var LOG_CAPS = { transactions: 5e4, verifyLog: 5e3, verifyErrors: 2e3, membershipEvents: 5e3, notifPeriods: 2e3, auditLog: 2e3 };
function trimLogs() {
  let removed = 0;
  for (const key of Object.keys(LOG_CAPS)) {
    const arr = db[key];
    const cap = LOG_CAPS[key];
    if (!Array.isArray(arr) || arr.length <= cap) continue;
    const extra = arr.length - cap;
    arr.splice(0, extra);
    removed += extra;
    console.warn(`${key}: ${extra} ta eski yozuv chegaradan (${cap}) oshgani uchun olib tashlandi`);
  }
  return removed;
}
async function maintenance() {
  // Bir jarayonda ikkita tik ustma-ust tushmasin (uzun ishlagan tik + interval).
  if (MAINTENANCE_BUSY) return 0;
  MAINTENANCE_BUSY = true;
  try {
    const cutoff = Date.now() - 48 * 36e5;
    let changed = 0;
    for (const t of db.tasks) if (OPEN.has(t.status) && Date.parse(t.createdAt) < cutoff) { t.status = "CANCELLED"; changed++; }
    changed += recoverStaleJobs();
    changed += trimLogs();
    await processVerificationJobs();
    await channelHealthSweep();
    // processVerificationJobs/channelHealthSweep o'zgarish bo'lsa o'zi save()
    // qiladi. Bu yerda har 2 daqiqada to'liq holatni behuda qayta yozmaymiz.
    if (changed) save();
  } finally {
    MAINTENANCE_BUSY = false;
  }
}
// Har bir bot o'z long-polling tsiklini yuradi, lekin hammasi bitta db'ga yozadi.
var botRuns = /* @__PURE__ */ new Map();
// Har bir bot uchun ushlab turgan polling qulfi kaliti.
var botLocks = /* @__PURE__ */ new Map();
// Faol long-poll so'rovini bekor qilish uchun (SIGTERM paytida muhim).
var botAborts = /* @__PURE__ */ new Map();
// Polling tsikllarining promise'i — qulf bo'shatishdan oldin tugashini kutamiz.
var botLoops = /* @__PURE__ */ new Map();
async function pollLoop(bot, token) {
  const ac = botAborts.get(bot.id);
  const signal = ac ? ac.signal : null;
  for (; ; ) {
    // 1) Bekor qilingan bo'lsa — yangi getUpdates REJALASHTIRILMAYDI.
    if (botRuns.get(bot.id) !== token || (signal && signal.aborted)) return "stopped";
    // 2) So'rov abort signali bilan yuboriladi — SIGTERM paytida darhol uziladi.
    const r = await tgWith(bot, "getUpdates", { offset: bot.offset || 0, timeout: 30, allowed_updates: ["message", "callback_query"] }, 45e3, signal);
    // 3) Abort natijasi xato sifatida logga yozilmaydi.
    if (r.aborted || (signal && signal.aborted)) return "stopped";
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
    // Bo'sh long-poll natijasi (odatiy holat) hech narsani o'zgartirmaydi —
    // to'liq holatni Postgres'ga qayta yozish faqat trafikni yoqardi.
    if (r.result.length) save();
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
  // Basic header ham login himoyasidan o'tadi: aks holda parolni cheksiz
  // sinash mumkin bo'lardi (faqat /login cheklangan edi).
  const ip = clientIp(req);
  if (loginGate(ip, "").blocked) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    loginOk(ip, "");
    req.auth = { username: "admin", role: "owner", exp: Date.now() + SESSION_TTL };
    return true;
  }
  loginFail(ip, "");
  audit({ auth: { username: "anonim", role: "guest" }, headers: { "x-forwarded-for": ip } }, "login_failed", "basic");
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
// Login himoyasi: har bir hisob (email/login) va har bir IP alohida hisoblanadi.
// Hisoblagich bazaga yoziladi — servis qayta ishga tushsa ham blok saqlanadi.
var LOGIN_WINDOW = 15 * 6e4;
var LOGIN_MAX_USER = 6; // bitta hisob uchun 15 daqiqada
var LOGIN_MAX_IP = 30; // bitta IP uchun (bitta tarmoq ortidagi bir necha kishi uchun zaxira)
function loginGuard() {
  if (!db.loginGuard || typeof db.loginGuard !== "object") db.loginGuard = { users: {}, ips: {} };
  if (!db.loginGuard.users) db.loginGuard.users = {};
  if (!db.loginGuard.ips) db.loginGuard.ips = {};
  return db.loginGuard;
}
function guardState(bucket, key, limit) {
  const now = Date.now();
  const map = loginGuard()[bucket];
  const e = map[key];
  if (!e || !Number.isFinite(e.first) || now - e.first > LOGIN_WINDOW) {
    if (e) delete map[key];
    return { blocked: false, left: limit };
  }
  if (e.n >= limit) return { blocked: true, minutesLeft: Math.max(1, Math.ceil((LOGIN_WINDOW - (now - e.first)) / 6e4)) };
  return { blocked: false, left: Math.max(0, limit - e.n) };
}
function guardTouch(bucket, key, limit) {
  const now = Date.now();
  const map = loginGuard()[bucket];
  const e = map[key];
  if (!e || !Number.isFinite(e.first) || now - e.first > LOGIN_WINDOW) map[key] = { n: 1, first: now };
  else e.n++;
  return Math.min(map[key].n, limit);
}
function guardPrune() {
  const now = Date.now();
  for (const bucket of ["users", "ips"]) {
    const map = loginGuard()[bucket];
    for (const k of Object.keys(map)) {
      if (!Number.isFinite(map[k].first) || now - map[k].first > LOGIN_WINDOW) delete map[k];
    }
    const rest = Object.keys(map);
    if (rest.length > 400) for (const k of rest.slice(0, rest.length - 400)) delete map[k];
  }
}
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xf && /^[0-9a-fA-F:.]+$/.test(xf)) return xf;
  return (req.socket && req.socket.remoteAddress) || "anonim";
}
// Hisob bloki ustuvor; IP bloki faqat ko'p hisob bilan urinilganda ishlaydi.
function loginGate(ip, login) {
  const byUser = login ? guardState("users", login, LOGIN_MAX_USER) : { blocked: false, left: LOGIN_MAX_USER };
  if (byUser.blocked) return { blocked: true, minutesLeft: byUser.minutesLeft, scope: "user", left: 0 };
  const byIp = guardState("ips", ip, LOGIN_MAX_IP);
  if (byIp.blocked) return { blocked: true, minutesLeft: byIp.minutesLeft, scope: "ip", left: 0 };
  return { blocked: false, scope: "", left: byUser.left };
}
function loginFail(ip, login) {
  const ipN = guardTouch("ips", ip, LOGIN_MAX_IP);
  const userN = login ? guardTouch("users", login, LOGIN_MAX_USER) : 0;
  guardPrune();
  flushSave();
  return {
    userLeft: login ? Math.max(0, LOGIN_MAX_USER - userN) : LOGIN_MAX_USER,
    ipLeft: Math.max(0, LOGIN_MAX_IP - ipN),
    blocked: (login && userN >= LOGIN_MAX_USER) || ipN >= LOGIN_MAX_IP
  };
}
function loginOk(ip, login) {
  const g = loginGuard();
  if (login && g.users[login]) delete g.users[login];
  // Muvaffaqiyatli kirish IP blokini butunlay ochmaydi — faqat bittaga kamaytiradi.
  if (g.ips[ip] && g.ips[ip].n > 0) g.ips[ip].n = Math.max(0, g.ips[ip].n - 1);
  guardPrune();
  flushSave();
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
// Botning kanallardagi administratorlik holati (panel uchun). Har bir kanal
// uchun `botAdmins[id]` snapshot'i saqlanadi — shu yerdan yig'amiz.
function botAdminSummary(botId) {
  const out = {
    adminStatus: "",
    adminReason: "",
    adminLastCheckAt: "",
    adminChannels: 0,
    adminCheckedChannels: 0,
    adminNeedsAttention: false,
    adminStale: false
  };
  for (const c of db.channels || []) {
    const a = c.botAdmins && c.botAdmins[botId];
    if (!a) continue;
    out.adminCheckedChannels++;
    if (a.ok) out.adminChannels++;
    const at = String(a.checkedAt || "");
    if (!out.adminLastCheckAt || at >= out.adminLastCheckAt) {
      out.adminLastCheckAt = at;
      out.adminStatus = a.status || "";
      out.adminReason = a.reason || "";
    }
  }
  // Token/kutilmoqda holati operatorning e'tiborini talab qiladi; "admin emas"
  // esa oddiy kanal holati — alohida ko'rsatiladi.
  out.adminNeedsAttention = [CHK.TOKEN, CHK.PENDING].includes(out.adminStatus) && out.adminChannels === 0;
  // STALE: oxirgi tekshiruv 2 ta sweep oynasidan (12 soat) eski — natija
  // joriy holatni aks ettirmasligi mumkin.
  const staleMs = CH_ADMIN_SWEEP_HOURS * 2 * 36e5;
  const atMs = Date.parse(out.adminLastCheckAt || "");
  out.adminStale = Number.isFinite(atMs) && Date.now() - atMs > staleMs;
  return out;
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
    createdAt: b.createdAt || "",
    ...botAdminSummary(b.id)
  };
}
async function cancelOrderAdmin(o) {
  // Instanslararo kritik bo'lim: `o` va egasining balansi qulf ostida qayta
  // o'qiladi, takroriy qaytim tekshiruvi eng so'nggi jurnal bo'yicha bajariladi.
  const txRes = await withStateTx(async () => {
  if (!o || o.status !== "active") return { ok: false, reason: "already_closed", refundCredits: 0, refundableUnits: 0 };
  const owner = userById(o.userId);
  const { refundableUnits, refundCredits } = calculateRefundAmount(o);
  const refundKey = `refund:${o.id}`;
  // Takroriy qaytim: shu buyurtma uchun jurnal yozuvi bor bo'lsa balans
  // o'zgartirilmaydi (idempotency kaliti — yagona haqiqat manbai).
  if (refundCredits > 0 && db.transactions.some((t) => t.idempotencyKey === refundKey)) {
    auditSys("refund_rejected", o.id, "already_refunded");
    return { ok: false, reason: "duplicate", refundCredits: 0, refundableUnits: 0 };
  }
  // `reserved` yetarliligini tekshirish. `Math.max(0, ...)` bilan yashirish
  // taqiqlanadi: yetmayotgan bo'lsa amal rad etiladi va hech narsa o'zgarmaydi.
  if (owner && refundCredits > 0 && Number(owner.credits.reserved) + 1e-9 < refundCredits) {
    auditSys("refund_rejected", o.id, `reserved_insufficient reserved=${owner.credits.reserved} required=${refundCredits}`);
    console.error(`Qaytim rad etildi (${o.id}): reserved ${owner.credits.reserved} < refund ${refundCredits}`);
    return { ok: false, reason: "reserved_insufficient", refundCredits: 0, refundableUnits: 0, reserved: owner.credits.reserved, required: refundCredits };
  }
  const endOp = opStart("arefund");
  const snap = owner ? creditsSnapshot(owner) : null;
  const before = {
    status: o.status,
    cancelledQuantity: Number(o.cancelledQuantity) || 0,
    pendingQuantity: Number(o.pendingQuantity) || 0,
    completedAt: o.completedAt || "",
    activeOrders: owner ? Number(owner.activeOrdersCount) || 0 : 0
  };
  const dest = destOf(o.destinationId);
  const destBefore = dest ? { pendingSubscriptions: dest.pendingSubscriptions, pendingFollowers: dest.pendingFollowers } : null;
  const touched = db.tasks.filter((t) => t.orderId === o.id && OPEN.has(t.status)).map((t) => t.id);
  o.cancelledQuantity = before.cancelledQuantity + refundableUnits;
  o.pendingQuantity = 0;
  o.status = "cancelled";
  o.completedAt = nowStr();
  if (owner) {
    owner.credits.reserved -= refundCredits;
    owner.credits.available += refundCredits;
    owner.credits.refunded += refundCredits;
    owner.activeOrdersCount = Math.max(0, before.activeOrders - 1);
    if (refundCredits > 0)
      addTx(owner, refundCredits, "order_refund", `Admin bekor qildi: ${o.destinationTitle}`, { orderId: o.id, idempotencyKey: refundKey });
  }
  for (const t of db.tasks) if (touched.includes(t.id)) t.status = "CANCELLED";
  if (dest) {
    if (dest.pendingSubscriptions !== void 0) dest.pendingSubscriptions = Math.max(0, dest.pendingSubscriptions - refundableUnits);
    if (dest.pendingFollowers !== void 0) dest.pendingFollowers = Math.max(0, dest.pendingFollowers - refundableUnits);
  }
  endOp();
  // Pul amali — xabardan OLDIN darhol saqlanadi. Saqlanmasa hammasi qaytariladi.
  if (!(await flushOrRollback(() => {
    o.status = before.status;
    o.cancelledQuantity = before.cancelledQuantity;
    o.pendingQuantity = before.pendingQuantity;
    o.completedAt = before.completedAt;
    if (owner) {
      creditsRestore(owner, snap);
      owner.activeOrdersCount = before.activeOrders;
    }
    if (dest && destBefore) {
      dest.pendingSubscriptions = destBefore.pendingSubscriptions;
      dest.pendingFollowers = destBefore.pendingFollowers;
    }
    for (const t of db.tasks) if (touched.includes(t.id)) t.status = "PENDING";
  }))) {
    auditSys("refund_save_failed", o.id, "rolled_back");
    return { ok: false, reason: "save_failed", refundCredits: 0, refundableUnits: 0 };
  }
  return { ok: true, refundCredits, refundableUnits, title: o.destinationTitle };
  });
  const res = txRes.ok && txRes.value ? txRes.value : { ok: false, reason: "save_failed", refundCredits: 0, refundableUnits: 0 };
  const resOwner = res.ok ? userById(o.userId) : null;
  if (!res.ok) return res;
  if (resOwner)
    notify(resOwner, `\u21A9\uFE0F Buyurtmangiz admin tomonidan bekor qilindi.\n${esc(res.title)}\n${res.refundableUnits} ta uchun <b>${res.refundCredits}</b> kredit qaytarildi.`);
  return { ok: true, refundCredits: res.refundCredits, refundableUnits: res.refundableUnits };
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
    const items = [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, 10);
    const out = items.map((it) => {
      const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
      const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      return {
        title: title.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim(),
        link: link.trim()
      };
    }).filter((x) => x.title);
    if (out.length) return out;
    // Eski RSS tuzilishi uchun zaxira yo'l
    const titles = [...t.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)].map((m) => m[1]).slice(1);
    return titles.map((x) => ({ title: x.replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim(), link: "" })).filter((x) => x.title).slice(0, 10);
  } catch (e) {
    console.error("News bot: RSS xatosi ->", e.message);
    return [];
  }
}
// Mavzuga mos rasm (Unsplash, barqaror havolalar). Google News havolalari
// ochiq og:image bermaydi, shuning uchun mavzu bo'yicha tanlanadi.
var NEWS_IMAGES = {
  security: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=1280&q=80&fm=jpg",
  ai: "https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1280&q=80&fm=jpg",
  mobile: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=1280&q=80&fm=jpg",
  chip: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1280&q=80&fm=jpg",
  space: "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=1280&q=80&fm=jpg",
  robot: "https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=1280&q=80&fm=jpg",
  code: "https://images.unsplash.com/photo-1461749280684-dccba630e2f6?w=1280&q=80&fm=jpg"
};
function newsImageFor(parsed) {
  const t = [parsed.title, (parsed.tags || []).join(" "), (parsed.paragraphs || []).join(" ")].join(" ").toLowerCase();
  if (/kiber|xavfsiz|security|hack|virus|shifr/.test(t)) return NEWS_IMAGES.security;
  if (/robot/.test(t)) return NEWS_IMAGES.robot;
  if (/\bai\b|sun.?iy intellekt|gpt|openai|gemini|neyron|neural|model/.test(t)) return NEWS_IMAGES.ai;
  if (/chip|protsessor|nvidia|intel|amd|gpu/.test(t)) return NEWS_IMAGES.chip;
  if (/kosmos|space|nasa|mars|satellit/.test(t)) return NEWS_IMAGES.space;
  if (/iphone|android|smartfon|telefon|gadget|qurilma/.test(t)) return NEWS_IMAGES.mobile;
  if (/kod|dastur|linux|python|javascript|ilova|software/.test(t)) return NEWS_IMAGES.code;
  return NEWS_IMAGES.ai;
}
// Maqola sahifasidan og:image ni olib kelish (post rasm bilan chiqishi uchun).
async function newsOgImage(link) {
  if (!link) return "";
  try {
    const r = await fetch(link, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(12e3)
    });
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 250000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    if (!m) return "";
    const u = m[1].replace(/&amp;/g, "&");
    return /^https?:\/\//i.test(u) ? u : "";
  } catch {
    return "";
  }
}
// Model javobini sarlavha / abzatslar / hashtaglarga ajratadi.
function newsParse(raw) {
  const text = String(raw || "").replace(/\r/g, "").trim();
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : ""; };
  let title = grab(/^\s*SARLAVHA\s*:\s*(.+)$/im);
  let body = "";
  const mBody = text.match(/MATN\s*:\s*([\s\S]*?)(?:\n\s*TEGLAR\s*:|$)/i);
  if (mBody) body = mBody[1];
  const tagsRaw = grab(/TEGLAR\s*:\s*(.+)$/im);
  const srcIdx = Number(grab(/MANBA\s*:\s*(\d+)/i)) || 0;
  if (!title) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    title = (lines[0] || "").replace(/^SARLAVHA\s*:\s*/i, "");
    if (!body) body = lines.slice(1).join("\n");
  }
  body = body.replace(/^(MATN\s*:\s*)/i, "").replace(/\n\s*TEGLAR\s*:[\s\S]*$/i, "");
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\n+/g, " ").trim()).filter(Boolean);
  let tags = tagsRaw.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.startsWith("#"));
  if (!tags.length) tags = [...text.matchAll(/#[\p{L}\p{N}_]{2,30}/gu)].map((m) => m[0]).slice(0, 6);
  const uniq = [...new Set(tags)].slice(0, 6);
  return { title, paragraphs, tags: uniq, srcIdx };
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
  const headList = heads.map((h, i) => `${i + 1}. ${h.title}`).join("\n");
  const prompt = `Sen o'zbek tilidagi texno-blogersan. Bugungi IT/texnologiya yangiligidan bitta post yoz.` +
    (heads.length ? ` Bugungi sarlavhalar:\n${headList}\nShu ro'yxatdan eng qiziqarlisini tanla (MANBA da uning raqamini yoz).` : " Eng so'nggi IT yangiligini top.") +
    ` Oldingi mavzularni takrorlama: ${last || "yo'q"}.` +
    ` Faqat texnologiya, AI, gadjet yoki dasturiy ta'minotga oid yangilikni tanla — janjal, siyosat, sport va shaxsiy hayot haqida yozma.` +
    `\n\nFAQAT quyidagi formatda javob ber, boshqa so'z qo'shma:\n` +
    `SARLAVHA: <bitta mos emoji> <qisqa sarlavha, 70 belgidan oshmasin, oxirida nuqta yo'q>\n\n` +
    `MATN:\n<1-abzats: 1-2 gap>\n\n<2-abzats: 1-2 gap>\n\n<3-abzats: 1-2 gap>\n\n` +
    `TEGLAR: #Tag1 #Tag2 #Tag3 #Tag4\n` +
    `MANBA: <yuqoridagi ro'yxatdagi raqam>` +
    `\n\nQoidalar: abzatslar orasida bo'sh qator bo'lsin, har abzats oddiy matn (markdown yo'q), ` +
    `hashtag 3-5 ta, sarlavhada bitta emoji, matnda 1-2 emoji yetarli.`;
  const errors = [];
  // Avval cooldown tugagan (tirik) modellarni sinab ko'ramiz; bo'lmasa hammasini.
  const live = cfg.models.filter((m) => newsModelReady(m));
  const order = live.length ? live : cfg.models.slice();
  for (const model of order) {
    try {
      const text = await newsGemini(cfg, model, prompt);
      cfg.lastModel = model;
      return { text, heads };
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
    const gen = await newsGenerate(cfg);
    const parsed = newsParse(gen.text);
    const body = [parsed.title, ...parsed.paragraphs, parsed.tags.join(" ")].filter(Boolean).join("\n\n");
    if (!parsed.title && !parsed.paragraphs.length) throw new Error("Model bo'sh javob qaytardi");
    if (dry) {
      cfg.lastStatus = "sinov";
      cfg.lastError = "";
      save();
      return { ok: true, dry: true, text: body, model: cfg.lastModel };
    }
    // Rasm: modeldagi IMAGE_URL yoki manba maqolaning og:image.
    let image = "";
    const mu = gen.text.match(/IMAGE_URL:\s*(\S+)/i);
    if (mu) image = mu[1].trim();
    const heads = gen.heads || [];
    const pick = heads[Math.min(heads.length - 1, Math.max(0, (parsed.srcIdx || 1) - 1))] || heads[0];
    // Google News havolasi og:image bermaydi — to'g'ridan-to'g'ri manba bo'lsa urinamiz.
    if (!image && pick && pick.link && !/news\.google\.com/i.test(pick.link)) image = await newsOgImage(pick.link);
    if (!image) image = newsImageFor(parsed);
    const html = newsCaption(parsed);
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
    cfg.history.unshift({ at: stamp.full, title: String(parsed.title || body.split("\n")[0]).slice(0, 80), trigger: trigger || "jadval" });
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
// Post matni: sarlavha (qalin) + 3 abzats + hashtaglar. Telegram caption ≤1024.
function newsCaption(parsed) {
  const title = parsed.title ? `<b>${esc(parsed.title)}</b>` : "";
  const tags = (parsed.tags || []).join(" ");
  let paras = (parsed.paragraphs || []).slice();
  const build = () => [title, paras.map((p) => esc(p)).join("\n\n"), tags].filter(Boolean).join("\n\n");
  let out = build();
  while (out.length > 1000 && paras.length > 1) {
    paras.pop();
    out = build();
  }
  if (out.length > 1000) out = out.slice(0, 995).trimEnd() + "…";
  return out;
}
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
  // Bu jadval HAQIQIY Telegram kanaliga post qiladi. Lokal/test muhitda u
  // ataylab o'chiriladi: muhitda NEWS_BOT_TOKEN qolib ketgan bo'lsa ham
  // production kanaliga tasodifiy post ketmaydi (spec D).
  if (IS_TEST_ENV || !(process.env.RENDER || process.env.ALWAYSDATA_ENTRY || process.env.ALLOW_NEWS_SCHEDULER === "1")) {
    console.log("News bot jadvali o'chirilgan (lokal rejim). Yoqish: ALLOW_NEWS_SCHEDULER=1");
    return;
  }
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
// --- Eksport xavfsizligi (spec §5) ---
// Panel/eksport orqali bot tokenlari, API kalitlari va parol xeshlari hech
// qachon tashqariga chiqmaydi. Faqat tozalangan nusxa beriladi.
function sanitizeForExport(state) {
  const out = JSON.parse(JSON.stringify(state || {}));
  const s = out.settings || (out.settings = {});
  const removed = [];
  if (s.telegramBotToken) {
    s.telegramBotToken = "";
    removed.push("settings.telegramBotToken");
  }
  if (Array.isArray(s.bots)) {
    for (const b of s.bots) {
      if (b && b.token) {
        b.token = "";
        removed.push("settings.bots[].token");
      }
    }
  }
  if (s.news && s.news.apiKey) {
    s.news.apiKey = "";
    removed.push("settings.news.apiKey");
  }
  if (Array.isArray(out.adminUsers)) {
    out.adminUsers = out.adminUsers.map((a) => {
      if (!a || !a.passHash) return a;
      removed.push("adminUsers[].passHash");
      const { passHash, ...rest } = a;
      return rest;
    });
  }
  return { state: out, removed: [...new Set(removed)] };
}
// --- Panel «Operatsiyalar» (qo'lda bajariladigan texnik amallar) ---
function opsJobStats() {
  const jobs = db.verificationJobs || [];
  const open = /* @__PURE__ */ new Set(["PENDING", "RUNNING"]);
  const openTaskChecks = /* @__PURE__ */ new Set(
    jobs.filter((j) => j.jobType === "TASK_CHECK" && open.has(j.status)).map((j) => j.taskId)
  );
  const broken = (db.tasks || []).filter((t) => t.status === "CHECK_ERROR" || t.status === "RECHECK");
  return {
    total: jobs.length,
    pending: jobs.filter((j) => j.status === "PENDING").length,
    due: jobs.filter((j) => j.status === "PENDING" && Date.parse(j.scheduledAt || "0") <= Date.now()).length,
    running: jobs.filter((j) => j.status === "RUNNING").length,
    taskCheckPending: jobs.filter((j) => j.jobType === "TASK_CHECK" && j.status === "PENDING").length,
    checkErrorTasks: broken.length,
    // Jobi yo'q CHECK_ERROR/RECHECK vazifalar: `repairTaskChecks()` aynan
    // shular uchun BITTA persistent job yaratadi (dublikat yaratmaydi).
    withoutJob: broken.filter((t) => !openTaskChecks.has(t.id)).length
  };
}
function opsChannelStats() {
  const chs = db.channels || [];
  const staleMs = CH_ADMIN_SWEEP_HOURS * 2 * 36e5;
  return {
    total: chs.length,
    permissionLost: chs.filter((c) => c.status === "permission_lost").length,
    paused: chs.filter((c) => c.status === "paused").length,
    adminMissing: chs.filter((c) => !c.botHasAdminRights).length,
    staleCheck: chs.filter((c) => {
      const t = Date.parse(c.lastAdminCheckAt || "");
      return !Number.isFinite(t) || Date.now() - t > staleMs;
    }).length
  };
}
// FAQAT O'QISH: hech qanday balans yoki jurnal yozuvi o'zgartirilmaydi.
function ledgerReport() {
  const sum = summarizeRuntime(db.users, db.transactions, db.orders);
  return {
    users: sum.users,
    matched: sum.matched,
    mismatched: sum.mismatched,
    negative: sum.negative,
    totals: sum.totals,
    problems: sum.perUser.filter((p) => !p.ok).slice(0, 25).map((p) => ({
      userId: p.userId,
      stored: p.stored,
      calc: { available: p.calc.available, reserved: p.calc.reserved, total: p.calc.total },
      delta: p.delta,
      causes: p.causes
    }))
  };
}
function touchOps(kind, n) {
  db.opsMeta = db.opsMeta || {};
  db.opsMeta[kind + "At"] = nowStr();
  if (typeof n === "number") db.opsMeta[kind + "Count"] = n;
  save();
}
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
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          const p = new URLSearchParams(raw || "");
          body = { username: p.get("username") || "", password: p.get("password") || "", remember: p.get("remember") === "1" };
        }
        const uname = String((body && body.username) || "").trim().toLowerCase();
        const pass = String((body && body.password) || "");
        const gate = loginGate(ip, uname);
        if (gate.blocked) return fail(429, "Juda ko‘p xato urinish. " + gate.minutesLeft + " daqiqadan keyin qayta urinib ko‘ring.");
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
          const res2 = loginFail(ip, uname);
          audit({ auth: { username: "anonim", role: "guest" }, headers: { "x-forwarded-for": ip } }, "login_failed", String(uname).slice(0, 64));
          if (res2.blocked) return fail(429, "Juda ko‘p xato urinish. 15 daqiqadan keyin qayta urinib ko‘ring.");
          return fail(401, "Email yoki parol xato. Qolgan urinish: " + res2.userLeft + ".");
        }
        loginOk(ip, uname);
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
      backup: "health", backups: "health", ops: "health"
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
              await cancelOrderAdmin(o);
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
        case "jobs": {
          // Operatsion qo'lda ishga tushirish (panel/tekshiruv uchun).
          if (!isPost) {
            return {
              jobsPending: db.verificationJobs.filter((j) => j.status === "PENDING").length,
              memberships: db.memberships.length,
              events: db.membershipEvents.length
            };
          }
          const what = String(b.action || "verify");
          if (what === "verify") {
            const n = await processVerificationJobs(Number(b.limit) || VERIFY_BATCH);
            audit(req, "jobs_verify", String(n));
            return { ok: true, processed: n };
          }
          if (what === "hourly") {
            await hourlyReport();
            audit(req, "jobs_hourly", "ok");
            return { ok: true };
          }
          throw new Error("Noma'lum amal");
        }
        case "ops": {
          // Panelning «Operatsiyalar» bo'limi: terminaldan qilinadigan texnik
          // ishlar shu yerdan bajariladi. Bu yerda HECH QANDAY balans yoki
          // jurnal yozuvi o'zgartirilmaydi (ledger — faqat o'qish).
          if (!isPost) {
            return {
              now: uzbNow().full,
              storage: STORAGE,
              db: DATABASE_URL ? "postgres" : "fayl",
              uptime: uptimeStr(),
              polling: botsList().map((x) => ({
                id: x.id,
                label: botName(x),
                role: x.role || "worker",
                username: x.username || "",
                enabled: !!x.enabled,
                online: botRuns.has(x.id),
                pollLock: x.pollLock || "",
                startedAt: x.startedAt || "",
                lastError: x.lastError || ""
              })),
              jobs: opsJobStats(),
              channels: opsChannelStats(),
              ledger: (() => {
                const l = ledgerReport();
                return { users: l.users, matched: l.matched, mismatched: l.mismatched, negative: l.negative, totals: l.totals, problems: l.problems };
              })(),
              backups: await listBackups(),
              opsMeta: db.opsMeta || {},
              lastBackupAt: db.lastBackupAt ? new Date(db.lastBackupAt).toISOString() : ""
            };
          }
          const action = String(b.action || "");
          if (action === "ledger") return { ledger: ledgerReport() };
          if (action === "run_jobs") {
            const limit = Math.min(500, Math.max(1, Number(b.limit) || VERIFY_BATCH));
            const n = await processVerificationJobs(limit);
            touchOps("jobs", n);
            audit(req, "ops_run_jobs", String(n));
            return { processed: n, jobs: opsJobStats() };
          }
          if (action === "repair_task_checks") {
            // Instanslararo qulf: ikki instans bir vaqtda qayta tiklasa ham
            // dublikat job yaratilmaydi (repairTaskChecks ochiq jobni ko'radi).
            const tx = await withStateTx(async () => repairTaskChecks());
            if (!tx.ok) throw new Error("Holat qulfi olinmadi: " + (tx.reason || "band"));
            const created = Number(tx.value) || 0;
            // Joblar restartdan keyin ham qolishi shart — yozuvni KUTAMIZ.
            const saved = await flushSaveAwaited();
            touchOps("repair", created);
            audit(req, "ops_repair_task_checks", String(created), saved ? "saved" : "save_failed");
            if (!saved) throw new Error("Saqlashda xatolik — joblar yaratildi, lekin yozuv tasdiqlanmadi");
            return { created, jobs: opsJobStats() };
          }
          if (action === "sweep") {
            const force = !!b.force;
            const channelId = String(b.channelId || "");
            const n = await channelHealthSweep({ force, channelId });
            touchOps("sweep", n);
            audit(req, "ops_sweep", `${n}${force ? " force" : ""}${channelId ? " " + channelId : ""}`);
            return { checked: n, forced: force, channels: opsChannelStats() };
          }
          if (action === "hourly") {
            await hourlyReport();
            touchOps("hourly");
            audit(req, "ops_hourly", "ok");
            return { ok: true };
          }
          throw new Error("Noma'lum amal: " + action);
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
            memberships: {
              total: db.memberships.length,
              active: db.memberships.filter((m) => m.status === "ACTIVE").length,
              cancelled: db.memberships.filter((m) => m.status === "CANCELLED").length,
              checkError: db.memberships.filter((m) => m.status === "CHECK_ERROR").length,
              jobsPending: db.verificationJobs.filter((j) => j.status === "PENDING").length,
              jobsDone: db.verificationJobs.filter((j) => j.status === "DONE").length,
              dueNow: db.verificationJobs.filter((j) => j.status === "PENDING" && Date.parse(j.scheduledAt || "0") <= Date.now()).length,
              events: db.membershipEvents.length,
              taskChecksPending: db.verificationJobs.filter((j) => j.jobType === "TASK_CHECK" && j.status === "PENDING").length
            },
            // Oxirgi tekshiruv nosozliklari: haqiqiy Telegram javobi bilan.
            verifyErrors: {
              total: (db.verifyErrors || []).length,
              recent: (db.verifyErrors || []).slice(-10).reverse()
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
          // Tokenlar/parol xeshlari eksportga TUSHMAYDI (spec §5).
          const clean = sanitizeForExport(db);
          audit(req, "export_sanitized", "state", clean.removed.join(","));
          return { at: nowStr(), sanitized: true, removed: clean.removed, state: clean.state };
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
            // O'chirilgan botning eski tekshiruv natijalari kanallarda qolib
            // ketmasin (panelda faol bot sifatida ko'rinmasligi uchun).
            for (const c of db.channels || []) {
              if (c.botAdmins && Object.hasOwn(c.botAdmins, bot.id)) delete c.botAdmins[bot.id];
              if (c.botAdminBotId === bot.id) c.botAdminBotId = "";
            }
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
            // `client_token` — panel har bosishda yangi token yuboradi; takroriy
            // yuborish (double-click/retry) ikkinchi marta qo'llanmaydi.
            const who = (req.auth && req.auth.username) || "admin";
            const key = b.client_token ? `adminadj:panel:${who}:${String(b.client_token).slice(0, 64)}` : "";
            const adj = await applyAdminAdjust(t, n, `Admin panel (${who})`, key);
            if (!adj.ok) throw new Error(adj.reason === "save_failed" ? "Saqlashda xatolik — amal qaytarildi" : adj.reason === "insufficient" ? "Balans manfiy bo'lib qoladi" : "Bu amal allaqachon bajarilgan");
            notify(t, `\u{1F4B0} Hisobingiz ${n > 0 ? "+" : ""}${n} kreditga o'zgartirildi.`);
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
              status: c.status || "active",
              pausedAt: c.pausedAt || "",
              createdAt: c.createdAt
            }))
          };
        }
        case "channel": {
          const c = db.channels.find((x) => x.id === String(b.id || ""));
          if (!c) throw new Error("Kanal topilmadi");
          // Pauza/rezyume (spec §7): yangi vazifa berilmaydi, buyurtmalar va
          // navbat tarixi saqlanadi, qayta faollashtirilganda davom etadi.
          if (b.action === "pause" || b.action === "resume") {
            c.status = b.action === "pause" ? "paused" : "active";
            c.pausedAt = b.action === "pause" ? nowStr() : "";
            save();
            audit(req, b.action === "pause" ? "channel_pause" : "channel_resume", c.title);
            return { id: c.id, status: c.status };
          }
          // Avval faol buyurtmalarni bekor qilib, kreditini egasiga qaytaramiz —
          // aks holda o‘chirilgan kanal uchun kredit “band” bo‘lib qoladi.
          let refunded = 0;
          for (const o of db.orders.filter((x) => x.destinationId === c.id && x.status === "active")) {
            refunded += (await cancelOrderAdmin(o)).refundCredits || 0;
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
          const res = await cancelOrderAdmin(o);
          if (!res.ok) {
            const msg = res.reason === "reserved_insufficient"
              ? `Band qilingan kredit yetarli emas (reserved ${res.reserved}, kerak ${res.required}) — qaytim rad etildi`
              : res.reason === "duplicate" ? "Bu buyurtma uchun qaytim allaqachon berilgan"
              : res.reason === "save_failed" ? "Saqlashda xatolik — qaytim qaytarildi"
              : "Buyurtma yopilgan";
            throw new Error(msg);
          }
          return res;
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
          if (!await anyBotAdmin(info.result.id)) throw new Error("Hech bir bot bu kanalda administrator emas");
          if (db.sponsors.some((s) => s.username === uname)) throw new Error("Allaqachon qo'shilgan");
          db.sponsors.push({ id: nid("sp"), title: info.result.title, username: uname, channelId: String(info.result.id), url: "https://t.me/" + uname, isMandatory: true, isActive: true, subscribersCount: 0, createdAt: nowStr() });
          save();
          return { items: db.sponsors };
        }
        case "settings": {
          const s = S();
          if (!isPost) {
            // Bot tokeni hech qachon brauzerga qaytarilmaydi (superadmin ham
            // ko'rmaydi — panel faqat niqoblangan tokenni ko'rsatadi).
            const { news, bots, telegramBotToken, ...rest } = s;
            return { settings: { ...rest, news: news ? { enabled: news.enabled, channel: news.channel, times: news.times } : null } };
          }
          for (const k of ["creditRewardSignup", "creditRewardChannelLink", "creditRewardTelegram", "creditRewardInstagram", "creditRewardInstagramSelfConfirmed", "creditRewardReferral", "creditPerSubscriber"]) {
            if (b[k] === void 0) continue;
            const n = Number(b[k]);
            if (!Number.isFinite(n) || n < 0) throw new Error(k + " noto'g'ri son");
            s[k] = Math.round(n);
          }
          const igWas = !!s.isInstagramEnabled;
          for (const k of ["isBotPaused", "areOrdersFrozen", "isInstagramEnabled", "hourlyNotificationsEnabled", "autoOrderCredits"]) {
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
  // Bitta token uchun faqat BITTA polling jarayoni bo'lishi shart (spec §1).
  // Qulfni olmasak — getUpdates umuman boshlanmaydi, aks holda Telegram
  // eski instansning long-poll so'rovini "Conflict" bilan uzadi.
  const lockKey = pollLockKey(bot.token);
  // Advisory lock bir sessiyada qayta olinishi mumkin, shuning uchun bir xil
  // tokenga ega ikkinchi botni jarayon ichida ham to'xtatamiz.
  for (const [otherId, otherKey] of botLocks) {
    if (otherKey === lockKey && otherId !== bot.id) {
      bot.pollLock = "duplicate";
      bot.online = false;
      bot.lastError = "token boshqa bot bilan bir xil";
      return false;
    }
  }
  if (!await tryLock(lockKey)) {
    if (bot.pollLock !== "other") {
      bot.pollLock = "other";
      bot.online = false;
      bot.lastError = "boshqa instans polling qilmoqda";
      console.log(`[${botName(bot)}] qulf boshqa instansda — bu instans getUpdates qilmaydi`);
    }
    return false;
  }
  bot.pollLock = "mine";
  const stopToken = Symbol("stop");
  botRuns.set(bot.id, stopToken);
  botLocks.set(bot.id, lockKey);
  const me = await tgWith(bot, "getMe");
  if (!me.ok) {
    botRuns.delete(bot.id);
    botLocks.delete(bot.id);
    bot.pollLock = "";
    await releaseLock(lockKey);
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
  botAborts.set(bot.id, new AbortController());
  const loop = pollLoop(bot, stopToken).catch((e) => console.error(`[${botName(bot)}] pollLoop xatosi:`, e));
  botLoops.set(bot.id, loop);
  return true;
}
// To'g'ri to'xtatish tartibi (spec A):
//  1) yangi getUpdates rejalashtirilmaydi (botRuns dan chiqadi),
//  2) faol long-poll abort qilinadi,
//  3) tsikl tugashi KUTILADI,
//  4) SHUNDAN KEYIN qulf bo'shatiladi.
var POLL_STOP_WAIT_MS = 6e3;
async function stopBotPolling(id) {
  const key = botLocks.get(id);
  const b = botById(id);
  if (b) b.online = false;
  botRuns.delete(id);
  const ac = botAborts.get(id);
  if (ac) {
    botAborts.delete(id);
    try {
      ac.abort();
    } catch {}
  }
  const loop = botLoops.get(id);
  botLoops.delete(id);
  if (loop) {
    await Promise.race([
      loop.catch(() => {}),
      new Promise((r) => setTimeout(r, POLL_STOP_WAIT_MS))
    ]);
  }
  botLocks.delete(id);
  if (key) await releaseLock(key);
}
function stopBotLoop(id) {
  stopBotPolling(id).catch((e) => console.error("Pollingni to'xtatishda xato:", e.message));
}
async function startAllBots() {
  const list = botsList().filter((b) => b.enabled && b.token);
  // Bir xil token ikki marta qo'shilgan bo'lsa — faqat bittasi polling qiladi,
  // aks holda ular bir-birini "Conflict" bilan uzib turadi.
  const seen = /* @__PURE__ */ new Set();
  for (const b of list) {
    const h = crypto.createHash("sha1").update(b.token).digest("hex");
    if (seen.has(h)) {
      b.pollLock = "duplicate";
      b.lastError = "token boshqa bot bilan bir xil";
      console.error(`[${botName(b)}] token boshqa bot bilan bir xil — polling qilinmaydi`);
      continue;
    }
    seen.add(h);
    if (botRuns.has(b.id)) continue;
    await startBotLoop(b);
  }
  if (!list.length) console.error("Bot tokeni yo'q - faqat veb panel ishlaydi. Panelda bot tokenini qo'shing.");
}
async function restartBots() {
  await Promise.all([...botRuns.keys()].map((id) => stopBotPolling(id).catch(() => {})));
  await startAllBots();
}
var shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 1+2+3) Yangi getUpdates rejalashtirilmaydi, faol long-poll abort qilinadi
  // va tsikl tugashi KUTILADI. Qulf 4-qadamda, polling to'xtagandan keyin
  // bo'shaydi — yangi instans faqat shundan keyin polling boshlay oladi.
  const ids = [...botRuns.keys()];
  if (ids.length) {
    console.log(`${sig}: polling to'xtatilmoqda (${ids.length} ta bot)...`);
    await Promise.all(ids.map((id) => stopBotPolling(id).catch(() => {})));
    console.log("Polling to'xtadi, qulf bo'shatilmoqda...");
  }
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
  // Polling qulfini darhol bo'shatamiz: yangi instans long-poll tugashini
  // kutmasdan boshlasin (aks holda "Conflict" paydo bo'ladi).
  try {
    await releaseAllLocks();
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
// Test hook: Windows'da OS signalini ushlab bo'lmaydi, shuning uchun test
// xuddi shu `shutdown()` yo'lini stdin orqali ishga tushirishi mumkin.
// Productionda bu env yo'q — hech qanday qo'shimcha oqim ochilmaydi.
if (process.env.SHUTDOWN_ON_STDIN === "1") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    if (String(d).trim() === "SIGTERM") shutdown("SIGTERM");
  });
  process.stdin.resume();
}
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
  if (typeof s.creditRewardInstagramSelfConfirmed !== "number") {
    s.creditRewardInstagramSelfConfirmed = 0;
    save();
    console.log("Sozlama: Instagram o'zi tasdiqlagan vazifa uchun mukofot 0 (rasmiy tekshiruv yo'q)");
  }
  if (typeof s.autoOrderCredits !== "boolean") {
    s.autoOrderCredits = true;
    save();
    console.log("Sozlama: avtomatik buyurtma yoqildi (balansdagi kredit o‘z kanaliga o‘tadi)");
  }
  if (s.bonusRuleVersion === 2) return;
  s.creditRewardSignup = 0;
  if (typeof s.creditRewardChannelLink !== "number") s.creditRewardChannelLink = 10;
  s.bonusRuleVersion = 2;
  save();
  console.log(`Sozlama: ro'yxat bonusi 0, kanal ulash bonusi ${s.creditRewardChannelLink}`);
}
// Eski nosoz yozuvlar: pullik kredit band qilingan (totalCost > 0), lekin
// birlik narxi 0 bo'lgan buyurtmalar. Bunday buyurtmada tasdiqlash `reserved`
// dan hech narsa yechmaydi va bekor qilishda qaytarish 0 bo'lib qoladi.
// To'langan birliklar soniga qarab narx tiklanadi, qolgani bepul birlik
// sifatida belgilanadi (foydalanuvchi yutqazmaydi, buxgalteriya yopiladi).
function migrateOrderUnits() {
  const unit = perSub();
  let n = 0;
  for (const o of db.orders) {
    if (Number(o.unitCost) > 0) continue;
    const cost = Number(o.totalCost) || 0;
    if (!(cost > 0)) continue;
    const req = Number(o.requestedQuantity) || 0;
    const paid = Math.min(req, Math.floor(cost / unit));
    const verified = Number(o.verifiedQuantity) || 0;
    o.unitCost = unit;
    // Tasdiqlangan birliklar `freeUnits` dan hisoblanadi (qaytarish formulasi
    // shunga tayanadi), shuning uchun ular bepul qismdan ayriladi.
    o.freeUnits = Math.max(0, req - paid - verified);
    n++;
    console.log(`Buyurtma tuzatildi: ${o.id} (${o.destinationTitle}) — ${paid} to'langan + ${o.freeUnits} bepul birlik`);
  }
  if (n) save();
  return n;
}
async function main() {
  assertEnvSafe();
  await openStore();
  botsInit();
  migrateSettings();
  migrateMemberships();
  migrateOrderUnits();
  // Eski RECHECK/CHECK_ERROR vazifalari uchun qayta urinish jobi yo'q bo'lsa
  // yaratiladi — aks holda ular navbatda ham, ko'rinishda ham osilib qolardi.
  const repaired = repairTaskChecks();
  if (repaired) console.log(`Tekshiruv navbati tuzatildi: ${repaired} ta vazifa uchun qayta urinish jobi yaratildi`);
  save();
  startLockHeartbeat();
  // Avvaldan yig‘ilgan kreditlar ham buyurtmaga aylansin (bir marta ishga tushishda).
  if (S().autoOrderCredits) {
    // db.users — telegramId bo'yicha indekslangan siyrak massiv, shuning uchun
    // Object.values (for...of butun uzunlikni aylanib chiqib osilib qoladi).
    // Pul amali: bitta instanslararo tranzaksiyada.
    const autoRes = await withStateTx(() => {
      let k = 0;
      for (const u of Object.values(db.users)) if (u && autoOrderFromBalance(u)) k++;
      return k;
    });
    const n = autoRes.ok ? autoRes.value : 0;
    if (n) console.log(`Avtomatik buyurtma: ${n} foydalanuvchining balansi buyurtmaga aylantirildi`);
  }
  server.on("error", (e) => {
    console.error("HTTP server xatosi:", e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => console.log(`Veb server: http://${HOST}:${PORT} (saqlash: ${STORAGE})`));
  startKeepAlive();
  startNewsScheduler();
  setInterval(() => hourlyReport().catch((e) => console.error(e)), 6e4);
  startBackupJob();
  // Muddati kelgan a'zolik va vazifa tekshiruvlari: cheklangan partiya,
  // har MAINTENANCE_SEC soniyada (testda qisqartiriladi).
  var MAINTENANCE_SEC = Math.max(1, Number(process.env.MAINTENANCE_SEC) || 120);
  setInterval(() => maintenance().catch((e) => console.error(e)), MAINTENANCE_SEC * 1e3);
  var BOT_START_RETRY_SEC = Math.max(1, Number(process.env.BOT_START_RETRY_SEC) || 30);
  setInterval(() => {
    if (shuttingDown) return;
    for (const b of botsList()) {
      if (!b.enabled || !b.token || botRuns.has(b.id)) continue;
      if (b.nextRetryAt && Date.now() < b.nextRetryAt) continue;
      startBotLoop(b).catch((e) => console.error(e));
    }
  }, BOT_START_RETRY_SEC * 1e3);
  await startAllBots();
}
main().catch((e) => {
  console.error("Ishga tushirishda halokatli xato:", e);
  process.exit(1);
});
