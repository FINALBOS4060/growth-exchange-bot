// Vaqtinchalik (test ichida) PostgreSQL 18 serverni ko'tarish uchun yordamchi.
// Har test fayli o'z bazasini oladi — production bazaga hech qachon ulanmaydi.
import EmbeddedPostgres from "embedded-postgres";
import pgMod from "pg";
import fs from "node:fs";
import { execSync } from "node:child_process";

// Oldingi to'xtatilgan testdan qolgan (faqat shu loyihaning node_modules ichidagi)
// postgres jarayonlarini tozalaymiz — aks holda Windows'da "pre-existing shared
// memory block is still in use" xatosi chiqadi. Tizim PostgreSQL'iga tegilmaydi.
function killStalePostgres() {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'postgres.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"',
      { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (!out) return;
    const rows = [].concat(JSON.parse(out));
    for (const r of rows) {
      if (!r || !r.CommandLine) continue;
      if (!/embedded-postgres/i.test(r.CommandLine)) continue;
      try {
        process.kill(Number(r.ProcessId), "SIGKILL");
      } catch {}
    }
  } catch {}
}

export async function startPg({ dir, port, database = "gxb" }) {
  killStalePostgres();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;
  const api = {
    url,
    port,
    pg,
    async client() {
      const c = new pgMod.Client({ connectionString: url });
      // Test jarayoni PG to'xtaganda ulanish uzilishi mumkin — kutilmagan
      // `error` hodisasi testni yiqitmasligi kerak.
      c.on("error", () => {});
      await c.connect();
      return c;
    },
    async query(sql, params) {
      const c = await api.client();
      try {
        return await c.query(sql, params);
      } finally {
        try {
          await c.end();
        } catch {}
      }
    },
    // `app_state` — yagona JSONB qator; testlar HAQIQIY yozilgan holatni shundan o'qiydi.
    async readState() {
      const r = await api.query("SELECT data FROM app_state WHERE id = 1");
      return r.rows[0] ? r.rows[0].data : null;
    },
    async stop() {
      try {
        await pg.stop();
      } catch {}
    }
  };
  return api;
}
