// PG MOSLIK tekshiruvi (`scripts/pg-compat-check.mjs`) — alohida PG muhitida.
//
// Bu test skriptning O'ZINI sinaydi (haqiqiy server.js ishga tushirilmaydi):
//   1. `DATABASE_URL` yo'q → skript rad etadi (exit 2), hech qayerga ulanmaydi.
//   2. Mos PG 18 → exit 0, versiya/imkoniyatlar/probe hisoboti to'g'ri.
//   3. `rev` ustuni bo'lmagan `app_state` → xato emas (birinchi deploy qo'shadi).
//   4. Probe advisory lock bo'shatiladi (production polling kaliti ishlatilmaydi).
//
// MUHIM: production bazasiga ULANMAYDI. Faqat embedded PG.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { startPg } from "./support/pg-harness.mjs";

const PGPORT = 55864;
const PG_DIR = "data/pg-compat-data";
const SCRIPT = "scripts/pg-compat-check.mjs";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}
const run = (env) =>
  spawnSync(process.execPath, [SCRIPT, "--json"], {
    env: { ...process.env, ...env },
    encoding: "utf8"
  });

async function main() {
  /* 1. DATABASE_URL yo'q — rad etadi */
  const none = run({ DATABASE_URL: "" });
  check("URL yo'q: exit 2 (ulanmaydi)", none.status === 2, `status=${none.status} ${none.stderr}`);
  check("URL yo'q: xabar aniq", /DATABASE_URL berilmagan/.test(String(none.stderr || "")), none.stderr);

  const pgApi = await startPg({ dir: PG_DIR, port: PGPORT });
  try {
    /* 2. `app_state` YO'Q baza */
    const empty = run({ DATABASE_URL: pgApi.url });
    const e = JSON.parse(empty.stdout || "{}");
    check("Bo'sh baza: exit 0 (moslik buzilmagan)", empty.status === 0, `${empty.status} ${empty.stderr}`);
    check("Bo'sh baza: versiya aniqlanadi", Number(e.version.num) >= 110000, JSON.stringify(e.version));
    check("Bo'sh baza: app_state yo'q deb xabar beradi", e.appState.exists === false, JSON.stringify(e.appState));
    check("Bo'sh baza: hashtextextended deterministik", e.checks.some((c) => /hashtextextended deterministik/.test(c.name) && c.ok));
    check("Bo'sh baza: probe advisory lock bo'shatildi", e.probe.released === true, JSON.stringify(e.probe));

    /* 3. `app_state` rev BILAN (production holati) */
    await pgApi.query("CREATE TABLE app_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), rev bigint NOT NULL DEFAULT 0)");
    await pgApi.query(
      "INSERT INTO app_state (id, data, rev) VALUES (1, $1::jsonb, 7)",
      [JSON.stringify({ seq: 12, users: { 1: { id: "u-1" } }, transactions: [{ id: "t1" }, { id: "t2" }] })]
    );
    const full = run({ DATABASE_URL: pgApi.url });
    const f = JSON.parse(full.stdout || "{}");
    check("To'liq baza: exit 0", full.status === 0, `${full.status} ${full.stderr}`);
    check("To'liq baza: rev ustuni topildi", f.appState.hasRev === true && f.appState.columns.includes("rev"), JSON.stringify(f.appState.columns));
    check("To'liq baza: qator o'qildi (rev=7)", f.appState.row.rev === 7, JSON.stringify(f.appState.row));
    check("To'liq baza: hajm hisoblanadi", Number(f.appState.row.bytes) > 0, String(f.appState.row.bytes));
    check("To'liq baza: tranzaksiyalar sanaldi (2)", f.appState.row.transactions === 2, String(f.appState.row.transactions));

    /* 4. `rev` ustuni yo'q (deploy oldidan) — xato emas */
    await pgApi.query("ALTER TABLE app_state DROP COLUMN rev");
    const noRev = run({ DATABASE_URL: pgApi.url });
    const n = JSON.parse(noRev.stdout || "{}");
    check("rev yo'q: exit 0 (birinchi deploy qo'shadi)", noRev.status === 0, `${noRev.status} ${noRev.stderr}`);
    check("rev yo'q: ogohlantirish matni", n.checks.some((c) => /rev ustuni/.test(c.name) && /birinchi deploy/.test(c.detail)),
      JSON.stringify(n.checks.filter((c) => /rev/.test(c.name))));
    const back = await pgApi.query("ALTER TABLE app_state ADD COLUMN rev bigint NOT NULL DEFAULT 0");
    check("rev qayta qo'shildi (test muhiti)", !!back);

    /* 5. Probe hech narsa yozmagan: app_state o'zgarmagan */
    const before = await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1");
    const again = run({ DATABASE_URL: pgApi.url });
    const after = await pgApi.query("SELECT data, rev FROM app_state WHERE id = 1");
    check("Probe: exit 0", again.status === 0, again.stderr);
    check("Probe: app_state O'ZGARMADI (data + rev)", JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]),
      JSON.stringify([before.rows[0].rev, after.rows[0].rev]));
    const locks = await pgApi.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted");
    check("Probe: ortda qolgan advisory lock yo'q", locks.rows[0].n === 0, String(locks.rows[0].n));
    const tables = await pgApi.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    check("Probe: qo'shimcha jadval yaratilmagan (faqat app_state)", tables.rows[0].n === 1, String(tables.rows[0].n));
  } finally {
    await pgApi.stop();
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("Test halokati:", e);
  process.exit(1);
});
