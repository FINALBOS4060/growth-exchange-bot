# tests/

Versiyalanadigan testlar. `data/` (gitignored) dan farqli, bu katalog
repository'ga kiradi.

## Ishga tushirish

```bash
npm test               # barcha tests/*.test.mjs (PG testlari ham kiradi)
```

`pg-*.test.mjs` tashqi bazani talab qilmaydi: ular `embedded-postgres`
(devDependency) bilan vaqtinchalik PostgreSQL 18 serverni `data/pg-*`
ichida ko'taradi va oxirida to'xtatadi.

## Izolyatsiya qoidalari (majburiy)

1. **Haqiqiy Telegram API'ga so'rov yo'q.** Test `APP_ENV=test` bilan
   ishga tushadi; `TELEGRAM_API_BASE` faqat loopback mock'ga ishora qiladi.
2. **Haqiqiy token yo'q.** Faqat `TESTTOKEN`. `data/db.json` yoki boshqa
   fixture'dan token o'qilmaydi.
3. **Production bazasiga ulanish yo'q.** `DATABASE_URL` yo'q yoki lokal
   `postgres://…@127.0.0.1/test`.
4. **Egress guard** (`lib/tg-transport.js`) test rejimida `api.telegram.org`
   ga har qanday so'rovni `ERR_TG_TEST_EGRESS` bilan to'xtatadi va
   `tests/artifacts/blocked-egress.jsonl` ga yozadi. Barcha o'tgan so'rovlar
   `tests/artifacts/tg-calls.jsonl` ga yoziladi.
5. Artefaktlar (`tests/artifacts/`) gitignored.

## Hozirgi holat

| Fayl | Mazmun | Holat |
|---|---|---|
| `ledger.test.mjs` | §2.5 ledger matematikasi: reservation → fulfill → reward → refund → reversal, rekonciliatsiya, idempotentlik qarori | 26/26 PASS |
| `pg-persist.test.mjs` | **haqiqiy PostgreSQL** (embedded PG 18): persist xatosi → rollback, advisory lock (ikki ulanish + ikki instans), SIGKILL crash-safety | 33/33 PASS |
| `pg-referral-e2e.test.mjs` | **haqiqiy PostgreSQL + server + mock Telegram**: referal job E2E (300 kredit), buyurtma idempotency, refund `reserved < refund` | 39/39 PASS |
| `pg-verify-rollback.test.mjs` | verifyBatch/signup persist xatosi → to'liq rollback, keyingi `save()` iflos yozmaydi | 27/27 PASS |
| `pg-concurrency-rollback.test.mjs` | concurrency: persist xatosi paytida boshqa handler yozuvlari saqlanib qoladi (A/B/C ssenariylari) | 33/33 PASS |
| `migrate-signup.test.mjs` | `migrateSettings()` signup qoidasi bir marta qo'llanadi, mavjud balans/jurnalga tegmaydi | 14/14 PASS |
| `save-audit.test.mjs` | statik audit: money funksiyalar async, `flushOrRollback`/`flushSaveAwaited` await bilan, `persist()` xatoni yutmaydi, `withStateTx`/CAS/merge qulflari | 86/86 PASS |
| `pg-multi-instance.test.mjs` | **KO'P INSTANS**: ikkita mustaqil `server.js` jarayoni (5631/5632) + bitta PG 18 — parallel balans, dublikat reward/refund, persist xatosi + ikkinchi instans yozuvi, uch tomonlama merge | 34/34 PASS |
| `pg-order-token-multi.test.mjs` | **E2E**: har instans o'z bot tokenini poll qiladi — bir xil `client_token` ikkala jarayonda → bitta buyurtma, bitta reservation, kechikkan replay ham dublikat yaratmaydi | 22/22 PASS |
| `pg-compat.test.mjs` | `scripts/pg-compat-check.mjs`: versiya/imkoniyatlar/probe, `rev` yo'qligi xato emas, probe hech narsa yozmaydi | 19/19 PASS |
| `backup-restore.test.mjs` | `app_backup` → `scripts/restore-backup.mjs` (`--list`, `--dry-run`, `--apply --confirm`), `pre-restore` xavfsizlik nusxasi, `rev` o'sishi, rad etish yo'llari | 28/28 PASS |
| `render-config.test.mjs` | `render.yaml` ↔ `server.js`: instans soni, health check, env'lar, doimiy baza, polling/scheduler/holat qulflari, repo'da sir yo'q | 26/26 PASS |
| `membership.test.mjs` | mavjud 32 ta a'zolik/verification testi (ko'chirilishi kerak) | `data/` da |
| qolgan T1–T22 | [docs/PRODUCTION_READINESS.md](../docs/PRODUCTION_READINESS.md) §10 | yozilishi kerak |

Testlar implementatsiyadan **oldin** yoziladi; hozir `ledger.test.mjs` faqat
hujjatdagi formulalarni qulflaydi, production kodini emas.
