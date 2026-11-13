#!/usr/bin/env node
// Render'ga to'liq avtomatik joylash (brauzersiz).
//
// Ishlatish:
//   RENDER_API_KEY=rnd_... node scripts/render-deploy.mjs
// yoki kalitni `.render-key` fayliga yozib qo'ying (git'ga kirmaydi).
//
// Skript: servisni yaratadi (yoki mavjudini topadi), env o'zgaruvchilarni
// qo'yadi, deployni boshlaydi, holatini kuzatadi va natijani chop etadi.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.render.com/v1";
const SERVICE_NAME = process.env.SERVICE_NAME || "growth-exchange-bot";
const REPO = "https://github.com/FINALBOS4060/growth-exchange-bot";
const STATE_FILE = path.join(ROOT, ".render-state.json");

function readEnvFile() {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function apiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY.trim();
  const file = path.join(ROOT, ".render-key");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  console.error("RENDER_API_KEY topilmadi (.render-key fayli ham yo'q).");
  process.exit(1);
}

const KEY = apiKey();

async function call(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function log(msg) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

async function waitFor(check, { timeoutMs = 15 * 60e3, everyMs = 8e3, label }) {
  const started = Date.now();
  for (;;) {
    const res = await check();
    if (res) return res;
    if (Date.now() - started > timeoutMs) throw new Error(`${label}: vaqt tugadi`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function makeServiceBody(ownerId, envVars, variant) {
  const details = {
    plan: "free",
    region: "frankfurt",
    healthCheckPath: "/healthz",
    envSpecificDetails: {
      buildCommand: "npm ci --omit=dev",
      startCommand: "node server.js"
    },
    envVars
  };
  if (variant === "env") details.env = "node";
  else if (variant === "runtime") details.runtime = "node";
  return {
    type: "web_service",
    name: SERVICE_NAME,
    ownerId,
    repo: REPO,
    branch: "main",
    autoDeploy: "yes",
    serviceDetails: details
  };
}

async function main() {
  const env = readEnvFile();
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN .env da topilmadi");
  const adminIds = env.ADMIN_IDS || process.env.ADMIN_IDS || "8780300373";
  let adminPassword = env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword === "murakkab-parol-yozing") {
    adminPassword = crypto.randomBytes(9).toString("base64url");
    fs.appendFileSync(path.join(ROOT, ".env"), `\nADMIN_PASSWORD=${adminPassword}\n`);
    log("ADMIN_PASSWORD generatsiya qilindi va .env ga yozildi");
  }

  const owners = await call("GET", "/owners?limit=20");
  if (!Array.isArray(owners) || !owners.length) throw new Error("Render akkauntda workspace topilmadi");
  const owner = owners.find((o) => (o.owner?.type || o.type) !== "team")?.owner || owners[0].owner || owners[0];
  const ownerId = owner.id;
  log(`Workspace: ${owner.name || owner.email || ownerId} (${ownerId})`);

  const envVars = [
    { key: "NODE_VERSION", value: "22" },
    { key: "TELEGRAM_BOT_TOKEN", value: token },
    { key: "ADMIN_IDS", value: adminIds },
    { key: "ADMIN_PASSWORD", value: adminPassword },
    { key: "KEEP_ALIVE", value: "1" },
    { key: "KEEP_ALIVE_SEC", value: "600" }
  ];

  let service = null;
  const existing = await call("GET", `/services?name=${encodeURIComponent(SERVICE_NAME)}&limit=20`);
  const found = (Array.isArray(existing) ? existing : []).map((x) => x.service || x).find((s) => s.name === SERVICE_NAME);
  if (found) {
    service = found;
    log(`Mavjud servis topildi: ${service.id} (${service.serviceDetails?.url || service.dashboardUrl || ""})`);
    await call("PUT", `/services/${service.id}/env-vars`, envVars.map((v) => ({ key: v.key, value: v.value })));
    log("Env o'zgaruvchilar yangilandi");
  } else {
    let lastErr;
    for (const variant of ["env", "runtime"]) {
      try {
        const created = await call("POST", "/services", makeServiceBody(ownerId, envVars, variant));
        service = created.service || created;
        log(`Servis yaratildi (${variant}): ${service.id}`);
        break;
      } catch (e) {
        lastErr = e;
        log(`Urinish "${variant}" muvaffaqiyatsiz: ${e.message}`);
      }
    }
    if (!service) throw lastErr;
  }

  if (!service || !service.id) throw new Error("Servis ID olinmadi");

  // Deploy boshlash (servis yaratilganda avtomatik boshlanadi, lekin kafolat uchun)
  try {
    await call("POST", `/services/${service.id}/deploys`, { clearCache: "do_not_clear" });
    log("Deploy boshlandi");
  } catch (e) {
    log(`Deploy qo'lda boshlanmadi (avtomatik ketayotgan bo'lishi mumkin): ${e.message.slice(0, 200)}`);
  }

  const deploy = await waitFor(
    async () => {
      const list = await call("GET", `/services/${service.id}/deploys?limit=1`);
      const d = (Array.isArray(list) ? list : []).map((x) => x.deploy || x)[0];
      if (!d) return null;
      if (["created", "build_in_progress", "update_in_progress", "pre_deploy_in_progress", "pending"].includes(d.status)) {
        log(`deploy holati: ${d.status}`);
        return null;
      }
      return d;
    },
    { label: "deploy" }
  );

  log(`Deploy yakunlandi: ${deploy.status}`);
  if (deploy.status !== "live") {
    console.error("Deploy muvaffaqiyatsiz. Loglar:");
    try {
      const logs = await call("GET", `/services/${service.id}/logs?limit=200&ownerId=${ownerId}`);
      const text = (logs.logs || logs).map?.((l) => `${l.timestamp} ${l.message}`).join("\n") ?? JSON.stringify(logs);
      console.error(text.slice(-4000));
    } catch (e) {
      console.error(`Loglarni olib bo'lmadi: ${e.message}`);
    }
  }

  const url = service.serviceDetails?.url || `https://${service.slug || SERVICE_NAME}.onrender.com`;
  const state = { serviceId: service.id, url, ownerId, adminPassword, deployedAt: new Date().toISOString(), status: deploy.status };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`URL: ${url}`);
  log(`Panel paroli: ${adminPassword}`);
  log(`Holat fayli: ${STATE_FILE}`);
}

main().catch((e) => {
  console.error("XATO:", e.message);
  process.exit(1);
});
