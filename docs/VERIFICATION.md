# A'zolik tekshiruvi tizimi (DB, verification, 24h scheduler)

Bu hujjat `server.js` dagi a'zolik (membership) registri, tekshiruv navbati va
soatlik xabarnoma mexanizmini tavsiflaydi. Spetsifikatsiya talab qilgan
"doimiy skanerlash emas, rejalashtirilgan tekshiruv" modeli shu yerda.

## 1. Ma'lumotlar modeli

Baza — yagona JSON hujjat (`db`), Postgres'da `state` ustunida saqlanadi
(`DATABASE_URL` bo'lsa). Quyidagi kolleksiyalar qo'shildi:

| Kolleksiya | Vazifasi | Muhim maydonlar |
|---|---|---|
| `memberships` | Har bir ma'lum (foydalanuvchi, kanal) juftligi uchun BITTA joriy yozuv | `id, userId, channelId, status, firstSeenAt, firstVerifiedAt, lastCheckedAt, nextCheckAt, lastMembershipChangeAt, lastCheckResult, consecutiveCheckErrors` |
| `membershipEvents` | Faqat qo'shiladigan tarix | `id, userId, channelId, eventType, oldStatus, newStatus, source, eventTime, apiResult, relatedTaskId` |
| `verificationJobs` | Doimiy (persistent) tekshiruv navbati | `id, membershipId, userId, channelId, jobType, scheduledAt, status, attemptCount, lastError, lockedAt, completedAt, idempotencyKey` |
| `sponsorMemberships` | Homiy kanallar a'zoligi — oddiy vazifalardan ALOHIDA | `id, userId, sponsorId, membershipStatus, lastCheckedAt, lastCheckResult` |
| `notifPeriods` | Soatlik xabarnoma davrlari (takror yuborishni to'sadi) | `id, key, userId, periodStart, periodEnd, notificationType, sentAt, status` |
| `transactions` | Kredit jurnali | `... , idempotencyKey, relatedTaskId` |

`memberships` uchun mantiqiy yagonalik: `(userId, channelId)` — `ensureMembership`.
`verificationJobs` uchun: `idempotencyKey = jobType:userId:channelId:soat`.

Eski (deploygacha tasdiqlangan) obunalar `migrateMemberships()` bilan registrga
ko'chiriladi: hech qanday foydalanuvchi, buyurtma yoki tarix o'chirilmaydi.

## 2. A'zolik holatlari va o'tishlar

```
            ┌──────────┐  obuna tasdiqlandi (task_verify)
            │ PENDING  │──────────────────────────────┐
            └──────────┘                              ▼
                                                 ┌────────┐
        ┌────────────────────────────────────────│ ACTIVE │
        │  recheck: not_member                   └────────┘
        ▼                                            ▲   │
  ┌───────────┐   recheck: member (REJOINED)         │   │ recheck: API xatosi
  │ CANCELLED │──────────────────────────────────────┘   ▼
  └───────────┘                                     ┌─────────────┐
                                                    │ CHECK_ERROR │
                                                    └─────────────┘
```

- `CHECK_ERROR` — vaqtinchalik API xatosi. **Obunadan chiqish deb hisoblanmaydi.**
  Job `5 daqiqa × 2^n` (maks. 6 soat) backoff bilan qayta navbatga qo'yiladi.
- `CANCELLED` — faqat API aniq `left`/`kicked` qaytarganda.
- `REJOINED` — qayta obuna: voqea yoziladi, statistika tiklanadi, **yangi kredit
  berilmaydi** (spec §3-B).

Voqea turlari: `FIRST_VERIFIED`, `RECHECK_ACTIVE`, `UNSUBSCRIBED`, `REJOINED`,
`CHECK_ERROR`.

**Jurnal hajmi siyosati:** holat o'zgarmagan muvaffaqiyatli 24 soatlik tekshiruv
`membershipEvents` ga yozilmaydi — faqat `lastCheckedAt`, `lastHealthyCheckAt`,
`healthyCheckCount` va `nextCheckAt` yangilanadi. `RECHECK_ACTIVE` faqat
`CHECK_ERROR` dan keyin tiklanishda yoziladi. Shu tufayli 1000 foydalanuvchida
ham jurnal yiliga yuz minglab yozuv bilan shishmaydi. Instagram uchun `SELF_CONFIRMED` alohida saqlanadi va kredit
bermaydi (`creditRewardInstagramSelfConfirmed` standart 0).

## 3. Uch tekshiruv nuqtasi

**A. Vazifa tasdiqlanganda (darhol).** `verifyBatch()` biriktirilgan 10 ta
vazifani alohida-alohida `getChatMember` bilan tekshiradi, har birining natijasini
(`lastCheckResult`, `checkedAt`, `consecutiveCheckErrors`) yozadi. Faqat
`member` bo'lganlariga `reward_task` tranzaksiyasi (`idempotencyKey: reward:<taskId>`)
beriladi. Bajarilmaganlar `PENDING` holida navbatga qaytadi, xatolar `RECHECK`
bo'lib qoladi.

**B. 24 soatlik qayta tekshiruv.** `applyVerified()` a'zolik yozuvini yaratadi va
`nextCheckAt = now + 24 soat + 0..3 soat jitter` bilan job qo'yadi. `maintenance()`
har 2 daqiqada `processVerificationJobs()` ni chaqiradi va bir tikda ko'pi bilan
`VERIFY_BATCH` (standart 25) jobni oladi — `scheduledAt` bo'yicha saralab.
Har bir job: tekshir → holatni yoz → keyingi 24 soatlik jobni rejalashtir → `DONE`.
Jarayon qulasa, `RUNNING` job 10 daqiqadan keyin `PENDING` ga qaytadi va navbat
bazada qoladi (restart-safe).

**Kanal uzilganda.** `chdely` kanal yozuvini o'chirmaydi: `status="disconnected"`,
`disconnectedAt` va `lastConfirmedActiveSubscribers` snapshot yoziladi, faol
buyurtmalar bekor qilinib kredit qaytariladi, ochiq vazifalar `CANCELLED` bo'ladi,
shu kanalning `PENDING` monitoring joblari `DONE` ("kanal uzilgan") qilinadi va
a'zolik yozuvlari saqlanadi. Qayta ulanganda o'sha yozuv tiklanadi — tarix
yo'qolmaydi va yangi kanal ulash bonusi takror berilmaydi.

**C. Homiy kanallar.** `sponsorGate()` har chaqiriqda `sponsorMemberships` ga
`MEMBER / NOT_MEMBER / CHECK_ERROR` yozadi. Bu yozuvlar `memberships` bilan
aralashtirilmaydi va 24 soatlik navbatga tushmaydi.

## 4. Scheduler oqimi

```
maintenance()  (har 2 daqiqa)
  ├─ 48 soatdan eski OPEN vazifalarni yopish (eskirgan navbat)
  ├─ recoverStaleJobs(): RUNNING > 10 daqiqa → PENDING
  └─ processVerificationJobs(limit=25)
        ├─ due = PENDING && scheduledAt <= now, saralangan
        ├─ har bir job: RUNNING + lockedAt
        ├─ checkMember(channelId, telegramId)
        │    ├─ member      → ACTIVE, REJOINED/RECHECK_ACTIVE voqeasi
        │    ├─ not_member  → CANCELLED, UNSUBSCRIBED, statistika yangilanadi
        │    └─ error       → holat saqlanadi, backoff bilan qayta navbat
        └─ keyingi 24 soatlik job (idempotencyKey bilan)
```

Cheklovlar va API imkoniyatlari:
- Bot faqat **ma'lum juftlikni** tekshira oladi (`getChatMember`); kanalning
  to'liq obunachilar ro'yxatini Telegram Bot API bermaydi.
- Bot kanalda administrator bo'lishi shart, aks holda natija `error` bo'ladi.
- Instagram uchun rasmiy "kim kimga follow qildi" API yo'q — holat
  `SELF_CONFIRMED` bo'lib qoladi va kredit bermaydi.

## 5. Soatlik xabarnoma

`hourlyReport()` har daqiqada tekshiradi: tugagan soat oralig'idagi
`verifyLog` yozuvlarini egasi bo'yicha guruhlaydi va **bitta** xabar yuboradi.
Idempotentlik `notifPeriods` dagi `userId:periodStart:subscribers` kaliti bilan
ta'minlanadi (xabar yuborilmasa `skipped` deb yoziladi). Bu jarayon hech qanday
a'zolik tekshiruvini ishga tushirmaydi.

## 6. Namuna yozuvlar

```json
// memberships
{ "id": "mem-1a2b", "userId": "u-1111", "channelId": "ch-1", "status": "ACTIVE",
  "firstVerifiedAt": "2026-11-14T04:40:00.000Z", "lastCheckedAt": "2026-11-14T04:40:00.000Z",
  "nextCheckAt": "2026-11-15T05:10:00.000Z", "lastCheckResult": "member",
  "consecutiveCheckErrors": 0 }

// verificationJobs
{ "id": "job-77", "membershipId": "mem-1a2b", "userId": "u-1111", "channelId": "ch-1",
  "jobType": "RECHECK", "scheduledAt": "2026-11-15T05:10:00.000Z", "status": "PENDING",
  "attemptCount": 0, "idempotencyKey": "RECHECK:u-1111:ch-1:489000" }

// membershipEvents
{ "eventType": "UNSUBSCRIBED", "oldStatus": "ACTIVE", "newStatus": "CANCELLED",
  "source": "recheck", "apiResult": "not_member" }
```

## 7. Test natijalari

`node data/membership-test.mjs` — mahalliy mock Telegram (`data/mock-tg2.mjs`)
bilan, 26/26 PASS:

| # | Tekshiruv | Natija |
|---|---|---|
| 1 | Vazifalar biriktiriladi | PASS |
| 2 | Obuna bo'lgan vazifa VERIFIED | PASS |
| 3 | Faqat tasdiqlangan vazifaga kredit | PASS |
| 4 | Bajarilmagan vazifa FIFO navbatda qoladi | PASS |
| 5 | Har bir tekshiruv natijasi alohida saqlanadi | PASS |
| 6 | A'zolik yozuvi yaratiladi (ACTIVE) | PASS |
| 7 | 24 soatlik qayta tekshiruv rejalashtiriladi (+24.6 soat) | PASS |
| 8 | FIRST_VERIFIED voqeasi yoziladi | PASS |
| 9 | Takroriy bosishda kredit takrorlanmaydi | PASS |
| 10 | API xatosi CHECK_ERROR, CANCELLED emas | PASS |
| 11 | Xatodan keyin backoff bilan qayta rejalashtiriladi | PASS |
| 12 | Xato obunachilar sonini kamaytirmaydi | PASS |
| 13 | Obunadan chiqish CANCELLED + UNSUBSCRIBED | PASS |
| 14 | Faqat shu kanal statistikasi o'zgaradi | PASS |
| 15 | Kredit qaytarilmaydi (tarix bukilmaydi) | PASS |
| 16 | Qayta obuna REJOINED voqeasi | PASS |
| 17 | Qayta obuna yangi kredit bermaydi | PASS |
| 18 | Instagram SELF_CONFIRMED kredit bermaydi | PASS |
| 19 | 30 ta due job 5 talik partiya bilan ishlanadi | PASS |
| 20 | Restartdan keyin navbat saqlanadi | PASS |
| 21 | Soatlik hisobot davri yoziladi, takrorlanmaydi | PASS |
| 22 | Sponsor a'zoligi alohida jadvalda | PASS |
| 23 | Sponsor yozuvi oddiy a'zolik bilan aralashmaydi | PASS |
| 24 | Kanal uzildi — yozuv va snapshot tarix uchun saqlanadi | PASS |
| 25 | Uzilgandan keyin monitoring to'xtaydi, a'zolik tarixi qoladi | PASS |
| 26 | Holat o'zgarmasa voqea yozilmaydi (jurnal shishmaydi) | PASS |

Qo'shimcha: `node data/recon.mjs` productionda `Σ tranzaksiya = available`
mosligini tekshiradi.

## 8. Operatsion buyruqlar

- `GET  /api/admin/health` — memberships/queue statistikasi
- `POST /api/admin/jobs {"action":"verify","limit":25}` — navbatni qo'lda ishlatish
- `POST /api/admin/jobs {"action":"hourly"}` — soatlik hisobotni qo'lda ishga tushirish
