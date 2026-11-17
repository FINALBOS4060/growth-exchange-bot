#!/usr/bin/env node
// PostgreSQL MOSLIK tekshiruvi — FAQAT O'QIYDI (production ma'lumotiga yozmaydi).
//
//   DATABASE_URL=postgres://... node scripts/pg-compat-check.mjs
//   DATABASE_URL=... node scripts/pg-compat-check.mjs --json
//
// Nima tekshiriladi:
//   1. Server versiyasi (production versiyasi shu yerda ko'rinadi).
//   2. Ilova tayanadigan imkoniyatlar: `jsonb`, `hashtextextended` (64-bit
//      advisory kalit), `pg_try_advisory_lock` / `pg_advisory_unlock`,
//      `ADD COLUMN IF NOT EXISTS`, `to_regclass`, `ON CONFLICT`.
//   3. `app_state` jadvali: mavjudligi, `rev` ustuni, hajmi, oxirgi yozuv.
//   4. Advisory lock mexanizmi: TASODIFIY probe kaliti bilan olinadi va
//      DARHOL bo'shatiladi (production polling kaliti HECH QACHON olinmaydi).
//
// Yozadigan yagona narsa — hech narsa: barcha so'rovlar SELECT yoki
// sessiya-darajasidagi advisory lock (u `finally` da bo'shatiladi).
import crypto from "node:crypto";

const url = (process.env.DATABASE_URL || "").trim();
const asJson = process.argv.includes("--json");
if (!url) {
  console.error("DATABASE_URL berilmagan (production bazasiga ulanmaymiz).");
  process.exit(2);
}

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const checks = [];
const add = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail) });
  if (!asJson) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : detail ? `  (${detail})` : ""}`);
};

// Ilova qaysi minimal versiyani talab qiladi: `hashtextextended` (PG 11+),
// `ADD COLUMN IF NOT EXISTS` (PG 9.6+), `jsonb` (PG 9.4+), `ON CONFLICT` (9.5+).
const MIN_VERSION_NUM = 110000;

async function main() {
  const pgMod = await import("pg");
  const pg = pgMod.default || pgMod;
  const u = new URL(url);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  const cfg = { connectionString: url, max: 1, connectionTimeoutMillis: 15000 };
  // Testdagi kabi: lokal bo'lmagan manzilga SSL (production).
  if (!isLocal && u.searchParams.get("sslmode") !== "disable") cfg.ssl = { rejectUnauthorized: false };
  const client = new pg.Client(cfg);
  await client.connect();
  const probeKey = "probe:" + sha1(crypto.randomBytes(16));
  const out = { at: new Date().toISOString(), host: `${u.hostname}/${u.pathname.replace(/^\//, "")}`, checks, version: {}, appState: {}, probe: {} };
  try {
    /* 1. Versiya */
    const v = await client.query("SELECT version() AS v, current_setting('server_version_num') AS num");
    const num = Number(v.rows[0].num);
    out.version = { text: v.rows[0].v, num, min: MIN_VERSION_NUM };
    add("server_version >= 11 (hashtextextended)", num >= MIN_VERSION_NUM, v.rows[0].v);
    out.version.ok = num >= MIN_VERSION_NUM;

    /* 2. Imkoniyatlar (faqat SELECT) */
    const feat = async (name, sql, params = []) => {
      try {
        const r = await client.query(sql, params);
        add(name, true, String(r.rows[0] && Object.values(r.rows[0])[0] !== undefined ? Object.values(r.rows[0])[0] : ""));
        return r;
      } catch (e) {
        add(name, false, e.message);
        return null;
      }
    };
    await feat("jsonb", "SELECT '{\"a\":1}'::jsonb ->> 'a' AS v");
    // `hashtextextended` — bot token → 64-bit qulf kaliti (deterministik).
    const h1 = await feat("hashtextextended(text, bigint)", "SELECT hashtextextended('gxb:state', 0) AS v");
    const h2 = await client.query("SELECT hashtextextended('gxb:state', 0) AS v").catch(() => null);
    add("hashtextextended deterministik", !!h1 && !!h2 && String(h1.rows[0].v) === String(h2.rows[0].v), h2 ? String(h2.rows[0].v) : "n/a");
    await feat("pg_try_advisory_lock matn kaliti", "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS v", [probeKey]);
    // Probe qulfni DARHOL bo'shatamiz (production kaliti ishlatilmadi).
    let released = false;
    try {
      const r = await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS v", [probeKey]);
      released = !!r.rows[0].v;
    } catch (e) {
      released = false;
    }
    out.probe = { key: probeKey, released };
    add("pg_advisory_unlock (probe bo'shatildi)", released);
    // DDL imkoniyatlari versiya bo'yicha tekshiriladi — production bazasida
    // hech qanday CREATE/ALTER bajarilmaydi (audit faqat o'qiydi).
    add("ADD COLUMN IF NOT EXISTS (PG >= 9.6)", num >= 90600, num >= 90600 ? "mavjud" : "juda eski server");
    add("ON CONFLICT (PG >= 9.5)", num >= 90500, num >= 90500 ? "mavjud" : "juda eski server");
    await feat("to_regclass", "SELECT to_regclass('pg_class') AS v");

    /* 3. app_state */
    const t = await client.query("SELECT to_regclass('public.app_state') AS t");
    const exists = !!t.rows[0].t;
    // Jadval yo'qligi moslik XATOSI emas: ilova birinchi ishga tushishda
    // `CREATE TABLE IF NOT EXISTS` bilan yaratadi.
    add("app_state jadvali mavjud", true, exists ? "mavjud" : "yo'q — ilova birinchi ishga tushishda yaratadi");
    out.appState.exists = exists;
    if (exists) {
      const cols = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'app_state' ORDER BY ordinal_position"
      );
      const names = cols.rows.map((r) => r.column_name);
      out.appState.columns = names;
      // `rev` yo'qligi xato emas: birinchi deploy `ADD COLUMN IF NOT EXISTS`
      // bilan qo'shadi va mavjud ma'lumotga tegmaydi.
      add("app_state.rev ustuni (instanslararo CAS)", true,
        names.includes("rev") ? "mavjud" : "yo'q — birinchi deploy qo'shadi (ADD COLUMN IF NOT EXISTS)");
      out.appState.hasRev = names.includes("rev");
      // `rev` ustuni hali yo'q bo'lsa ham so'rov ishlashi kerak (deploy oldidan).
      const revExpr = names.includes("rev") ? "rev" : "NULL::bigint";
      const row = await client.query(
        `SELECT ${revExpr} AS rev, pg_column_size(data) AS bytes, data->>'seq' AS seq, jsonb_array_length(COALESCE(data->'transactions','[]'::jsonb)) AS tx FROM app_state WHERE id = 1`
      );
      if (row.rows.length) {
        const r0 = row.rows[0];
        out.appState.row = { rev: Number(r0.rev), bytes: Number(r0.bytes), seq: Number(r0.seq), transactions: Number(r0.tx) };
        add("app_state id=1 qatori mavjud", true, `rev=${r0.rev}, ${Math.round(Number(r0.bytes) / 1024)} KB, tx=${r0.tx}`);
        if (!names.includes("rev")) add("⚠ rev ustuni yo'q — birinchi deploy uni qo'shadi (ADD COLUMN IF NOT EXISTS)", true, "ma'lumot yo'qolmaydi");
      } else {
        add("app_state id=1 qatori mavjud", false, "jadval bo'sh");
      }
    }
    // Advisory lock jadvali ko'rinishi (kim ushlab turibdi — faqat o'qish).
    const locks = await client.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted");
    out.appState.advisoryLocks = locks.rows[0].n;
    add("advisory lock holati o'qiladi", true, `granted=${locks.rows[0].n}`);
  } finally {
    // Probe qulfni ikkinchi marta bo'shatishga urinmaymiz; ulanish yopilishi
    // bilan sessiya qulflari baribir bo'shaydi.
    try {
      await client.end();
    } catch {}
  }

  if (asJson) console.log(JSON.stringify(out, null, 2));
  const failed = checks.filter((c) => !c.ok).length;
  if (!asJson) console.log(`\n${checks.length - failed}/${checks.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("XATO:", e.message);
  process.exit(1);
});
