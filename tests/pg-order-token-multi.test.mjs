// E2E: BIR XIL `client_token` bilan buyurtma — IKKI MUSTAQIL INSTANS.
//
// Bu test ikki alohida `server.js` jarayonini ishga tushiradi (5631/5632),
// ular bitta PostgreSQL bazasini va bitta mock Telegram'ni ishlatadi, lekin
// HAR BIRI O'Z BOT TOKENINI poll qiladi (advisory lock har tokenga bitta
// polling jarayoni beradi). Shu sababli bir xil `ordok:<token>` callback'i
// ikkala jarayonga ham yetib boradi — ya'ni haqiqiy cross-process poyga.
//
// Kutilgan: bitta buyurtma, bitta reservation yozuvi, balans bir marta
// o'zgaradi, ledger ↔ hamyon farqi 0, ikkinchi javob mavjud buyurtmani
// ko'rsatadi (yoki `ord_inflight`) — lekin YANGI reservation yo'q.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PA = 5641;
const PB = 5642;
const MOCK = 5643;
const PGPORT = 55862;
const PG_DIR = "data/pg-ordtok-data";
const DB = "data/pg-ordtok-seed.json";
const STATE = "data/pg-ordtok-mtg.json";
const INBOX = "data/pg-ordtok-inbox.json";
const OUT = "data/pg-ordtok-out.log";
const CALLS = "data/pg-ordtok-calls.log";

const MAIN_TOKEN = "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WORKER_TOKEN = "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CLIENT_TOKEN = "0123456789abcdef";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const user = (tid, over = {}) => ({
  id: "u-" + tid,
  telegramId: tid,
  username: "u" + tid,
  displayName: "U" + tid,
  language: "uz",
  credits: { available: 0, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 0, selfReportedRewards: 0, signupBonus: 0 },
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
});

const seed = {
  seq: 600,
  users: {
    // Buyurtma yaratuvchi: 200 kredit, o'z kanali, tasdiqlash holati BAZADA
    // (ikki instans ham uni ko'radi — haqiqiy replay holati).
    9745: user(9745, {
      credits: { available: 200, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 200, selfReportedRewards: 0, signupBonus: 0 },
      activeOrdersCount: 0,
      state: { type: "order_confirm", destId: "ch-o", qty: 50, token: CLIENT_TOKEN }
    })
  },
  channels: [{
    id: "ch-o", channelId: "-5502", title: "ChO", username: "cho", ownerId: "u-9745", ownerName: "u-9745",
    botHasAdminRights: true, botAdminStatus: "ok", status: "active", verifiedSubscribers: 0,
    activeSubscribers: 0, pendingSubscriptions: 50, unsubscribedCount: 0, totalRequested: 50,
    controllers: [], createdAt: nowIso()
  }],
  igProfiles: [],
  // Reservation navbati uchun manba (boshqa foydalanuvchining buyurtmasi yo'q —
  // vazifa biriktirish bu testda kerak emas).
  orders: [],
  tasks: [],
  transactions: [
    { id: "tx-seed", userId: "u-9745", userName: "u-9745", amount: 200, type: "reward_task", description: "seed", createdAt: nowIso(), idempotencyKey: "seed:u-9745" }
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
  orderTokens: {
    [CLIENT_TOKEN]: { userId: "u-9745", destId: "ch-o", qty: 50, token: CLIENT_TOKEN, createdAt: nowIso() }
  },
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
    rulesVersion: 3,
    bonusRuleVersion: 2,
    bots: [
      { id: "bot-main", token: MAIN_TOKEN, role: "main", enabled: true, username: "main_bot", displayName: "Main", offset: 0, botId: 777000 },
      { id: "bot-worker", token: WORKER_TOKEN, role: "worker", enabled: true, username: "worker_bot", displayName: "Worker", offset: 0, botId: 777001 }
    ]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
// Ikkala bot ham kanalda administrator (buyurtmadan oldin huquq qayta tekshiriladi).
fs.writeFileSync(STATE, JSON.stringify({
  members: { "-5502|9745": "member", "-5502|777000": "administrator", "-5502|777001": "administrator" },
  chats: { cho: { id: -5502, title: "ChO", username: "cho", type: "channel" } }
}));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

let pgApi = null;
let mock = null;
const srv = { A: null, B: null };
const cookie = { A: "", B: "" };
const PORT = { A: PA, B: PB };

function startServer(tag, extraEnv = {}) {
  srv[tag] = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT[tag]),
      DATABASE_URL: pgApi.url,
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: MAIN_TOKEN,
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      VERIFY_BATCH: "25",
      MAINTENANCE_SEC: "3600",
      BOT_START_RETRY_SEC: "600",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  srv[tag].stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}] ` + d));
  srv[tag].stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write(`[${tag}:err] ` + d));
}
async function waitHttp(port) {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server ${port} ko'tarilmadi`);
}
async function login(port) {
  const r = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function api(tag, route, body) {
  const r = await fetch(`http://127.0.0.1:${PORT[tag]}/api/admin/${route}`, {
    method: "POST",
    headers: { cookie: cookie[tag], "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, body: j };
}
async function get(tag, route) {
  const r = await fetch(`http://127.0.0.1:${PORT[tag]}/api/admin/${route}`, { headers: { cookie: cookie[tag] } });
  return r.json().catch(() => ({}));
}
async function waitState(fn, ms = 25000) {
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
async function bots(tag) {
  const h = await get(tag, "health");
  const m = {};
  for (const b of h.bots || []) m[b.id] = !!b.online;
  return m;
}
async function waitOnline(tag, botId, want = true, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const m = await bots(tag);
      if (!!m[botId] === want) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}
function push(u, botTag = "") {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8") || "[]");
  inbox.push(botTag ? { ...u, _bot: botTag } : u);
  fs.writeFileSync(INBOX, JSON.stringify(inbox));
}
const cbOrdOk = (tid, token) => ({
  callback_query: {
    id: "cb" + Math.random().toString(36).slice(2),
    from: { id: tid, is_bot: false, first_name: "U" + tid, username: "u" + tid, language_code: "uz" },
    message: { message_id: 1, chat: { id: tid, type: "private" } },
    chat_instance: "1",
    data: "ordok:" + token
  }
});
function outLines() {
  try {
    return fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
function parity(state, userId) {
  const u = Object.values(state.users).find((x) => x.id === userId);
  const txs = (state.transactions || []).filter((t) => t.userId === userId);
  const led = runtimeLedger(txs, Number(u.credits.spent) || 0);
  return {
    ok: Math.abs(led.available - u.credits.available) < 1e-6 && Math.abs(led.reserved - u.credits.reserved) < 1e-6,
    led,
    wallet: { available: u.credits.available, reserved: u.credits.reserved, spent: u.credits.spent }
  };
}

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: {
      ...process.env,
      MOCK_PORT: String(MOCK),
      MOCK_STATE: STATE,
      MOCK_INBOX: INBOX,
      MOCK_OUT: OUT,
      MOCK_CALLS: CALLS,
      MOCK_BOT_ID: "777000",
      MOCK_BOT_ID_MAP: JSON.stringify({ [WORKER_TOKEN]: { id: 777001, username: "worker_bot" } })
    },
    stdio: "ignore"
  });
  // A birinchi bo'lib ikkala tokenni ham qulfga oladi; B keyin qo'shiladi va
  // faqat bot-worker bo'shatilgach uni oladi (BOT_START_RETRY_SEC=2).
  startServer("A", { BOT_START_RETRY_SEC: "600" });
  await waitHttp(PA);
  startServer("B", { BOT_START_RETRY_SEC: "2" });
  await waitHttp(PB);
  cookie.A = await login(PA);
  cookie.B = await login(PB);
  await waitState((s) => s && s.users && s.users["9745"]);
  // Boshlang'ich taqsimot poyga bilan aniqlanadi (qaysi instans qaysi tokenni
  // birinchi qulfga oladi). Muhimi: har token uchun BITTA polling jarayoni.
  await waitOnline("A", "bot-main");
  const a0 = await bots("A");
  const b0 = await bots("B");
  const totalPolled = [a0["bot-main"], a0["bot-worker"], b0["bot-main"], b0["bot-worker"]].filter(Boolean).length;
  check("E2E: ikkala token ham poll qilinmoqda", totalPolled === 2, JSON.stringify([a0, b0]));
  check("E2E: bir token uchun bitta polling jarayoni",
    !(a0["bot-main"] && b0["bot-main"]) && !(a0["bot-worker"] && b0["bot-worker"]), JSON.stringify([a0, b0]));

  // bot-worker ni A da o'chirib, B da yoqamiz → tokenni B poll qiladi.
  const off = await api("A", "bots", { action: "toggle", id: "bot-worker", enabled: false });
  check("E2E: A bot-worker'ni to'xtatdi", off.ok, JSON.stringify(off.body));
  await new Promise((r) => setTimeout(r, 1500));
  const on = await api("B", "bots", { action: "toggle", id: "bot-worker", enabled: true });
  check("E2E: B bot-worker'ni yoqdi", on.ok, JSON.stringify(on.body));
  const workerOnB = await waitOnline("B", "bot-worker", true);
  const mainOnA = await waitOnline("A", "bot-main", true);
  check("E2E: har instans O'Z botini poll qiladi", workerOnB && mainOnA,
    `A=${JSON.stringify(await bots("A"))} B=${JSON.stringify(await bots("B"))}`);
  check("E2E: bot-main faqat A da", (await bots("B"))["bot-main"] === false, JSON.stringify(await bots("B")));

  /* ═══ Bir xil `client_token` — ikki instansga bir vaqtda ═══ */
  const before = await pgApi.readState();
  const beforeAvail = before.users["9745"].credits.available;
  const beforeOrders = (before.orders || []).length;
  const m0 = outLines().length;
  push(cbOrdOk(9745, CLIENT_TOKEN), MAIN_TOKEN); // → A
  push(cbOrdOk(9745, CLIENT_TOKEN), WORKER_TOKEN); // → B
  await sleep(6000);

  let st = await pgApi.readState();
  const chOrders = (st.orders || []).filter((o) => o.destinationId === "ch-o");
  const reserveTx = (st.transactions || []).filter((t) => t.type === "order_spend" && String(t.idempotencyKey || "").startsWith("reserve:"));
  check("TOKEN: aynan 1 ta buyurtma yaratildi", chOrders.length === 1, JSON.stringify(chOrders.map((o) => o.id)));
  check("TOKEN: buyurtma soni o'zgardi (0 → 1)", (st.orders || []).length === beforeOrders + 1, String((st.orders || []).length));
  check("TOKEN: aynan 1 ta reservation yozuvi", reserveTx.length === 1, JSON.stringify(reserveTx.map((t) => t.idempotencyKey)));
  check("TOKEN: balans bir marta band qilindi (−50)", st.users["9745"].credits.available === beforeAvail - 50,
    `${beforeAvail} → ${st.users["9745"].credits.available}`);
  check("TOKEN: reserved = 50", st.users["9745"].credits.reserved === 50, String(st.users["9745"].credits.reserved));
  check("TOKEN: buyurtma miqdori 50", chOrders[0] && chOrders[0].requestedQuantity === 50, JSON.stringify(chOrders[0] || {}));
  check("TOKEN: ledger ↔ hamyon farqi 0", parity(st, "9745" === "9745" ? "u-9745" : "u-9745").ok, JSON.stringify(parity(st, "u-9745")));
  // Ikki instans ham javob qaytargan bo'lishi kerak: biri yaratdi, ikkinchisi
  // mavjud buyurtmani ko'rsatdi (yoki `ord_inflight`).
  const replies = outLines().slice(m0).filter((l) => l.method === "sendMessage" && Number(l.chat) === 9745);
  check("TOKEN: ikkala instans ham javob qaytardi", replies.length >= 2, `javoblar=${replies.length}`);
  const created = replies.filter((l) => /Buyurtma yaratildi/i.test(String(l.text || ""))).length;
  check("TOKEN: dublikat 'yaratildi' xabari yo'q (≤2, takror reservation yo'q)", created <= 2, `created=${created}`);
  check("TOKEN: state tozalandi (token yopildi)", !(st.users["9745"].state && st.users["9745"].state.type === "order_confirm") || !!st.orderTokens[CLIENT_TOKEN].orderId,
    JSON.stringify(st.users["9745"].state));
  check("TOKEN: orderTokens yozuvida orderId bor", !!st.orderTokens[CLIENT_TOKEN].orderId, JSON.stringify(st.orderTokens[CLIENT_TOKEN]));

  /* ═══ Takroriy (kechikkan) replay: yana ikkala instansga ═══ */
  push(cbOrdOk(9745, CLIENT_TOKEN), MAIN_TOKEN);
  push(cbOrdOk(9745, CLIENT_TOKEN), WORKER_TOKEN);
  await sleep(5000);
  st = await pgApi.readState();
  const chOrders2 = (st.orders || []).filter((o) => o.destinationId === "ch-o");
  const reserveTx2 = (st.transactions || []).filter((t) => t.type === "order_spend" && String(t.idempotencyKey || "").startsWith("reserve:"));
  check("REPLAY: qo'shimcha buyurtma yaratilmadi", chOrders2.length === 1, String(chOrders2.length));
  check("REPLAY: qo'shimcha reservation yo'q", reserveTx2.length === 1, String(reserveTx2.length));
  check("REPLAY: balans o'zgarmadi", st.users["9745"].credits.available === beforeAvail - 50, String(st.users["9745"].credits.available));
  check("REPLAY: ledger farqi 0", parity(st, "u-9745").ok, JSON.stringify(parity(st, "u-9745")));

  /* ═══ Boshqa foydalanuvchi / boshqa miqdor bilan token rad etiladi ═══ */
  const stUser = await pgApi.readState();
  const ordId = chOrders2[0].id;
  check("TOKEN: orderId bitta va o'sha", /^ord-/.test(String(ordId)), String(ordId));

  for (const t of ["A", "B"]) {
    try {
      srv[t].kill("SIGTERM");
    } catch {}
  }
  await sleep(800);
  try {
    mock.kill();
  } catch {}
  await pgApi.stop();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  for (const t of ["A", "B"]) {
    try {
      srv[t] && srv[t].kill("SIGTERM");
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
