// Production/test izolyatsiyasi (spec D):
//  1. `APP_ENV=test` — haqiqiy Telegram yoki haqiqiy token bilan ishga
//     tushmaydi (jarayon exit 1).
//  2. Lokal rejimda news jadvali production kanaliga post qilmaydi
//     (RENDER / ALWAYSDATA_ENTRY / ALLOW_NEWS_SCHEDULER=1 bo'lmasa).
//  3. `APP_ENV` ko'rsatilmagan oddiy (production) rejim o'zgarmaydi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const src = fs.readFileSync("server.js", "utf8");
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== "" ? "  — " + extra : ""}`);
}

/* 1. Statik: guard joylari */
check("APP_ENV/IS_TEST_ENV aniqlanadi", /var IS_TEST_ENV = APP_ENV === "test";/.test(src));
check("assertEnvSafe main() da birinchi qadam", /async function main\(\) \{\n\s+assertEnvSafe\(\);/.test(src));
check("test rejimida loopback mock talab qilinadi", /TEST_EGRESS_BLOCKED: APP_ENV=test uchun TELEGRAM_API_BASE loopback/.test(src));
check("test rejimida haqiqiy token rad etiladi", /TEST_EGRESS_BLOCKED: test rejimida haqiqiy bot tokeni/.test(src));
check("news jadvali allowlist bilan himoyalangan",
  /if \(IS_TEST_ENV \|\| !\(process\.env\.RENDER \|\| process\.env\.ALWAYSDATA_ENTRY \|\| process\.env\.ALLOW_NEWS_SCHEDULER === "1"\)\)/.test(src));

/* 2. Haqiqiy jarayon: noto'g'ri test sozlamalari bilan ishga tushmaydi */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "egress-"));
function makeDb() {
  const f = path.join(tmp, `db-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ users: {}, settings: {} }));
  return f;
}
function runServer(extraEnv, waitForStart = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        PORT: String(4020 + Math.floor(Math.random() * 200)),
        ADMIN_PASSWORD: "testpass",
        KEEP_ALIVE: "0",
        DATA_FILE: makeDb(),
        ...extraEnv
      }
    });
    let out = "";
    let err = "";
    let settled = false;
    const done = (reason) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ out, err, reason, code: child.exitCode });
    };
    child.stdout.on("data", (d) => {
      out += d;
      if (waitForStart && /Veb server:/.test(out)) done("started");
    });
    child.stderr.on("data", (d) => { err += d; if (/TEST_EGRESS_BLOCKED/.test(err)) done("blocked"); });
    child.on("exit", (code) => { if (!settled) { settled = true; resolve({ out, err, reason: "exit", code }); } });
    setTimeout(() => done(waitForStart ? "timeout" : "timeout"), 20e3);
  });
}

{
  const r = await runServer({ APP_ENV: "test" });
  check("test + mock yo'q → jarayon to'xtaydi", r.reason === "blocked" && r.code !== 0, JSON.stringify({ reason: r.reason, code: r.code }));
  check("test + mock yo'q → aniq xabar", /TELEGRAM_API_BASE loopback mock/.test(r.err), r.err.slice(0, 200));
}
{
  const r = await runServer({ APP_ENV: "test", TELEGRAM_API_BASE: "https://api.telegram.org", TELEGRAM_BOT_TOKEN: "TESTTOKEN" });
  check("test + haqiqiy api host → to'xtaydi", r.reason === "blocked", JSON.stringify({ reason: r.reason }));
}
{
  const r = await runServer({ APP_ENV: "test", TELEGRAM_API_BASE: "http://127.0.0.1:3997", TELEGRAM_BOT_TOKEN: "123456789:AArEALtokenValue-xxxxxxxxxx" });
  check("test + haqiqiy token → to'xtaydi", r.reason === "blocked" && /haqiqiy bot tokeni/.test(r.err), r.err.slice(0, 200));
}
{
  // `NEWS_BOT_TOKEN=""` — loyihadagi `.env` dan haqiqiy token olinmasligi uchun
  // (dotenv faqat `undefined` bo'lganda to'ldiradi).
  const r = await runServer({ APP_ENV: "test", TELEGRAM_API_BASE: "http://127.0.0.1:3997", TELEGRAM_BOT_TOKEN: "TESTTOKEN", NEWS_BOT_TOKEN: "" }, true);
  check("test + mock + TESTTOKEN → ishga tushadi", r.reason === "started", JSON.stringify({ reason: r.reason }));
  check("test rejimida news jadvali o'chirilgan", /News bot jadvali o'chirilgan/.test(r.out), r.out.slice(-300));
}

/* 3. Lokal (APP_ENV yo'q) rejim: news jadvali production kanaliga chiqmaydi */
{
  const r = await runServer({ NEWS_BOT_TOKEN: "123456789:AArEALtokenValue-xxxxxxxxxx" }, true);
  check("lokal rejim ishga tushadi", r.reason === "started", JSON.stringify({ reason: r.reason }));
  check("lokal rejimda news jadvali o'chirilgan", /News bot jadvali o'chirilgan/.test(r.out), r.out.slice(-300));
  check("lokal rejimda real getMe chaqirilmaydi", !/News bot @/.test(r.out), r.out.slice(-300));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log("FAILED:\n" + failed.map((f) => " - " + f.name).join("\n"));
  process.exit(1);
}
