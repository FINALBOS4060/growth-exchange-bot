// Smoke test: servis tirikligi, login sahifasi, admin API himoyasi.
// Ishlatish:
//   BASE=https://growth-exchange-bot.onrender.com ADMIN_PASSWORD=... node scripts/smoke.mjs
const BASE = (process.env.BASE || "http://localhost:8080").replace(/\/$/, "");
const PW = process.env.ADMIN_PASSWORD || "";
const auth = PW ? "Basic " + Buffer.from("admin:" + PW).toString("base64") : "";
let failed = 0;

async function check(name, fn) {
  try {
    const r = await fn();
    console.log("✅ " + name + " — " + r);
  } catch (e) {
    failed++;
    console.log("❌ " + name + " — " + e.message);
  }
}

await check("healthz", async () => {
  const r = await fetch(BASE + "/healthz", { signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  if (r.status !== 200 || !t.startsWith("ok")) throw new Error("status " + r.status + " " + t);
  return t.trim();
});

await check("login sahifasi", async () => {
  const r = await fetch(BASE + "/login");
  const t = await r.text();
  if (r.status !== 200 || !t.includes("admin panel")) throw new Error("status " + r.status);
  return "200";
});

await check("himoyalangan API (anonim)", async () => {
  const r = await fetch(BASE + "/api/admin/me");
  if (r.status !== 401) throw new Error("401 kutilgan, keldi " + r.status);
  return "401";
});

if (auth) {
  await check("stats (admin)", async () => {
    const r = await fetch(BASE + "/api/stats", { headers: { authorization: auth } });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return "users=" + d.users + " channels=" + d.channels;
  });
  await check("health (admin)", async () => {
    const r = await fetch(BASE + "/api/admin/health", { headers: { authorization: auth } });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return "bots=" + d.bots.length + " tasksOpen=" + d.queue.tasksOpen;
  });
  await check("news holati", async () => {
    const r = await fetch(BASE + "/api/news", { headers: { authorization: auth } });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return "enabled=" + d.enabled + " last=" + (d.lastStatus || "—");
  });
} else {
  console.log("ℹ️  ADMIN_PASSWORD berilmadi — faqat ommaviy tekshiruvlar bajarildi.");
}

console.log(failed ? "\n" + failed + " ta tekshiruv yiqildi" : "\nHammasi joyida");
process.exit(failed ? 1 : 0);
