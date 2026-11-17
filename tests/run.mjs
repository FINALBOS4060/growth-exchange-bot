// Test runner: tests/*.test.mjs fayllarini ketma-ket ishga tushiradi.
// Har test alohida jarayonda — biri yiqilsa qolganlari davom etadi.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();

if (!files.length) {
  console.error("tests/ ichida *.test.mjs topilmadi");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log(`\n──── ${f} ────`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test fayli o'tdi`);
process.exit(failed ? 1 : 0);
