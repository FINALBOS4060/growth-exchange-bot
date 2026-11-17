#!/usr/bin/env node
// TASK_CHECK joblarini ARXIVLASH / TIKLASH (rollback vositasi).
//
// MUHIM: bu vosita HECH NARSANI O'CHIRMAYDI.
//   1. `archive`  — joblarning to'liq nusxasini alohida arxiv omboriga yozadi,
//                   nusxani asl bilan maydon-bay-maydon solishtiradi, so'ngra
//                   (faqat --apply bilan) jobni DELETE qilmasdan `status` ni
//                   "ARCHIVED" ga o'zgartiradi.
//   2. `verify`   — faqat o'qiydi: arxiv ↔ jonli holat mosligini tekshiradi.
//   3. `restore`  — arxivdagi joblarni `PENDING` ga qaytaradi (arxiv qoladi).
//
// Nega `status` o'zgartiriladi? Eski (qulfdan oldingi) build `jobType` ni
// ajratmaydi va TASK_CHECK jobini oddiy a'zolik tekshiruvi deb bajaradi:
// `ensureMembership(job.userId, job.channelId)` orqali yolg'on a'zolik yozuvi
// yaratadi. Eski kod faqat `status === "PENDING"` joblarni oladi, shuning uchun
// `ARCHIVED` ularni xavfsiz to'xtatadi — barcha maydonlar joyida qoladi.
//
// Ishlatish:
//   node scripts/archive-task-check-jobs.mjs                # dry-run (yozmaydi)
//   node scripts/archive-task-check-jobs.mjs --apply        # arxiv + ARCHIVED
//   node scripts/archive-task-check-jobs.mjs verify
//   node scripts/archive-task-check-jobs.mjs restore --apply
//
// Saqlash: DATABASE_URL bo'lsa Postgres, bo'lmasa DATA_FILE (standart
// ./data/db.json). Postgres'da arxiv ALOHIDA jadvalda
// (`verification_job_archive`) — shuning uchun ilova ishlab turgan bo'lsa ham
// yoziladi va `app_state` ning keyingi saqlanishi uni o'chirib yubormaydi.
// `status` ni o'zgartirish esa `app_state` ga yozadi: buni **ilova to'xtatilgan
// holda** bajarish shart (aks holda ilova xotiradagi holatni qayta yozadi).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const ARCHIVE_DIR = path.join(path.dirname(DATA_FILE), "archives");
const JOB_TYPE = "TASK_CHECK";
const ARCHIVED = "ARCHIVED";

const argv = process.argv.slice(2);
const mode = (argv.find((a) => ["archive", "verify", "restore"].includes(a)) || "archive");
const APPLY = argv.includes("--apply");

// --- kanonik JSON: maydon tartibidan qat'i nazar bir xil natija ---
function canon(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

// --- omborlar ---
async function pgPool() {
  const pgMod = await import("pg");
  const pg = pgMod.default || pgMod;
  const u = new URL(DATABASE_URL);
  const cfg = { connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 1e4 };
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (!isLocal && u.searchParams.get("sslmode") !== "disable") cfg.ssl = { rejectUnauthorized: false };
  return new pg.Pool(cfg);
}

function readFileState() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeFileState(state) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}
function fileArchives() {
  try {
    return fs.readdirSync(ARCHIVE_DIR)
      .filter((f) => f.startsWith("task-check-") && f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf8")));
  } catch {
    return [];
  }
}

async function readState(pool) {
  if (!pool) return readFileState();
  const r = await pool.query("SELECT data FROM app_state WHERE id = 1");
  if (!r.rows.length) throw new Error("app_state jadvalida holat yo'q (id=1)");
  return r.rows[0].data;
}
// Ilova to'xtatilgan bo'lishi shart — shuning uchun oddiy o'qish/yozish.
async function writeState(pool, state) {
  if (!pool) return writeFileState(state);
  await pool.query("UPDATE app_state SET data = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(state)]);
}
async function saveArchive(pool, rec) {
  if (!pool) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2));
    return path.join(ARCHIVE_DIR, `${rec.id}.json`);
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS verification_job_archive (
       id text PRIMARY KEY,
       archived_at timestamptz NOT NULL DEFAULT now(),
       reason text,
       count integer NOT NULL,
       checksum text NOT NULL,
       job_ids jsonb NOT NULL,
       jobs jsonb NOT NULL
     )`
  );
  await pool.query(
    "INSERT INTO verification_job_archive (id, reason, count, checksum, job_ids, jobs) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT (id) DO NOTHING",
    [rec.id, rec.reason, rec.count, rec.checksum, JSON.stringify(rec.jobIds), JSON.stringify(rec.jobs)]
  );
  return `postgres:verification_job_archive/${rec.id}`;
}
async function loadArchives(pool) {
  if (!pool) return fileArchives();
  const exists = await pool.query("SELECT to_regclass('public.verification_job_archive') AS t");
  if (!exists.rows[0].t) return [];
  const r = await pool.query("SELECT id, reason, count, checksum, job_ids, jobs FROM verification_job_archive ORDER BY archived_at");
  return r.rows.map((x) => ({ id: x.id, reason: x.reason, count: x.count, checksum: x.checksum, jobIds: x.job_ids, jobs: x.jobs }));
}

// Job maydonlarining barchasi saqlanadi; faqat `status` ataylab o'zgaradi.
const META = new Set(["status", "archivedAt", "archiveId"]);

function diffJob(original, live) {
  const out = [];
  for (const k of Object.keys(original)) {
    if (META.has(k)) continue;
    if (canon(original[k]) !== canon(live[k])) out.push(`${k}: ${canon(original[k])} → ${canon(live[k])}`);
  }
  for (const k of Object.keys(live)) {
    if (k in original || META.has(k)) continue;
    out.push(`+${k}: ${canon(live[k])}`);
  }
  return out;
}

function snapshot(rec, live) {
  const byId = new Map(live.map((j) => [j.id, j]));
  const missing = [];
  const changed = [];
  const stillPending = [];
  for (const j of rec.jobs) {
    const cur = byId.get(j.id);
    if (!cur) {
      missing.push(j.id);
      continue;
    }
    const d = diffJob(j, cur);
    if (d.length) changed.push({ id: j.id, fields: d });
    if (cur.status === "PENDING" || cur.status === "RUNNING") stillPending.push(j.id);
  }
  return { missing, changed, stillPending };
}

function report(rec, live) {
  const s = snapshot(rec, live);
  // `stillPending` — xato emas: restore'dan keyin joblar ataylab PENDING bo'ladi.
  // Xato faqat job yo'qolsa yoki biror maydon o'zgargan bo'lsa.
  const ok = !s.missing.length && !s.changed.length;
  console.log(`  arxiv: ${rec.id} — ${rec.count} ta job, checksum ${rec.checksum.slice(0, 12)}…`);
  console.log(`  jonli holatda topildi: ${rec.count - s.missing.length}/${rec.count}`);
  if (s.missing.length) console.log(`  ✗ YO'QOLGAN joblar: ${s.missing.join(", ")}`);
  if (s.changed.length) {
    console.log("  ✗ O'ZGARGAN maydonlar:");
    for (const c of s.changed) console.log(`     ${c.id}: ${c.fields.join("; ")}`);
  }
  if (s.stillPending.length) console.log(`  i Hali PENDING/RUNNING (arxivdan keyin qayta yoqilgan yoki restore qilingan): ${s.stillPending.join(", ")}`);
  console.log(ok ? "  ✓ Arxiv bilan to'liq mos" : "  ✗ Mos emas");
  return ok;
}

async function main() {
  const pool = DATABASE_URL ? await pgPool() : null;
  const where = pool ? "Postgres (app_state + verification_job_archive)" : `fayl (${DATA_FILE})`;
  console.log(`Ombor: ${where}`);
  console.log(`Rejim: ${mode}${APPLY ? " (--apply)" : " (dry-run)"}`);

  const state = await readState(pool);
  const live = (state.verificationJobs || []).filter((j) => j.jobType === JOB_TYPE);
  console.log(`Jonli TASK_CHECK joblar: ${live.length}`);

  if (mode === "verify") {
    const arcs = await loadArchives(pool);
    if (!arcs.length) {
      console.log("Arxiv yozuvi yo'q — tekshirish uchun hech narsa yo'q.");
      if (pool) await pool.end();
      return 0;
    }
    let ok = true;
    for (const rec of arcs) ok = report(rec, live) && ok;
    // checksum o'zi ham qayta hisoblanadi (arxiv fayli buzilmaganini isbotlaydi).
    for (const rec of arcs) {
      const sum = sha1(canon(rec.jobs));
      if (sum !== rec.checksum) {
        console.log(`  ✗ ${rec.id}: checksum mos emas (kutilgan ${rec.checksum}, hisoblangan ${sum})`);
        ok = false;
      }
      if (rec.jobIds.length !== rec.count || rec.jobs.length !== rec.count) {
        console.log(`  ✗ ${rec.id}: count/ids nomuvofiq`);
        ok = false;
      }
    }
    if (pool) await pool.end();
    console.log(ok ? "\nNATIJA: arxiv butun, hech narsa yo'qolmagan." : "\nNATIJA: muammo topildi.");
    return ok ? 0 : 1;
  }

  if (mode === "restore") {
    const arcs = await loadArchives(pool);
    if (!arcs.length) throw new Error("arxiv yozuvi yo'q — tiklash uchun ma'lumot yo'q");
    const rec = arcs[arcs.length - 1];
    const byId = new Map((state.verificationJobs || []).map((j) => [j.id, j]));
    let restored = 0;
    for (const j of rec.jobs) {
      const cur = byId.get(j.id);
      if (!cur) throw new Error(`job ${j.id} jonli holatda topilmadi — tiklash bekor qilindi (ma'lumot yo'qolgan bo'lishi mumkin)`);
      if (cur.status !== ARCHIVED) continue;
      // Maydonlar tegilmaydi: faqat status va arxiv belgilari.
      cur.status = "PENDING";
      delete cur.archivedAt;
      delete cur.archiveId;
      restored++;
    }
    console.log(`Tiklanadigan joblar: ${restored}`);
    if (!APPLY) {
      console.log("dry-run: hech narsa yozilmadi (--apply bilan qayta ishga tushiring)");
    } else {
      if (!pool) console.log("DIQQAT: ilova to'xtatilgan bo'lishi shart (fayl qayta yoziladi).");
      await writeState(pool, state);
      console.log(`✓ ${restored} ta job PENDING ga qaytarildi; arxiv yozuvi ${rec.id} saqlanib qoldi`);
    }
    if (pool) await pool.end();
    return 0;
  }

  // --- archive ---
  if (!live.length) {
    console.log("Arxivlash uchun TASK_CHECK job yo'q.");
    if (pool) await pool.end();
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rec = {
    id: `task-check-${stamp}`,
    archivedAt: new Date().toISOString(),
    reason: "rollback: eski build TASK_CHECK jobini bajarolmaydi",
    storage: pool ? "postgres" : "file",
    count: live.length,
    jobIds: live.map((j) => j.id),
    checksum: sha1(canon(live)),
    jobs: JSON.parse(JSON.stringify(live))
  };
  console.log(`Arxiv yozuvi: ${rec.id} (${rec.count} ta job, checksum ${rec.checksum.slice(0, 12)}…)`);

  if (!APPLY) {
    for (const j of live) {
      console.log(`  - ${j.id}  task=${j.taskId}  status=${j.status}  urinish=${j.attemptCount || 0}  key=${j.idempotencyKey}`);
    }
    console.log("dry-run: hech narsa yozilmadi (--apply bilan qayta ishga tushiring)");
    if (pool) await pool.end();
    return 0;
  }

  const loc = await saveArchive(pool, rec);
  console.log(`✓ Arxiv saqlandi: ${loc}`);

  // Nusxa asl bilan aynan bir xil bo'lishi shart — aks holda to'xtatamiz.
  const stored = (await loadArchives(pool)).find((a) => a.id === rec.id);
  if (!stored) throw new Error("arxiv yozuvi o'qib bo'lmadi");
  if (stored.checksum !== rec.checksum || canon(stored.jobs) !== canon(rec.jobs)) {
    throw new Error("arxiv nusxasi aslga mos emas — status o'zgartirilmadi");
  }
  if (stored.count !== live.length || canon(stored.jobIds) !== canon(live.map((j) => j.id))) {
    throw new Error("arxivdagi count/ID lar mos emas — status o'zgartirilmadi");
  }
  console.log("✓ Nusxa asl bilan maydon-bay-maydon mos (count, ID, checksum)");

  let marked = 0;
  for (const j of state.verificationJobs || []) {
    if (j.jobType !== JOB_TYPE) continue;
    if (j.status === ARCHIVED) continue;
    j.status = ARCHIVED;
    j.archivedAt = rec.archivedAt;
    j.archiveId = rec.id;
    marked++;
  }
  if (!pool) console.log("DIQQAT: ilova to'xtatilgan bo'lishi shart (fayl qayta yoziladi).");
  await writeState(pool, state);
  console.log(`✓ ${marked} ta job ARCHIVED ga o'tkazildi (o'chirilmadi)`);

  report(rec, (state.verificationJobs || []).filter((j) => j.jobType === JOB_TYPE));
  if (pool) await pool.end();
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error("XATO:", e.message);
    process.exit(1);
  });
