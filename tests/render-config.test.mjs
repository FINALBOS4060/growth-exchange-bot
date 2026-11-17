// RENDER KONFIGURATSIYASI tekshiruvi (`render.yaml` ↔ `server.js` talablari).
//
// Deployoldi audit: instans soni, health check, muhit o'zgaruvchilari,
// doimiy baza, polling/scheduler qulflari uchun shartlar.
//
// Bu test Render'ga ULANMAYDI — faqat fayllarni statik tekshiradi.
import fs from "node:fs";

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? "  — " + extra : ""}`);
}

const yaml = fs.readFileSync("render.yaml", "utf8");
const src = fs.readFileSync("server.js", "utf8");
const has = (re) => re.test(yaml);

/* 1. Servis turi va buyruqlar */
check("servis: web + node", has(/type:\s*web/) && has(/runtime:\s*node/));
check("start buyrug'i: node server.js", has(/startCommand:\s*node server\.js/));
check("build: npm ci --omit=dev", has(/buildCommand:\s*npm ci --omit=dev/));

/* 2. Health check */
check("healthCheckPath: /healthz", has(/healthCheckPath:\s*\/healthz/));
const healthAt = src.indexOf('url.pathname === "/healthz"');
const authAt = src.indexOf('url.pathname.startsWith("/api/")');
check("/healthz autentifikatsiyasiz (auth darvozasidan oldin)", healthAt > 0 && authAt > 0 && healthAt < authAt,
  `healthz=${healthAt}, auth=${authAt}`);
check("/healthz matn rejimida javob beradi (Render probe)", /res\.end\("ok " \+ STORAGE\)/.test(src));
check("admin health botlar holatini beradi (checker shundan o'qiydi)",
  /bots:\s*botsList\(\)\.map/.test(src) && /adminHealth\(base\)/.test(fs.readFileSync("scripts/post-deploy-check.mjs", "utf8")));

/* 2b. Conflict tekshiruvi Render'ning AMALDAGI loglar endpoint'ini ishlatadi */
const checker = fs.readFileSync("scripts/post-deploy-check.mjs", "utf8");
check("conflict: /v1/logs?resource=<serviceId> ishlatiladi", /api\.render\.com\/v1\/logs\?resource=\$\{serviceId\}/.test(checker));
check("conflict: 404 beradigan eski endpoint ishlatilmaydi", !/v1\/services\/\$\{serviceId\}\/logs/.test(checker));
check("conflict: SIGTERM dan keyingi conflictlar alohida sanaladi", /conflictsAfterShutdown/.test(checker));

/* 3. Instans soni va graceful shutdown */
check("numInstances aniq ko'rsatilgan (1)", has(/numInstances:\s*1/));
check("maxShutdownDelaySeconds (SIGTERM oynasi)", has(/maxShutdownDelaySeconds:\s*30/));

/* 4. Doimiy saqlash (Postgres) */
check("DATABASE_URL mavjud (sync: false — qiymat dashboard'da)", has(/- key:\s*DATABASE_URL\s*\n\s*sync:\s*false/));
check("kod DATABASE_URL bilan Postgres rejimini yoqadi", /var STORAGE = DATABASE_URL \? "postgres" : "file"/.test(src));
// Fayl rejimida ko'p instans xavfli — buni hujjatlashtiramiz.
check("yaml'da ko'p instans ogohlantirishi bor", /advisory lock/i.test(yaml) && /DATABASE_URL/.test(yaml));

/* 5. Polling / scheduler / holat qulflari PG advisory lock ishlatadi */
check("polling qulfi: pg_try_advisory_lock", /pg_try_advisory_lock\(hashtextextended\(\$1, 0\)\)/.test(src));
check("scheduler qulfi mavjud", /tryLock\("scheduler"\)/.test(src));
check("holat qulfi (`gxb:state`) mavjud", /var STATE_LOCK_KEY = "gxb:state"/.test(src));
check("qulflar bir xil bazaga tayanadi (DATABASE_URL)", /function lockViaPg\(\)/.test(src) && /STORAGE === "postgres"/.test(src));

/* 6. Kerakli muhit o'zgaruvchilari (kodda ishlatiladiganlar) */
const used = [...new Set([...src.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]))];
// Faqat test/ichki rejim uchun: productionda bo'sh bo'lishi normal.
const optional = new Set([
  "PORT", "IP", "DATA_FILE", "TELEGRAM_API_BASE", "SHUTDOWN_ON_STDIN",
  "MAINTENANCE_SEC", "VERIFY_BATCH", "VERIFY_CONCURRENCY", "TG_CHECK_TIMEOUT_MS",
  "BOT_START_RETRY_SEC", "NEWS_RSS_QUERY", "ADMIN_EMAIL", "APP_URL", "RENDER_EXTERNAL_URL",
  "KEEP_ALIVE_SEC"
]);
const declared = [...yaml.matchAll(/- key:\s*([A-Z_0-9]+)/g)].map((m) => m[1]);
const missing = used.filter((k) => !optional.has(k) && !declared.includes(k));
check("kod ishlatadigan majburiy env'lar yaml'da", missing.length === 0, missing.join(", "));
for (const k of ["TELEGRAM_BOT_TOKEN", "ADMIN_IDS", "NEWS_BOT_TOKEN", "GEMINI_API_KEY", "ADMIN_PASSWORD", "DATABASE_URL"]) {
  check(`env: ${k} e'lon qilingan`, declared.includes(k));
}
check("sirlar `sync: false` (qiymat repoda emas)", (yaml.match(/sync:\s*false/g) || []).length >= 5);
check("ADMIN_PASSWORD generatsiya qilinadi", /- key:\s*ADMIN_PASSWORD\s*\n\s*generateValue:\s*true/.test(yaml));
check("yaml'da haqiqiy token qiymati yo'q", !/\d{6,}:[A-Za-z0-9_-]{30,}/.test(yaml));

/* 7. Free tier uchun keep-alive */
check("KEEP_ALIVE=1 (free tier uxlab qolmasin)", /- key:\s*KEEP_ALIVE\s*\n\s*value:\s*"1"/.test(yaml));

const failed = results.filter((x) => !x.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} PASS ===`);
process.exit(failed ? 1 : 0);
