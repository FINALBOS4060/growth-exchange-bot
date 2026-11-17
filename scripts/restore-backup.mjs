#!/usr/bin/env node
// `app_backup` dan holatni TIKLASH — deploy/rollback uchun.
//
// Bu skript ATAYIN konservativ:
//   * `--list`      — mavjud zaxiralar (faqat SELECT).
//   * `--dry-run`   — tanlangan zaxira bilan hozirgi holat farqi (yozmaydi).
//   * `--apply --id N --confirm` — tiklaydi. Tiklashdan OLDIN hozirgi holat
//     `app_backup` ga "pre-restore" sababi bilan yoziladi (orqaga qaytish
//     yo'li ochiq qoladi).
//
// MUHIM: `--apply` faqat ilova TO'XTATILGAN holatda bajarilishi kerak — aks
// holda ishlab turgan jarayon o'z xotirasidagi holatni qayta yozib yuboradi.
// Skript `app_state.rev` ni +1 qiladi (CAS oynasini buzmaslik uchun).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : "";
};
const LIST = argv.includes("--list");
const DRY = argv.includes("--dry-run");
const APPLY = argv.includes("--apply");
const CONFIRM = argv.includes("--confirm");
const ID = Number(argOf("--id") || 0);

const counts = (db) => {
  const arr = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    users: Object.keys(db.users || {}).length,
    channels: arr(db.channels),
    orders: arr(db.orders),
    tasks: arr(db.tasks),
    transactions: arr(db.transactions),
    memberships: arr(db.memberships),
    membershipEvents: arr(db.membershipEvents),
    verificationJobs: arr(db.verificationJobs),
    referrals: arr(db.referrals),
    auditLog: arr(db.auditLog)
  };
};
const sum = (db) =>
  Object.values(db.users || {}).reduce(
    (a, u) => ({
      available: a.available + Number((u.credits || {}).available || 0),
      reserved: a.reserved + Number((u.credits || {}).reserved || 0),
      spent: a.spent + Number((u.credits || {}).spent || 0)
    }),
    { available: 0, reserved: 0, spent: 0 }
  );

async function pool() {
  if (!DATABASE_URL) return null;
  const pgMod = await import("pg");
  const pg = pgMod.default || pgMod;
  const u = new URL(DATABASE_URL);
  const cfg = { connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 };
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (!isLocal && u.searchParams.get("sslmode") !== "disable") cfg.ssl = { rejectUnauthorized: false };
  return new pg.Pool(cfg);
}

async function readBackups(p) {
  await p.query("CREATE TABLE IF NOT EXISTS app_backup (id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), reason text, size integer, data jsonb NOT NULL)");
  const r = await p.query("SELECT id, created_at, reason, size, data FROM app_backup ORDER BY id DESC LIMIT 50");
  return r.rows;
}

async function main() {
  const p = await pool();
  if (!p) {
    // Fayl rejimi: zaxiralar data/backups/state-*.json
    const dir = path.join(path.dirname(DATA_FILE), "backups");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("state-")).sort().reverse() : [];
    console.log(`Fayl rejimi: ${files.length} ta zaxira (${dir})`);
    for (const f of files.slice(0, 20)) console.log(`  ${f}  ${Math.round(fs.statSync(path.join(dir, f)).size / 1024)} KB`);
    const want = argOf("--file") || (LIST ? "" : "");
    if (!want) {
      if (APPLY) {
        console.error("Fayl rejimida `--apply` uchun `--file <nom>` bering.");
        process.exit(2);
      }
      return;
    }
    const src = path.join(dir, want);
    if (!fs.existsSync(src)) {
      console.error("Zaxira fayli topilmadi:", src);
      process.exit(2);
    }
    const db = JSON.parse(fs.readFileSync(src, "utf8"));
    console.log("Zaxiradan:", JSON.stringify(counts(db)), JSON.stringify(sum(db)));
    if (DRY || !APPLY) return;
    if (!CONFIRM) {
      console.error("Tiklash uchun `--confirm` kerak.");
      process.exit(2);
    }
    const safety = path.join(dir, `state-pre-restore-${Date.now()}.json`);
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, safety);
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    console.log("Tiklandi. Oldingi holat:", safety);
    return;
  }

  const rows = await readBackups(p);
  if (LIST || (!APPLY && !DRY)) {
    console.log(`Postgres: ${rows.length} ta zaxira (app_backup)`);
    for (const r of rows) {
      const c = counts(r.data);
      console.log(`  #${r.id}  ${new Date(r.created_at).toISOString()}  ${r.reason || "-"}  ${Math.round((r.size || 0) / 1024)} KB  users=${c.users} tx=${c.transactions}`);
    }
    await p.end();
    return;
  }
  const target = rows.find((r) => Number(r.id) === ID);
  if (!target) {
    console.error(`Zaxira #${ID} topilmadi (mavjud: ${rows.map((r) => r.id).join(", ") || "yo'q"})`);
    await p.end();
    process.exit(2);
  }
  const cur = await p.query("SELECT data, rev FROM app_state WHERE id = 1");
  const current = cur.rows[0] ? cur.rows[0].data : {};
  console.log(`Zaxira #${target.id} (${new Date(target.created_at).toISOString()}, ${target.reason || "-"})`);
  console.log("  zaxiradagi:", JSON.stringify(counts(target.data)), JSON.stringify(sum(target.data)));
  console.log("  hozirgi:   ", JSON.stringify(counts(current)), JSON.stringify(sum(current)));
  if (DRY || !APPLY) {
    console.log("\n--dry-run: hech narsa yozilmadi.");
    await p.end();
    return;
  }
  if (!CONFIRM) {
    console.error("Tiklash uchun `--apply --confirm` kerak (yozuv bo'ladi).");
    await p.end();
    process.exit(2);
  }
  // 1) Xavfsizlik nusxasi: hozirgi holat ham app_backup ga yoziladi.
  await p.query("INSERT INTO app_backup (reason, size, data) VALUES ($1, $2, $3::jsonb)", [
    `pre-restore (#${target.id})`,
    JSON.stringify(current).length,
    JSON.stringify(current)
  ]);
  // 2) Tiklash + rev ni oldinga surish (CAS oynasini buzmaslik uchun).
  const upd = await p.query(
    "UPDATE app_state SET data = $1::jsonb, rev = rev + 1, updated_at = now() WHERE id = 1 RETURNING rev",
    [JSON.stringify(target.data)]
  );
  console.log(`Tiklandi: app_state rev=${upd.rows[0] ? upd.rows[0].rev : "?"} (oldingi holat "pre-restore" sifatida saqlandi)`);
  await p.end();
}

main().catch((e) => {
  console.error("XATO:", e.message);
  process.exit(1);
});
