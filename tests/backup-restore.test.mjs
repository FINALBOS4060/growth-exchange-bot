// BACKUP → RESTORE (alohida test muhiti): `app_backup` dan holatni tiklash.
//
// Ssenariy:
//   1. Haqiqiy server + PG: boshlang'ich holat, keyin +40 kredit (jurnal bilan).
//   2. `POST /api/admin/backup` → `app_backup` ga nusxa.
//   3. Zaxiradan KEYIN +60 kredit (tiklashda yo'qolishi kerak).
//   4. Server to'xtatiladi (tiklash faqat to'xtatilgan holatda).
//   5. `scripts/restore-backup.mjs --list` / `--dry-run` (yozmaydi) /
//      `--apply --confirm` (yozadi + `pre-restore` xavfsizlik nusxasi).
//   6. Server qayta ishga tushadi: holat zaxira holatiga qaytgan, ledger ↔
//      hamyon farqi 0, `rev` o'sgan.
//   7. Rad etish yo'llari: mavjud bo'lmagan `--id`, `--confirm` siz `--apply`.
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";
import { runtimeLedger } from "../scripts/lib/ledger-reconcile.mjs";

const PORT = 5651;
const MOCK = 5652;
const PGPORT = 55863;
const PG_DIR = "data/pg-backup-data";
const DB = "data/pg-backup-seed.json";
const STATE = "data/pg-backup-mtg.json";
const INBOX = "data/pg-backup-inbox.json";
const OUT = "data/pg-backup-out.log";
const CALLS = "data/pg-backup-calls.log";
const RESTORE = "scripts/restore-backup.mjs";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const user = (tid) => ({
  id: "u-" + tid,
  telegramId: tid,
  username: "u" + tid,
  displayName: "U" + tid,
  language: "uz",
  credits: { available: 100, reserved: 0, spent: 0, refunded: 0, verifiedRewards: 100, selfReportedRewards: 0, signupBonus: 0 },
  registeredAt: nowIso(),
  referralCode: "REF_" + tid,
  isReferralVerified: false,
  completedTasksCount: 0,
  activeOrdersCount: 0,
  status: "active",
  chatId: tid,
  botId: "bot-main",
  notifications: false,
  notif: { subscribers: false, referrals: false, orders: false, technical: false }
});

const seed = {
  seq: 700,
  users: { 9750: user(9750) },
  channels: [],
  igProfiles: [],
  orders: [],
  tasks: [],
  transactions: [
    { id: "tx-seed", userId: "u-9750", userName: "u-9750", amount: 100, type: "reward_task", description: "seed", createdAt: nowIso(), idempotencyKey: "seed:u-9750" }
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
    rulesVersion: 3,
    bonusRuleVersion: 2,
    bots: [{ id: "bot-main", token: "TESTTOKEN", role: "main", enabled: true, username: "test_bot", displayName: "Test", offset: 0 }]
  }
};

fs.writeFileSync(DB, JSON.stringify(seed));
fs.writeFileSync(STATE, JSON.stringify({ members: {}, chats: {} }));
fs.writeFileSync(INBOX, "[]");
fs.writeFileSync(OUT, "");
fs.writeFileSync(CALLS, "");

let pgApi = null;
let mock = null;
let srv = null;
let cookie = "";

function startServer() {
  srv = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: pgApi.url,
      TELEGRAM_API_BASE: `http://127.0.0.1:${MOCK}`,
      TELEGRAM_BOT_TOKEN: "TESTTOKEN",
      ADMIN_PASSWORD: "testpass",
      DATA_FILE: DB,
      KEEP_ALIVE: "0",
      VERIFY_BATCH: "25",
      MAINTENANCE_SEC: "3600",
      BOT_START_RETRY_SEC: "600"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  srv.stdout.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.env.SHOW_LOGS && process.stdout.write("[srv:err] " + d));
}
async function waitHttp() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("server ko'tarilmadi");
}
async function login() {
  const r = await fetch(`http://127.0.0.1:${PORT}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "testpass" })
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}
async function api(route, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/${route}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, body: j };
}
async function waitState(fn, ms = 20000) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const r = await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1");
      last = r.rows[0] || null;
      if (last && fn(last.data, last.rev)) return last;
    } catch {}
    await sleep(200);
  }
  return last;
}
function parity(state, userId) {
  const u = Object.values(state.users).find((x) => x.id === userId);
  const txs = (state.transactions || []).filter((t) => t.userId === userId);
  const led = runtimeLedger(txs, Number(u.credits.spent) || 0);
  return { ok: Math.abs(led.available - u.credits.available) < 1e-6 && Math.abs(led.reserved - u.credits.reserved) < 1e-6, led, wallet: u.credits };
}
function restore(args) {
  return spawnSync(process.execPath, [RESTORE, ...args], {
    env: { ...process.env, DATABASE_URL: pgApi.url, DATA_FILE: DB },
    encoding: "utf8"
  });
}
async function stopServer() {
  if (!srv) return;
  const done = new Promise((r) => srv.once("exit", r));
  try {
    srv.kill("SIGTERM");
  } catch {}
  await Promise.race([done, sleep(10000)]);
  try {
    srv.kill("SIGKILL");
  } catch {}
  srv = null;
  await sleep(400);
}

async function main() {
  pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  mock = spawn("node", ["tests/support/mock-telegram.mjs"], {
    env: { ...process.env, MOCK_PORT: String(MOCK), MOCK_STATE: STATE, MOCK_INBOX: INBOX, MOCK_OUT: OUT, MOCK_CALLS: CALLS },
    stdio: "ignore"
  });
  startServer();
  await waitHttp();
  cookie = await login();
  check("BOSHLANG'ICH: holat PG ga yozildi", !!(await waitState((s) => s && s.users && s.users["9750"])));

  /* ─── 1. Zaxira OLDIDAN mutatsiya (+40) ─── */
  const r1 = await api("user", { telegramId: 9750, action: "credits", amount: 40, client_token: "bk-1" });
  check("ZAXIRA OLDIDAN: +40 qo'llanadi", r1.ok, JSON.stringify(r1.body));
  const pre = await waitState((s) => s.users["9750"].credits.available === 140);
  check("ZAXIRA OLDIDAN: balans 140", pre.data.users["9750"].credits.available === 140, String(pre.data.users["9750"].credits.available));

  /* ─── 2. Zaxira nusxa ─── */
  const bk = await api("backup", {});
  check("ZAXIRA: POST /api/admin/backup ishladi", bk.ok, JSON.stringify(bk.body));
  await sleep(800);
  const bRows = await pgApi.query("SELECT id, created_at, reason, size FROM app_backup ORDER BY id DESC LIMIT 5");
  check("ZAXIRA: app_backup ga yozildi", bRows.rows.length >= 1, String(bRows.rows.length));
  const backupId = bRows.rows[0] ? Number(bRows.rows[0].id) : 0;
  check("ZAXIRA: id olindi", backupId > 0, String(backupId));
  const backupData = (await pgApi.query("SELECT data FROM app_backup WHERE id = $1", [backupId])).rows[0].data;
  check("ZAXIRA: nusxada balans 140", backupData.users["9750"].credits.available === 140, String(backupData.users["9750"].credits.available));

  /* ─── 3. Zaxiradan KEYIN mutatsiya (+60) ─── */
  const r2 = await api("user", { telegramId: 9750, action: "credits", amount: 60, client_token: "bk-2" });
  check("ZAXIRADAN KEYIN: +60 qo'llanadi", r2.ok, JSON.stringify(r2.body));
  const after = await waitState((s) => s.users["9750"].credits.available === 200);
  check("ZAXIRADAN KEYIN: balans 200", after.data.users["9750"].credits.available === 200, String(after.data.users["9750"].credits.available));
  const revBefore = Number(after.rev);

  /* ─── 4. Server to'xtatiladi (tiklash sharti) ─── */
  await stopServer();

  /* ─── 5. --list / --dry-run / --apply ─── */
  const list = restore(["--list"]);
  check("RESTORE --list: exit 0", list.status === 0, list.stderr);
  check("RESTORE --list: zaxirani ko'rsatadi", new RegExp(`#${backupId}`).test(list.stdout), list.stdout);
  const snapBefore = (await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1")).rows[0];
  const dry = restore(["--dry-run", "--id", String(backupId)]);
  check("RESTORE --dry-run: exit 0", dry.status === 0, dry.stderr);
  check("RESTORE --dry-run: 'yozilmadi'", /hech narsa yozilmadi/i.test(dry.stdout), dry.stdout);
  const snapAfterDry = (await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1")).rows[0];
  check("RESTORE --dry-run: baza O'ZGARMADI", JSON.stringify(snapBefore) === JSON.stringify(snapAfterDry));
  check("RESTORE --dry-run: farqni ko'rsatadi", /zaxiradagi/.test(dry.stdout) && /hozirgi/.test(dry.stdout), dry.stdout);

  const noConfirm = restore(["--apply", "--id", String(backupId)]);
  check("RESTORE --apply (confirm siz): rad etildi (exit 2)", noConfirm.status === 2, `status=${noConfirm.status}`);
  const missing = restore(["--apply", "--id", "999999", "--confirm"]);
  check("RESTORE mavjud bo'lmagan id: rad etildi (exit 2)", missing.status === 2, `status=${missing.status}`);
  const stillSame = (await pgApi.query("SELECT data FROM app_state WHERE id = 1")).rows[0].data;
  check("RESTORE rad etishlar bazani o'zgartirmadi", stillSame.users["9750"].credits.available === 200, String(stillSame.users["9750"].credits.available));

  const apply = restore(["--apply", "--id", String(backupId), "--confirm"]);
  check("RESTORE --apply --confirm: exit 0", apply.status === 0, apply.stderr);
  const restored = (await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1")).rows[0];
  check("RESTORE: balans zaxira holatiga qaytdi (140)", restored.data.users["9750"].credits.available === 140,
    String(restored.data.users["9750"].credits.available));
  check("RESTORE: keyingi +60 jurnali yo'q", !(restored.data.transactions || []).some((t) => t.idempotencyKey === "adminadj:panel:owner:bk-2"));
  check("RESTORE: rev o'sdi (CAS oynasi buzilmadi)", Number(restored.rev) > revBefore, `${revBefore} → ${restored.rev}`);
  const preRows = await pgApi.query("SELECT count(*)::int AS n FROM app_backup WHERE reason LIKE 'pre-restore%'");
  check("RESTORE: 'pre-restore' xavfsizlik nusxasi yaratildi", preRows.rows[0].n >= 1, String(preRows.rows[0].n));
  const preRow = await pgApi.query("SELECT data FROM app_backup WHERE reason LIKE 'pre-restore%' ORDER BY id DESC LIMIT 1");
  check("RESTORE: xavfsizlik nusxasida tiklashdan OLDINGI holat (200)", preRow.rows[0].data.users["9750"].credits.available === 200,
    String(preRow.rows[0].data.users["9750"].credits.available));
  check("RESTORE: ledger ↔ hamyon farqi 0", parity(restored.data, "u-9750").ok, JSON.stringify(parity(restored.data, "u-9750")));

  /* ─── 6. Server qayta ishga tushadi: tiklanган holat bilan ishlaydi ─── */
  startServer();
  await waitHttp();
  cookie = await login();
  const live = await waitState((s) => s && s.users && s.users["9750"]);
  check("QAYTA ISHGA TUSHISH: tiklanган holat yuklandi (140)", live.data.users["9750"].credits.available === 140,
    String(live.data.users["9750"].credits.available));
  const r3 = await api("user", { telegramId: 9750, action: "credits", amount: 5, client_token: "bk-3" });
  const post = await waitState((s) => s.users["9750"].credits.available === 145);
  check("QAYTA ISHGA TUSHISH: yangi yozuv ishlaydi (145)", r3.ok && post.data.users["9750"].credits.available === 145,
    String(post.data.users["9750"].credits.available));
  check("QAYTA ISHGA TUSHISH: ledger farqi 0", parity(post.data, "u-9750").ok, JSON.stringify(parity(post.data, "u-9750")));

  await stopServer();
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
  try {
    srv && srv.kill("SIGKILL");
  } catch {}
  try {
    mock && mock.kill();
  } catch {}
  try {
    pgApi && (await pgApi.stop());
  } catch {}
  process.exit(1);
});
