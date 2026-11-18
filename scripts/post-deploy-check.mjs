#!/usr/bin/env node
// Deploydan KEYINGI tekshiruvlar — FAQAT O'QIYDI (production biznes-ma'lumotiga yozmaydi).
//
//   node scripts/post-deploy-check.mjs
//   node scripts/post-deploy-check.mjs --url https://<servis>.onrender.com
//   node scripts/post-deploy-check.mjs --save-baseline --out data/baseline-pre.json
//   node scripts/post-deploy-check.mjs --baseline data/baseline-pre.json --strict
//
// Bo'limlar:
//   1. Holat snapshot'i (foydalanuvchi, buyurtma, a'zolik, voqealar, joblar).
//   2. Polling instanslari: qulf MEXANIZMI probe'i (alohida tasodifiy kalit,
//      har doim bo'shatiladi) + pg_locks orqali o'qish + /healthz.
//   3. Telegram "Conflict: terminated by other getUpdates" (Render loglari).
//   4. RECHECK/CHECK_ERROR vazifalar va ularning TASK_CHECK joblari.
//   5. Takroriy tekshiruv joblari.
//   6. Kredit rekonciliatsiyasi (matematik izchil, avtomatik TUZATILMAYDI).
//   7. A'zolik voqealar soni (baseline bilan solishtiriladi).
//
// XAVFSIZLIK:
//  - Production polling kaliti (`poll:<sha1(token)>`) HECH QACHON olinmaydi;
//    u faqat `pg_locks` orqali o'qiladi. Probe esa `probe:<tasodifiy 32 hex>`
//    kalitini oladi va `finally` ichida bo'shatadi.
//  - Biznes-ma'lumotga INSERT/UPDATE/DELETE yo'q. Yozadigan yagona narsa —
//    lokal baseline fayli (`--save-baseline`).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { summarizeRuntime, probeLockMechanism, freeUnitsPending } from "./lib/ledger-reconcile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : "";
};
const HEALTH_URL = argOf("--url") || process.env.HEALTH_URL || "";
const BASELINE = argOf("--baseline");
const SAVE_BASELINE = argv.includes("--save-baseline");
const STRICT = argv.includes("--strict");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const ok = (c) => (c ? "✓" : "✗");
const problems = [];
const fail = (msg) => problems.push(msg);

async function readState() {
  if (!DATABASE_URL) return { state: JSON.parse(fs.readFileSync(DATA_FILE, "utf8")), pool: null };
  const pgMod = await import("pg");
  const pg = pgMod.default || pgMod;
  const u = new URL(DATABASE_URL);
  const cfg = { connectionString: DATABASE_URL, max: 2, connectionTimeoutMillis: 1e4 };
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (!isLocal && u.searchParams.get("sslmode") !== "disable") cfg.ssl = { rejectUnauthorized: false };
  const pool = new pg.Pool(cfg);
  const r = await pool.query("SELECT data, updated_at FROM app_state WHERE id = 1");
  if (!r.rows.length) throw new Error("app_state bo'sh");
  return { state: r.rows[0].data, pool, updatedAt: r.rows[0].updated_at, dbIdentity: `${u.hostname}/${u.pathname.replace(/^\//, "")}` };
}

// ── 2. Qulf ────────────────────────────────────────────────────────────────
// Bot tokeni → production polling kaliti (token hech qachon chop etilmaydi).
function pollLockKey(token) {
  return "poll:" + sha1(token);
}

// server.js `tryLock(key)` ichida `hashtextextended("gxb:" + key, 0)` ishlatiladi.
// Prefiks tushib qolsa, fingerprint boshqa kalitni ko'rsatadi va qulf
// "BO'SH" deb noto'g'ri xabar beriladi (haqiqiy productionda esa qulf
// ushlab turilgan bo'ladi).
function pollLockName(token) {
  return "gxb:" + pollLockKey(token);
}

async function lockKeyFingerprint(pool, token) {
  const key = pollLockName(token);
  const r = await pool.query("SELECT hashtextextended($1, 0) AS k", [key]);
  return { key, value: String(r.rows[0].k), fp: sha1(key).slice(0, 12) };
}

// Faqat o'qiydi: berilgan 64-bit kalit hozir kimningdir qo'lida mi?
async function lockHolders(pool, keyValue) {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND classid::bigint = (($1::bigint >> 32) & 4294967295)
        AND objid::bigint   = ($1::bigint & 4294967295)`,
    [keyValue]
  );
  return r.rows[0].n;
}

// `/api/admin/health` — FAQAT O'QIYDIGAN GET, panel paroli bilan (parol
// chop etilmaydi). Berilmasa — bu qism o'tkazib yuboriladi.
async function adminHealth(base) {
  const pass = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pass) return { skipped: "ADMIN_PASSWORD berilmagan" };
  const user = (process.env.ADMIN_USER || "owner").trim();
  try {
    const lr = await fetch(base + "/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: user, password: pass })
    });
    if (!lr.ok) return { skipped: `login ${lr.status}` };
    const ck = (lr.headers.get("set-cookie") || "").split(";")[0];
    if (!ck) return { skipped: "sessiya cookie yo'q" };
    const r = await fetch(base + "/api/admin/health", { headers: { cookie: ck } });
    if (!r.ok) return { skipped: `/api/admin/health ${r.status}` };
    return { data: await r.json() };
  } catch (e) {
    return { skipped: e.message };
  }
}

async function renderConflictCount() {
  const keyFile = path.join(ROOT, ".render-key");
  const apiKey = (process.env.RENDER_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "")).trim();
  let serviceId = process.env.RENDER_SERVICE_ID || "";
  const stateFile = path.join(ROOT, ".render-state.json");
  let ownerId = "";
  if (!serviceId && fs.existsSync(stateFile)) {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      serviceId = st.serviceId || "";
      ownerId = st.ownerId || "";
    } catch {}
  }
  if (!apiKey || !serviceId) return { skipped: "RENDER_API_KEY / serviceId topilmadi" };
  // Render loglar endpoint'i: `/v1/logs?resource=<serviceId>` (eski
  // `/v1/services/<id>/logs` 404 qaytaradi va tekshiruv jimgina o'tkazib
  // yuborilardi — conflict hech qachon haqiqatda sanalmagan).
  const url = `https://api.render.com/v1/logs?resource=${serviceId}&limit=200${ownerId ? `&ownerId=${ownerId}` : ""}`;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  } catch (e) {
    // Tarmoq yo'q / Render API javob bermadi — bu tekshiruvni TO'XTATMAYDI
    // (checker read-only audit; tarmoq xatosi auditni yiqitmasligi kerak).
    return { skipped: `Render API ga ulanib bo'lmadi: ${e && e.message || e}` };
  }
  if (!res.ok) return { skipped: `Render logs ${res.status}` };
  const data = await res.json().catch(() => ({}));
  const instOf = (l) => {
    const lab = (l.labels || []).find((x) => x.name === "instance");
    return lab ? String(lab.value).split("-").pop() : "?";
  };
  const rows = (data.logs || []).map((l) => ({
    t: l.timestamp || "",
    inst: instOf(l),
    msg: String(l.message || "")
  }));
  const lines = rows.map((r) => `${r.t} ${r.msg}`);
  const conflicts = lines.filter((l) => /Conflict: terminated by other getUpdates/i.test(l));
  const starts = lines.filter((l) => /ishga tushdi|Bot @/i.test(l));
  // Deploy almashinuvi paytida eski instans SIGTERM oladi. Undan KEYINGI
  // conflictlar haqiqiy dublikat pollingni bildiradi.
  const sig = rows.filter((r) => /SIGTERM/.test(r.msg)).map((r) => r.t).sort();
  const lastSig = sig.length ? sig[sig.length - 1] : "";
  const afterSig = lastSig ? rows.filter((r) => r.t > lastSig) : rows;
  const conflictsAfter = afterSig.filter((r) => /Conflict: terminated by other getUpdates/i.test(r.msg));
  const instances = [...new Set(rows.filter((r) => r.inst !== "?").map((r) => r.inst))];
  return {
    total: lines.length,
    conflicts: conflicts.length,
    conflictsAfterShutdown: conflictsAfter.length,
    instanceCount: instances.length,
    lastConflict: conflicts.slice(-1)[0] || "",
    restartsSeen: starts.length
  };
}

// Baseline va post-deploy AYNAN bir xil qoidalar bilan sanaydi.
function buildCounts(db) {
  const arr = (v) => (Array.isArray(v) ? v.length : 0);
  const tx = db.transactions || [];
  const openJobs = (db.verificationJobs || []).filter((j) => j.status === "PENDING" || j.status === "RUNNING");
  return {
    users: Object.keys(db.users || {}).length,
    channels: arr(db.channels),
    igProfiles: arr(db.igProfiles),
    orders: arr(db.orders),
    tasks: arr(db.tasks),
    transactions: tx.length,
    memberships: arr(db.memberships),
    membershipEvents: arr(db.membershipEvents),
    verificationJobs: arr(db.verificationJobs),
    openVerificationJobs: openJobs.length,
    taskCheckJobs: (db.verificationJobs || []).filter((j) => j.jobType === "TASK_CHECK").length,
    archivedJobs: (db.verificationJobs || []).filter((j) => j.status === "ARCHIVED").length,
    recheckOrErrorTasks: (db.tasks || []).filter((t) => t.status === "RECHECK" || t.status === "CHECK_ERROR").length,
    spentTotal: Object.values(db.users || {}).reduce((a, u) => a + Number((u.credits || {}).spent || 0), 0)
  };
}

async function main() {
  const loaded = await readState();
  const db = loaded.state || loaded;
  const pool = loaded.pool || null;
  const storage = pool ? "postgres" : `fayl (${DATA_FILE})`;
  const dbIdentity = pool ? loaded.dbIdentity : path.resolve(DATA_FILE);
  const line = (t) => console.log(`\n── ${t} ──`);

  const counts = buildCounts(db);
  if (pool) {
    const t = await pool.query("SELECT to_regclass('public.verification_job_archive') AS t");
    if (t.rows[0].t) counts.archiveRecords = (await pool.query("SELECT count(*)::int AS n FROM verification_job_archive")).rows[0].n;
  }

  console.log(`Ombor: ${storage}${loaded.updatedAt ? `  (oxirgi saqlash: ${loaded.updatedAt})` : ""}`);
  // Muhim: `--url` bilan masofaviy servis tekshirilganda holat lokal fayldan
  // o'qilsa, 1/4–7 bo'limlar PRODUCTION emas, lokal ma'lumotni ko'rsatadi.
  // Buni jimgina qoldirmaslik kerak — hisobot noto'g'ri o'qiladi.
  if (!pool && HEALTH_URL) {
    console.log(
      `DIQQAT: 1, 4–7 bo'limlar LOKAL fayldan (${path.basename(DATA_FILE)}) — production emas.` +
        " Production holati uchun DATABASE_URL bering (checker faqat o'qiydi)."
    );
  }
  line("1. Holat snapshot'i");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  line("2. Polling instanslari");
  if (pool) {
    try {
      const p = await probeLockMechanism(pool);
      console.log(`  qulf mexanizmi (probe kaliti, tasodifiy, production kaliti emas): ${ok(p.acquired && p.released)}${p.acquired ? " olinadi va bo'shatiladi" : " OLINMADI"}`);
      if (!(p.acquired && p.released)) fail("advisory lock mexanizmi ishlamayapti");
    } catch (e) {
      console.log(`  qulf mexanizmi probe'i bajarilmadi: ${e.message} (production kaliti olinmadi)`);
      fail(`probe xatosi: ${e.message}`);
    }
    const bots = (db.settings && db.settings.bots) || [];
    for (const b of bots) {
      if (!b.token) continue;
      try {
        const f = await lockKeyFingerprint(pool, b.token);
        const holders = await lockHolders(pool, f.value);
        console.log(`  bot ${b.id || "?"} (${b.role || "-"}) kalit ${f.fp}: ${holders > 0 ? `QULFLANGAN (${holders} sessiya polling qilmoqda)` : "BO'SH (hozir polling yo'q)"}`);
        if (holders > 1) fail(`bot ${b.id}: ${holders} sessiya bir xil polling kalitini ushlab turibdi`);
      } catch (e) {
        console.log(`  bot ${b.id || "?"}: pg_locks o'qilmadi (${e.message}) — /healthz dan foydalaning`);
      }
    }
  } else {
    console.log("  Postgres yo'q — advisory lock tekshiruvi o'tkazib yuborildi");
  }
  if (HEALTH_URL) {
    const base = HEALTH_URL.replace(/\/+$/, "");
    try {
      // `/healthz` — Render health probe: qisqa MATN javobi ("ok postgres").
      const res = await fetch(base + "/healthz");
      const text = (await res.text()).trim();
      console.log(`  /healthz: ${res.status}, javob: "${text.slice(0, 40)}"`);
      console.log(`  ${ok(res.ok)} healthz 200 qaytaradi`);
      if (!res.ok) fail(`/healthz ${res.status}`);
      // Botlar holati JSON emas — admin health orqali o'qiladi (read-only GET).
      const info = await adminHealth(base);
      if (info.skipped) {
        console.log(`  botlar holati o'qilmadi: ${info.skipped} (pg_locks tekshiruvi yuqorida)`);
      } else {
        const h = info.data;
        const bots = h.bots || [];
        const online = bots.filter((b) => b.online);
        console.log(`  /api/admin/health: storage=${h.storage}, online botlar=${online.length}/${bots.length}`);
        for (const b of bots) console.log(`     ${b.id}: online=${b.online} enabled=${b.enabled} ${b.lastError ? `xato="${b.lastError}"` : ""}`);
        // Bir nechta bot (asosiy + ishchi) bir vaqtda online bo'lishi NORMAL:
        // har biri o'z tokeni, o'z qulfi bilan polling qiladi. Dublikat
        // instans faqat BITTA token uchun ikki sessiya bo'lsa xavfli — buni
        // yuqoridagi pg_locks tekshiruvi (holders > 1) aniqlaydi.
        const ids = online.map((b) => b.id);
        const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
        console.log(`  ${ok(!dupIds.length)} faol polling botlari: ${online.length} (${ids.join(", ") || "-"})`);
        if (dupIds.length) fail(`bir xil bot id ikki marta online: ${dupIds.join(", ")}`);
        if (h.memberships) console.log(`  memberships: ${JSON.stringify(h.memberships)}`);
      }
    } catch (e) {
      console.log(`  /healthz o'qilmadi: ${e.message}`);
      fail(`/healthz o'qilmadi: ${e.message}`);
    }
  } else {
    console.log("  --url berilmagan — /healthz va botlar holati tekshirilmadi");
  }

  line("3. Telegram Conflict");
  const c = await renderConflictCount();
  if (c.skipped) console.log(`  o'tkazib yuborildi: ${c.skipped}`);
  else {
    console.log(`  oxirgi ${c.total} log satrida "Conflict: terminated by other getUpdates": ${c.conflicts}`);
    if (c.lastConflict) console.log(`  oxirgisi: ${c.lastConflict}`);
    console.log(`  oxirgi SIGTERM dan keyin: ${c.conflictsAfterShutdown}` +
      (c.conflicts > 0 ? "  (deploy almashinuvi paytida eski instans hali polling qilgan bo'lishi mumkin)" : ""));
    console.log(`  log oynasidagi instanslar: ${c.instanceCount}`);
    console.log(`  ${ok(c.conflictsAfterShutdown === 0)} ${c.conflictsAfterShutdown === 0 ? "qulfdan keyin conflict yo'q" : "SIGTERM dan keyin ham conflict — qulf ishlamayapti"}`);
    if (c.conflictsAfterShutdown > 0) fail(`SIGTERM dan keyingi Conflict yozuvlari: ${c.conflictsAfterShutdown}`);
  }

  line("4. RECHECK / CHECK_ERROR vazifalar va TASK_CHECK joblari");
  const stuck = (db.tasks || []).filter((t) => t.status === "RECHECK" || t.status === "CHECK_ERROR");
  const jobs = db.verificationJobs || [];
  for (const t of stuck) {
    const js = jobs.filter((j) => j.jobType === "TASK_CHECK" && j.taskId === t.id);
    const open = js.filter((j) => j.status === "PENDING" || j.status === "RUNNING");
    console.log(`  ${t.id} [${t.status}] → ${js.length} job, ochiq ${open.length}` +
      (open.length ? ` (keyingi: ${open.map((j) => j.scheduledAt).sort()[0]}, urinish ${open.map((j) => j.attemptCount || 0).join("/")})` : ""));
    console.log(`     ${ok(open.length === 1)} ${open.length === 1 ? "aynan bitta ochiq retry jobi" : "job soni kutilgandan farq qiladi"}`);
    if (open.length !== 1) fail(`${t.id}: ochiq TASK_CHECK jobi ${open.length} ta (1 bo'lishi kerak)`);
  }
  if (!stuck.length) console.log("  RECHECK/CHECK_ERROR vazifa yo'q");
  const archived = jobs.filter((j) => j.jobType === "TASK_CHECK" && j.status === "ARCHIVED");
  if (archived.length) console.log(`  arxivlangan (ARCHIVED) joblar: ${archived.length} — o'chirilmagan, arxiv nusxasi bor`);

  line("5. Takroriy tekshiruv joblari");
  const dups = new Map();
  for (const j of jobs) {
    if (j.status !== "PENDING" && j.status !== "RUNNING") continue;
    const k = j.jobType === "TASK_CHECK" ? `task:${j.taskId}` : `mem:${j.membershipId}:${j.jobType}`;
    dups.set(k, [...(dups.get(k) || []), j.id]);
  }
  const dupKeys = [...dups.entries()].filter(([, v]) => v.length > 1);
  console.log(`  ochiq joblar: ${[...dups.values()].reduce((a, v) => a + v.length, 0)}, takror guruhlar: ${dupKeys.length}`);
  for (const [k, v] of dupKeys.slice(0, 10)) console.log(`     ${k}: ${v.join(", ")}`);
  console.log(`  ${ok(dupKeys.length === 0)} ${dupKeys.length ? "takror job bor" : "takror yo'q"}`);
  if (dupKeys.length) fail(`takror ochiq job guruhlari: ${dupKeys.length}`);

  /* ── 6. Kredit rekonciliatsiyasi ─────────────────────────────────────── */
  line("6. Kredit rekonciliatsiyasi (o'qish-only, hech narsa tuzatilmaydi)");
  console.log("  Sxema: amaldagi `transactions[].amount` modeli (available-only)");
  console.log("    available = Σ amount");
  console.log("    reserved  = Σ|order_spend| − Σ(order_refund) − spent");
  console.log("    total     = available + reserved");
  const rec = summarizeRuntime(db.users || {}, db.transactions || [], db.orders || []);
  console.log(`  foydalanuvchi: ${rec.users}, mos: ${rec.matched}, farqli: ${rec.mismatched}, manfiy available: ${rec.negative}`);
  console.log(`  yig'ma stored: available=${rec.totals.stored.available} reserved=${rec.totals.stored.reserved} total=${rec.totals.stored.total}`);
  console.log(`  yig'ma ledger: available=${rec.totals.calc.available} reserved=${rec.totals.calc.reserved} total=${rec.totals.calc.total}`);
  const aggOk = rec.totals.stored.available === rec.totals.calc.available && rec.totals.stored.reserved === rec.totals.calc.reserved;
  console.log(`  ${ok(aggOk)} yig'ma muvofiqlik`);
  for (const p of rec.perUser.filter((x) => !x.ok).slice(0, 10)) {
    console.log(`     ${p.userId}: available ${p.stored.available}↔${p.calc.available} (farq ${p.delta.available}), ` +
      `reserved ${p.stored.reserved}↔${p.calc.reserved} (farq ${p.delta.reserved})`);
    if (p.causes.length) console.log(`        sabab: ${p.causes.join("; ")}`);
  }
  if (rec.orphanTxUsers.length) console.log(`  jurnalda egasi topilmagan yozuvlar: ${rec.orphanTxUsers.length} (hisob o'chirilgan bo'lishi mumkin)`);
  const freePending = freeUnitsPending(db.orders || []);
  if (freePending.units)
    console.log(`  eslatma: ${freePending.orders} faol buyurtmada jami ${freePending.units} bepul birlik — reserved ularni ham qamraydi, bekor qilishda faqat pullik qism qaytariladi`);
  if (rec.negative) fail(`${rec.negative} foydalanuvchida manfiy available`);
  const zeroSum = Object.values(db.users || {}).reduce((a, u) => a + Number((u.credits || {}).available || 0) + Number((u.credits || {}).reserved || 0), 0);
  console.log(`  jami hamyon (available+reserved): ${zeroSum}, ledger total: ${rec.totals.calc.total}`);
  const keys = (db.transactions || []).map((t) => t.idempotencyKey).filter(Boolean);
  const dupTx = keys.length - new Set(keys).size;
  console.log(`  ${ok(dupTx === 0)} takror idempotencyKey: ${dupTx}`);
  if (dupTx) fail(`takror idempotencyKey: ${dupTx}`);

  // Maqsadli (delta) sxema, agar migratsiya allaqachon qilingan bo'lsa.
  if (pool) {
    const t = await pool.query("SELECT to_regclass('public.credit_transactions') AS t");
    if (t.rows[0].t) {
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name IN ('credit_transactions','credit_wallets')"
      );
      const names = new Set(cols.rows.map((r) => r.column_name));
      if (names.has("available_delta") && names.has("credit_wallets")) {
        const q = await pool.query(`
          SELECT w.user_id, w.available, w.reserved,
                 COALESCE(SUM(t.available_delta),0)::bigint AS calc_available,
                 COALESCE(SUM(t.reserved_delta),0)::bigint  AS calc_reserved
            FROM credit_wallets w
            LEFT JOIN credit_transactions t ON t.user_id = w.user_id
           GROUP BY w.user_id, w.available, w.reserved
          HAVING w.available <> COALESCE(SUM(t.available_delta),0)
              OR w.reserved  <> COALESCE(SUM(t.reserved_delta),0)`);
        console.log(`  delta sxemasi (credit_wallets/credit_transactions): muvofiq emas ${q.rows.length} hamyon`);
        console.log("    available = opening + Σ available_delta; reserved = opening + Σ reserved_delta; total = available + reserved");
        if (q.rows.length) fail(`delta sxemada ${q.rows.length} hamyon mos emas`);
      } else {
        console.log("  delta sxemasi: jadvallar bor, lekin `available_delta` ustuni yo'q — o'tkazib yuborildi");
      }
    } else {
      console.log("  delta sxemasi: hali migratsiya qilinmagan (credit_transactions yo'q)");
    }
  }

  /* ── 6b. Referal mukofoti (kelishuv: 300 kredit, bir marta) ─────────── */
  line("6b. Referal mukofoti (300 kredit, bir marta)");
  const refTxs = (db.transactions || []).filter((t) => t.type === "REFERRAL_REWARD");
  const agreed = 300;
  const amounts = [...new Set(refTxs.map((t) => Number(t.amount) || 0))];
  console.log(`  REFERRAL_REWARD yozuvlari: ${refTxs.length}, summalar: ${JSON.stringify(amounts)}`);
  const badAmount = refTxs.filter((t) => Number(t.amount) !== agreed);
  console.log(`  ${ok(badAmount.length === 0)} ${badAmount.length ? `${badAmount.length} ta yozuv 300 dan farq qiladi` : "hammasi 300 kredit"}`);
  if (badAmount.length) fail(`REFERRAL_REWARD summasi 300 emas: ${badAmount.length} ta`);
  const refKeys = refTxs.map((t) => t.idempotencyKey || "").filter(Boolean);
  const dupRef = refKeys.length - new Set(refKeys).size;
  console.log(`  ${ok(dupRef === 0)} takror refreward kaliti: ${dupRef}`);
  if (dupRef) fail(`takror referal kaliti: ${dupRef}`);
  const paidRefs = (db.referrals || []).filter((r) => r.bonusIssued);
  const paidWithoutTx = paidRefs.filter((r) => !refTxs.some((t) => t.referralId === r.id || String(t.idempotencyKey || "") === `refreward:${r.id}`));
  console.log(`  bonusIssued=${paidRefs.length}, jurnalsiz: ${paidWithoutTx.length}`);
  if (paidWithoutTx.length) {
    // Eski (300 kredit qoidasidan oldingi) yozuvlar bo'lishi mumkin — bu
    // avtomatik tuzatilmaydi, faqat hisobot beriladi.
    console.log(`     ⚠ ${paidWithoutTx.length} ta referal bonus berilgan deb belgilangan, lekin REFERRAL_REWARD yozuvi yo'q (eski/legacy yozuv bo'lishi mumkin)`);
  }

  /* ── 6c. A'zolik qayta tekshiruvi navbati (24 soatlik) ──────────────── */
  line("6c. A'zolik qayta tekshiruvi (24 soatlik navbat)");
  const mems = db.memberships || [];
  const active = mems.filter((m) => m.status === "ACTIVE");
  const nowMs = Date.now();
  const dueNow = active.filter((m) => Date.parse(m.nextCheckAt || "0") <= nowMs);
  const neverScheduled = active.filter((m) => !m.nextCheckAt);
  const recheckJobs = jobs.filter((j) => j.jobType === "RECHECK");
  const recheckOpen = recheckJobs.filter((j) => j.status === "PENDING" || j.status === "RUNNING");
  const recheckLate = recheckOpen.filter((j) => nowMs - Date.parse(j.scheduledAt || "0") > 6 * 36e5);
  const errMem = mems.filter((m) => (m.consecutiveCheckErrors || 0) > 0);
  console.log(`  ACTIVE a'zolik: ${active.length}, nextCheckAt kelgan: ${dueNow.length}, navbatga qo'yilmagan: ${neverScheduled.length}`);
  console.log(`  RECHECK joblar: jami ${recheckJobs.length}, ochiq ${recheckOpen.length}, 6 soatdan kechikkan ${recheckLate.length}`);
  console.log(`  CHECK_ERROR holatidagi a'zolik: ${errMem.length} (vaqtinchalik xato — obunadan chiqish EMAS)`);
  console.log(`  ${ok(neverScheduled.length === 0)} ${neverScheduled.length ? "nextCheckAt yo'q a'zoliklar bor" : "hammasida keyingi tekshiruv vaqti bor"}`);
  if (neverScheduled.length) fail(`nextCheckAt yo'q ACTIVE a'zolik: ${neverScheduled.length}`);
  if (recheckLate.length > 0) console.log(`     ⚠ ${recheckLate.length} ta RECHECK jobi kechikkan — scheduler ishlayaptimi?`);
  // Tarqatilganmi: bir xil daqiqaga to'plangan bo'lsa ogohlantiramiz (bir zumda yuk).
  const buckets = new Map();
  for (const j of recheckOpen) {
    const k = String(j.scheduledAt || "").slice(0, 16);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const worst = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst) console.log(`  eng katta bir vaqtli guruh: ${worst[1]} job (${worst[0]})`);

  line("7. A'zolik voqealari");
  console.log(`  membershipEvents: ${counts.membershipEvents}, memberships: ${counts.memberships}`);
  if (BASELINE && fs.existsSync(BASELINE)) {
    const b = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    // Bir xil baza va bir xil sanash qoidalari bo'lishi shart.
    if (b.storage && b.storage !== storage) {
      console.log(`  ⚠ baseline boshqa ombordan (${b.storage}) — solishtirish bekor qilindi`);
      fail("baseline boshqa ombor/baza uchun olingan");
    } else if (b.dbIdentity && b.dbIdentity !== dbIdentity) {
      console.log(`  ⚠ baseline boshqa bazadan (${b.dbIdentity}) — solishtirish bekor qilindi`);
      fail("baseline boshqa bazadan olingan");
    } else if (b.countsSchema !== 2) {
      console.log("  ⚠ baseline eski sanash qoidalari bilan olingan — qayta oling");
    } else {
      for (const k of Object.keys(b.counts || {})) {
        const before = b.counts[k];
        const after = counts[k] === undefined ? 0 : counts[k];
        const bad = after < before;
        console.log(`  ${k}: ${before} → ${after} ${ok(!bad)}${bad ? " — MA'LUMOT KAMAYDI!" : ""}`);
        if (bad) fail(`${k} kamaydi: ${before} → ${after}`);
      }
    }
  }
  if (SAVE_BASELINE) {
    const out = argOf("--out") || path.join(ROOT, "data", "baseline-pre.json");
    fs.writeFileSync(
      out,
      JSON.stringify({ at: new Date().toISOString(), storage, dbIdentity, countsSchema: 2, counts, ledger: { model: rec.model, matched: rec.matched, mismatched: rec.mismatched, totals: rec.totals } }, null, 2)
    );
    console.log(`  baseline saqlandi: ${out} (lokal fayl, productionga yozilmaydi)`);
  }

  if (pool) await pool.end();

  if (problems.length) {
    console.log(`\n${problems.length} muammo:`);
    for (const p of problems) console.log(`  - ${p}`);
    // `process.exit()` o'rniga `exitCode`: Windows'da ochiq ulanish
    // yopilib bo'layotganda majburiy chiqish libuv assertion'iga olib keladi.
    if (STRICT) process.exitCode = 1;
  } else {
    console.log("\nBarcha tekshiruvlar ✓");
  }
}

main().catch((e) => {
  console.error("XATO:", e.message);
  process.exitCode = 1;
});
