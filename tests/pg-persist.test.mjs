// HAQIQIY PostgreSQL ustida: saqlash xatosi → rollback, advisory lock,
// SIGKILL crash-safety.
//
// Bu testlar `embedded-postgres` orqali vaqtinchalik PG 18 serverni ko'taradi
// (production bazaga ulanmaydi) va HAQIQIY `server.js` jarayonini ishga tushiradi.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PORT = 5581;
const PORT_B = 5583;
const MOCK = 5582;
const PGPORT = 55800;
const PG_DIR = "data/pg-persist-data";
const DB = "data/pg-persist-seed.json";
const STATE = "data/pg-persist-mtg.json";
const INBOX = "data/pg-persist-inbox.json";
const OUT = "data/pg-persist-out.log";
const CALLS = "data/pg-persist-calls.log";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function user(tid, available, over = {}) {
  return {
    id: "u-" + tid,
    telegramId: tid,
    username: "u" + tid,
    displayName: "U" + tid,
    language: "uz",
    credits: { available, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
    registeredAt: nowIso(),
    referralCode: "REF_" + tid,
    isReferralVerified: false,
    completedTasksCount: 0,
    activeOrdersCount: 0,
    status: "active",
    chatId: tid,
    botId: "bot-main",
    notifications: false,
    notif: { subscribers: false, referrals: false, orders: false, technical: false },
    ...over
  };
}

const channel = (id, tg, owner) => ({
  id,
  channelId: String(tg),
  title: "Ch" + tg,
  username: "ch" + Math.abs(tg),
  ownerId: owner,
  ownerName: owner,
  botHasAdminRights: true,
  botAdminStatus: "ok",
  status: "active",
  verifiedSubscribers: 0,
  activeSubscribers: 0,
  pendingSubscriptions: 0,
  unsubscribedCount: 0,
  totalRequested: 0,
  controllers: [],
  createdAt: nowIso()
});

const order = (id, owner, dest, over = {}) => ({
  id,
  seq: 1,
  userId: owner,
  userName: owner,
  destinationId: dest,
  destinationTitle: "Ch",
  platform: "telegram",
  requestedQuantity: 3,
  verifiedQuantity: 0,
  pendingQuantity: 3,
  cancelledQuantity: 0,
  unitCost: 10,
  totalCost: 30,
  freeUnits: 0,
  status: "active",
  createdAt: nowIso(),
  ...over
});

const seed = {
  seq: 100,
  users: {
    9602: user(9602, 970, { credits: { available: 970, reserved: 30, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 }, activeOrdersCount: 1 }),
    // `reserved` (5) buyurtmaning qaytimi (30) uchun YETMAYDI — legacy nomuvofiqlik.
    9601: user(9601, 0, { credits: { available: 0, reserved: 5, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 }, activeOrdersCount: 1 })
  },
  channels: [channel("ch-own", -4101, "u-9602"), channel("ch-low", -4102, "u-9601")],
  igProfiles: [],
  orders: [
    order("ord-A", "u-9602", "ch-own", { seq: 1 }),
    order("ord-LOW", "u-9601", "ch-low", { seq: 2, destinationTitle: "Ch-4102" })
  ],
  tasks: [],
  transactions: [
    { id: "tx-seed-a", userId: "u-9602", amount: 1000, type: "admin_adjustment", idempotencyKey: "seed:a", balanceAfter: 1000 },
    { id: "tx-res-a", userId: "u-9602", amount: -30, type: "order_spend", orderId: "ord-A", idempotencyKey: "reserve:ord-A" },
    { id: "tx-seed-low", userId: "u-9601", amount: 5, type: "admin_adjustment", idempotencyKey: "seed:low", balanceAfter: 5 },
    { id: "tx-res-low", userId: "u-9601", amount: -5, type: "order_spend", orderId: "ord-LOW", idempotencyKey: "reserve:ord-LOW" }
  ],
  memberships: [],
  membershipEvents: [],
  verificationJobs: [],
  verifyErrors: [],
  sponsorMemberships: [],
  notifPeriods: [],
  complaints: [],
  referrals: [],
  sponsors: [],
  ctlRequests: [],
  verifyLog: [],
  adminUsers: [],
  auditLog: [],
  appeals: [],
  moderationFlags: [],
  lastHour: 0,
  settings: {
    creditRewardTelegram: 10,
    creditRewardInstagram: 10,
    creditRewardInstagramSelfConfirmed: 0,
    creditRewardReferral: 300,
    creditRewardSignup: 0,
    creditRewardChannelLink: 0,
    creditPerSubscriber: 1,
    autoOrderCredits: false,
    isInstagramEnabled: false,
    hourlyNotificationsEnabled: false,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({ members: {}, chats: {} }));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

const calls = () => fs.readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let pgApi = null;
let mock = null;
const servers = [];
let serverLog = {};

function env() {
  return {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: pgApi.url,
    TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
    TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    ADMIN_PASSWORD: "testpass",
    ADMIN_IDS: "0",
    DATA_FILE: DB,
    KEEP_ALIVE: "0",
    VERIFY_BATCH: "25",
    MAINTENANCE_SEC: "2",
    BOT_START_RETRY_SEC: "2"
  };
}

function startServer(port, tag) {
  const p = spawn("node", ["server.js"], {
    env: { ...env(), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverLog[tag] = "";
  p.stdout.on("data", (d) => {
    serverLog[tag] += String(d);
    if (process.env.SHOW_LOGS) process.stdout.write(`[${tag}] ` + d);
  });
  p.stderr.on("data", (d) => {
    serverLog[tag] += String(d);
    if (process.env.SHOW_LOGS) process.stdout.write(`[${tag}:err] ` + d);
  });
  servers.push({ p, port, tag });
  return p;
}
async function waitHttp(port) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("server ko'tarilmadi: " + port);
}
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function api(port, route, body) {
  const cookie = await login(port);
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/${route}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, body: j, ok: r.ok && j && j.ok !== false };
}
async function waitState(fn, ms = 12000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      last = await pgApi.readState();
      if (last && fn(last)) return last;
    } catch {}
    await sleep(200);
  }
  return last;
}
function parity(state, userId) {
  const u = Object.values(state.users).find((x) => x.id === userId);
  const txs = (state.transactions || []).filter((t) => t.userId === userId);
  const led = runtimeLedger(txs, Number(u.credits.spent) || 0);
  return {
    ok: Math.abs(led.available - u.credits.available) < 1e-6 && Math.abs(led.reserved - u.credits.reserved) < 1e-6,
    led,
    wallet: u.credits
  };
}

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });

  startServer(PORT, "A");
  await waitHttp(PORT);
  // Boshlang'ich holat PG'ga yozilganini kutamiz.
  check("PG: boshlang'ich holat app_state ga yozildi", !!(await waitState((s) => s && s.users && s.users["9602"])));

  /* ═══ 1. PG persist xatosi → flushOrRollback (balans + jurnal) ═══ */
  const boot = await pgApi.readState();
  const S0 = boot.users["9602"].credits.available;
  check("PG: boshlang'ich balans ↔ ledger mos", parity(boot, "u-9602").ok, JSON.stringify(parity(boot, "u-9602")));
  const ok1 = await api(PORT, "user", { telegramId: 9602, action: "credits", amount: 50, client_token: "pg-t1" });
  check("PG: panel +50 muvaffaqiyatli", ok1.ok && ok1.body.balance === S0 + 50, JSON.stringify(ok1.body));
  let st = await waitState((s) => s.users["9602"].credits.available === S0 + 50);
  check("PG: yangi balans bazaga yozildi", st.users["9602"].credits.available === S0 + 50);
  check("PG: jurnal yozuvi bazada", (st.transactions || []).some((t) => t.idempotencyKey === "adminadj:panel:owner:pg-t1"));

  const c = await pgApi.client();
  await c.query("ALTER TABLE app_state RENAME TO app_state_broken");
  const fail1 = await api(PORT, "user", { telegramId: 9602, action: "credits", amount: 50, client_token: "pg-t2" });
  check("PG: saqlash xatosida amal rad etildi", !fail1.ok && fail1.status >= 400, `${fail1.status} ${JSON.stringify(fail1.body)}`);
  check("PG: xato xabari 'saqlash' haqida", /Saqlashda xatolik/i.test(String((fail1.body || {}).error || "")), JSON.stringify(fail1.body));
  await c.query("ALTER TABLE app_state_broken RENAME TO app_state");

  // Qaytarilganini ANIQ ko'rish: keyingi muvaffaqiyatli yozuv +1 bo'lsin.
  const ok2 = await api(PORT, "user", { telegramId: 9602, action: "credits", amount: 1, client_token: "pg-t3" });
  check("PG: keyingi yozuv ishlaydi (zanjir buzilmadi)", ok2.ok, JSON.stringify(ok2.body));
  st = await waitState((s) => s.users["9602"].credits.available === S0 + 51);
  check("PG: muvaffaqiyatsiz +50 qaytarildi", st.users["9602"].credits.available === S0 + 51, String(st.users["9602"].credits.available));
  check("PG: muvaffaqiyatsiz amal jurnali yo'q", !(st.transactions || []).some((t) => t.idempotencyKey === "adminadj:panel:owner:pg-t2"));
  check("PG: ledger ↔ hamyon farqi 0 (u-9602)", parity(st, "u-9602").ok, JSON.stringify(parity(st, "u-9602")));

  /* ═══ 2. PG persist xatosi → buyurtma/qaytim qaytariladi ═══ */
  const c2 = await pgApi.client();
  await c2.query("ALTER TABLE app_state RENAME TO app_state_broken");
  const fail2 = await api(PORT, "order", { id: "ord-A", action: "cancel" });
  check("PG: save xatosida bekor qilish rad etildi", !fail2.ok, `${fail2.status} ${JSON.stringify(fail2.body)}`);
  await c2.query("ALTER TABLE app_state_broken RENAME TO app_state");
  const ok3 = await api(PORT, "user", { telegramId: 9602, action: "credits", amount: 1, client_token: "pg-t4" });
  st = await waitState((s) => s.users["9602"].credits.available === S0 + 52);
  check("PG: buyurtma active qoldi (qaytim yozilmadi)", st.orders.find((o) => o.id === "ord-A").status === "active");
  check("PG: reserved 30 (o'zgarmadi)", st.users["9602"].credits.reserved === 30, String(st.users["9602"].credits.reserved));
  check("PG: refund jurnali yo'q", !(st.transactions || []).some((t) => t.type === "order_refund" && t.orderId === "ord-A"));
  check("PG: +1 keyingi amal ishladi", ok3.ok && st.users["9602"].credits.available === S0 + 52);
  check("PG: ledger farqi 0 (rollbackdan keyin)", parity(st, "u-9602").ok, JSON.stringify(parity(st, "u-9602")));

  /* ═══ 3. reserved < refund → rad (PG, admin yo'li) ═══ */
  const rej = await api(PORT, "order", { id: "ord-LOW", action: "cancel" });
  check("PG: reserved yetmasa admin bekor qilishi rad etildi", !rej.ok, JSON.stringify(rej.body));
  st = await pgApi.readState();
  check("PG: ord-LOW active qoldi", st.orders.find((o) => o.id === "ord-LOW").status === "active");
  check("PG: u-9601 balansi tegilmadi", st.users["9601"].credits.available === 0 && st.users["9601"].credits.reserved === 5,
    JSON.stringify(st.users["9601"].credits));
  // audit yozuvi debounce bilan saqlanadi — paydo bo'lishini kutamiz.
  const audited = await waitState((s) => (s.auditLog || []).some((l) => l.action === "refund_rejected" && /reserved_insufficient/.test(l.meta)), 6000);
  check("PG: reserved_insufficient audit yozuvi", (audited.auditLog || []).some((l) => l.action === "refund_rejected" && /reserved_insufficient/.test(l.meta)));

  /* ═══ 4. Advisory lock — ikki HAQIQIY PG ulanishi ═══ */
  const lockQ = "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok";
  const unlockQ = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok";
  // Probe ALOHIDA kalit ishlatadi — production polling kalitiga hech qachon tegilmaydi.
  const probeKey = "gxb:probe:" + crypto.randomUUID();
  const lc1 = await pgApi.client();
  const lc2 = await pgApi.client();
  const tryOn = async (cc, k) => (await cc.query(lockQ, [k])).rows[0].ok;
  const first = await tryOn(lc1, probeKey);
  const second = await tryOn(lc2, probeKey);
  check("LOCK: birinchi ulanish qulfni oldi", first === true, String(first));
  check("LOCK: ikkinchi ulanish qulfni ololmadi", second === false, String(second));
  await lc1.query(unlockQ, [probeKey]);
  const third = await tryOn(lc2, probeKey);
  check("LOCK: bo'shatgach ikkinchisi oldi", third === true, String(third));
  await lc2.query(unlockQ, [probeKey]);

  // Production kaliti: uni HAQIQIY server (A) ushlab turgan bo'lishi kerak.
  const prodKey = "gxb:poll:" + crypto.createHash("sha1").update("TESTTOKEN").digest("hex");
  const lc3 = await pgApi.client();
  const prodHeld = await tryOn(lc3, prodKey);
  check("LOCK: production kalitini server ushlagan (probe olmadi)", prodHeld === false, String(prodHeld));
  await lc3.end();
  await lc2.end();
  await lc1.end();

  /* ═══ 5. Ikki server instansi: faqat bittasi polling qiladi ═══ */
  // A allaqachon ishlayapti. Xuddi shu token + bir xil PG bilan B ni ko'taramiz.
  await sleep(1500);
  startServer(PORT_B, "B");
  await waitHttp(PORT_B);
  await sleep(5000);
  const concurrent = calls().filter((x) => typeof x.concurrent === "number" && x.concurrent > 1);
  check("LOCK: bir vaqtda ikkita getUpdates bo'lmadi", concurrent.length === 0, JSON.stringify(concurrent.slice(0, 3)));
  check("LOCK: B instansi polling qilmayapti (log)", /qulf boshqa instansda/.test(serverLog.B || ""), (serverLog.B || "").slice(-300));

  /* ═══ 6. SIGKILL: qayta ishga tushgandan keyin balans ↔ ledger mos ═══ */
  const before = await pgApi.readState();
  const beforeBal = before.users["9602"].credits.available;
  const killT = Date.now();
  const b = servers.find((s) => s.tag === "B");
  b.p.kill("SIGKILL");
  servers.splice(servers.indexOf(b), 1);
  // A hali tirik — uni ham to'xtatib, yangi instans ko'taramiz.
  const a = servers.find((s) => s.tag === "A");
  a.p.kill("SIGKILL");
  servers.splice(servers.indexOf(a), 1);
  await sleep(800);
  startServer(PORT, "C");
  await waitHttp(PORT);
  st = await pgApi.readState();
  check("CRASH: qayta ishga tushgandan keyin foydalanuvchi saqlanib qoldi", !!st.users["9602"]);
  check("CRASH: balans saqlanib qoldi", st.users["9602"].credits.available === beforeBal, `${beforeBal} → ${st.users["9602"].credits.available}`);
  check("CRASH: ledger ↔ hamyon farqi 0", parity(st, "u-9602").ok, JSON.stringify(parity(st, "u-9602")));
  check("CRASH: buyurtmalar va jurnal saqlanib qoldi", st.orders.length === 2 && (st.transactions || []).length === (before.transactions || []).length);

  // Pul amali + darhol SIGKILL: yozuv yo yozilgan, yo yo'q — lekin drift bo'lmasin.
  await api(PORT, "user", { telegramId: 9602, action: "credits", amount: 7, client_token: "pg-kill" });
  startServer(PORT_B, "D");
  await waitHttp(PORT_B);
  const d = servers.find((s) => s.tag === "D");
  d.p.kill("SIGKILL");
  servers.splice(servers.indexOf(d), 1);
  await sleep(600);
  const stKill = await pgApi.readState();
  const hasTx = (stKill.transactions || []).some((t) => t.idempotencyKey === "adminadj:panel:owner:pg-kill");
  check("CRASH: yozuv yoki butunlay bor, yoki butunlay yo'q",
    hasTx ? stKill.users["9602"].credits.available === beforeBal + 7 : stKill.users["9602"].credits.available === beforeBal,
    JSON.stringify({ hasTx, bal: stKill.users["9602"].credits.available, beforeBal }));
  check("CRASH: drift yo'q", parity(stKill, "u-9602").ok, JSON.stringify(parity(stKill, "u-9602")));

  /* ═══ Yakun ═══ */
  for (const s of servers) {
    try {
      s.p.kill("SIGTERM");
    } catch {}
  }
  await sleep(600);
  try {
    mock.kill();
  } catch {}
  await pgApi.stop();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  for (const s of servers) {
    try {
      s.p.kill("SIGTERM");
    } catch {}
  }
  try {
    mock && mock.kill();
  } catch {}
  try {
    pgApi && (await pgApi.stop());
  } catch {}
  process.exit(1);
});
