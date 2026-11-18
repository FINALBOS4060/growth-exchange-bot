// Mock Telegram Bot API — a'zolik va administrator holatini fayl orqali boshqaradi.
// State: { members: { "<chat>|<user>": "<status>" }, chats: { "<username>": { id, title } } }
//
// Qo'llab-quvvatlanadigan statuslar:
//   member | not_member | left | administrator | creator | restricted
//   error            → 400 "internal server error" (doimiy bo'lmagan, noaniq)
//   timeout          → 500 (vaqtinchalik server xatosi)
//   no_rights        → 400 "not enough rights to get chat member"
//   not_found        → 400 "chat not found"
//   chat_admin_required → 403 "chat_admin_required"
//
// Tekshiruv xatolarini sinash uchun qo'shimcha rejimlar:
//   rate:<n>         → HTTP 429 + parameters.retry_after = n
//   forbidden        → 403 "bot was kicked from the channel"
//   badid            → 400 "chat_id is empty"
//   server           → HTTP 500 (Telegram server xatosi)
//   netfail          → ulanish uziladi (TypeError: fetch failed)
//   slow             → juda kech javob beradi (client timeout)
//   html502          → HTTP 502, HTML tana (proksi xatosi)
import http from "node:http";
import fs from "node:fs";

const STATE = process.env.MOCK_STATE || "data/mtg-state.json";
const INBOX = process.env.MOCK_INBOX || "data/mtg-inbox.json";
const CALLS = process.env.MOCK_CALLS || "data/mtg-calls.log";
const OUT = process.env.MOCK_OUT || "data/mtg-out.log";
const BOT_ID = Number(process.env.MOCK_BOT_ID || 777000);
// Har bir token uchun alohida bot id/username (ishchi botlarni sinash uchun).
// `MOCK_BOT_ID_MAP='{"WORKERTOKEN":{"id":777001,"username":"worker_bot"}}'`
const BOT_MAP = (() => {
  try {
    return JSON.parse(process.env.MOCK_BOT_ID_MAP || "{}") || {};
  } catch {
    return {};
  }
})();
let uid = 5000;
let activePolls = 0;

const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
const reply = (res, o) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(o));
};

// Status → getChatMember javobi. Bu yerda har bir holat ATAYIN alohida:
// ilova ularni bir-biridan farqlashi shart.
function memberResponse(v, p) {
  if (v === "unauthorized") return { ok: false, error_code: 401, description: "Unauthorized" };
  if (v === "rate" || String(v).startsWith("rate:")) {
    const after = Number(String(v).split(":")[1]) || 7;
    return { ok: false, error_code: 429, description: `Too Many Requests: retry after ${after}`, parameters: { retry_after: after } };
  }
  if (v === "forbidden") return { ok: false, error_code: 403, description: "Forbidden: bot was kicked from the channel" };
  if (v === "badid") return { ok: false, error_code: 400, description: "Bad Request: chat_id is empty" };
  if (v === "error") return { ok: false, error_code: 400, description: "Bad Request: internal server error" };
  if (v === "timeout" || v === "server") return { ok: false, error_code: 500, description: "Internal Server Error" };
  if (v === "no_rights") return { ok: false, error_code: 400, description: "Bad Request: not enough rights to get chat member" };
  if (v === "not_found") return { ok: false, error_code: 400, description: "Bad Request: chat not found" };
  if (v === "chat_admin_required") return { ok: false, error_code: 403, description: "Forbidden: bot must be an administrator in the chat" };
  if (v === "creator") return { ok: true, result: { status: "creator", user: { id: p.user_id } } };
  if (v === "administrator") {
    const limited = String(p.chat_id) === "-1088";
    return {
      ok: true,
      result: {
        status: "administrator",
        user: { id: p.user_id },
        can_be_edited: false,
        permissions: limited
          ? { can_invite_users: false, can_manage_chat: true, can_delete_messages: true }
          : { can_invite_users: true, can_manage_chat: true, can_delete_messages: true }
      }
    };
  }
  if (v === "restricted") return { ok: true, result: { status: "restricted", is_member: false, user: { id: p.user_id } } };
  if (v === "member") return { ok: true, result: { status: "member", user: { id: p.user_id } } };
  return { ok: true, result: { status: "left", user: { id: p.user_id } } };
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = String(req.url || "").split("/").pop();
      const token = (String(req.url || "").match(/^\/bot([^/]+)\//) || [])[1] || "";
      const botMeta = BOT_MAP[token] || {};
      let p = {};
      try {
        p = body ? JSON.parse(body) : {};
      } catch {}

      if (method === "getMe") {
        return reply(res, {
          ok: true,
          result: { id: botMeta.id || BOT_ID, is_bot: true, first_name: "Test", username: botMeta.username || "test_bot" }
        });
      }
      if (method === "getChat") {
        const uname = String(p.chat_id || "").replace(/^@/, "");
        const map = read(STATE, {}).chats || {};
        const info = map[uname];
        if (!info) return reply(res, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        if (info.type === "group" || info.type === "private") {
          return reply(res, { ok: true, result: { id: info.id, type: info.type, title: info.title, username: uname } });
        }
        return reply(res, { ok: true, result: { id: info.id, type: "channel", title: info.title, username: uname } });
      }
      if (method === "getChatMember") {
        const st = read(STATE, {});
        const key = String(p.chat_id) + "|" + String(p.user_id);
        const botKey = String(botMeta.id || BOT_ID);
        // `botMembers` — BOTGA XOS holat: `{"777000": {"-1005|9101": "left"}}`.
        // Bot kanalda admin emasligini (va boshqa bot admin ekanini) shu bilan
        // sinaymiz; umumiy `members` esa hamma botlar uchun amal qiladi.
        const perBot = (st.botMembers || {})[botKey] || {};
        fs.appendFileSync(CALLS, JSON.stringify({ at: Date.now(), key, bot: botKey }) + "\n");
        const v = perBot[key] !== void 0 ? perBot[key] : (st.members || {})[key] || "not_member";
        // Tarmoq sathidagi nosozliklar alohida simulyatsiya qilinadi.
        if (v === "netfail") return req.socket.destroy();
        if (v === "slow") return setTimeout(() => reply(res, { ok: false, error_code: 400, description: "Bad Request: late" }), 4e3);
        if (v === "html502") {
          res.writeHead(502, { "content-type": "text/html" });
          return res.end("<html><body>502 Bad Gateway</body></html>");
        }
        if (String(v).startsWith("rate:") || v === "rate") {
          res.writeHead(429, { "content-type": "application/json" });
          return res.end(JSON.stringify(memberResponse(v === "rate" ? "rate:7" : v, p)));
        }
        if (v === "server") {
          res.writeHead(500, { "content-type": "application/json" });
          return res.end(JSON.stringify(memberResponse(v, p)));
        }
        return reply(res, memberResponse(v, p));
      }
      if (method === "getUpdates") {
        // Bir token uchun bir vaqtda faqat BITTA long-poll bo'lishi kerak.
        // Har bir so'rov uchun poll-start / poll-end / poll-aborted yoziladi —
        // test shu bilan "eski so'rov uzildi, keyin yangisi boshlandi"
        // tartibini isbotlaydi.
        activePolls++;
        fs.appendFileSync(CALLS, JSON.stringify({ at: Date.now(), ev: "poll-start", n: activePolls }) + "\n");
        if (activePolls > 1) fs.appendFileSync(CALLS, JSON.stringify({ at: Date.now(), concurrent: activePolls }) + "\n");
        let done = false;
        const finish = (ev) => {
          if (done) return false;
          done = true;
          activePolls = Math.max(0, activePolls - 1);
          fs.appendFileSync(CALLS, JSON.stringify({ at: Date.now(), ev, n: activePolls }) + "\n");
          return true;
        };
        // Mijoz so'rovni tashlab ketgan bo'lsa (abort) — javob oqimining
        // "close" hodisasi orqali aniqlanadi (req 'close' tana o'qilishi
        // bilan ham chiqadi, shuning uchun res ishlatiladi).
        res.on("close", () => finish("poll-aborted"));
        const all = read(INBOX, []);
        // `_bot` — update FAQAT shu botga tegishli (token yoki username).
        // Ko'p instansli testlarda har instans o'z botini poll qiladi, shuning
        // uchun bir xil callback ikki jarayonga ham yetib borishi kerak.
        // `_bot` bo'lmasa — eski xattir-harakat: barcha pollerlarga beriladi.
        const mine = (u) => {
          if (!u || !u._bot) return true;
          const tag = String(u._bot);
          return tag === token || tag === botMeta.username || tag === String(botMeta.id || "");
        };
        const items = all.filter(mine);
        if (items.length) {
          if (!finish("poll-end")) return;
          // Faqat berilganlar navbatdan chiqadi; boshqalari qoladi.
          const rest = all.filter((u) => !mine(u));
          fs.writeFileSync(INBOX, JSON.stringify(rest));
          return reply(res, {
            ok: true,
            result: items.map((u) => {
              const { _bot, ...rest2 } = u;
              return { update_id: ++uid, ...rest2 };
            })
          });
        }
        const hold = Number(process.env.MOCK_POLL_DELAY_MS || 400);
        return setTimeout(() => {
          if (!finish("poll-end")) return;
          try {
            reply(res, { ok: true, result: [] });
          } catch {}
        }, hold);
      }
      if (method === "sendMessage" || method === "sendPhoto") {
        fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), method, chat: p.chat_id, text: p.text || p.caption || "", kb: p.reply_markup || null }) + "\n");
        return reply(res, { ok: true, result: { message_id: 1 } });
      }
      if (method === "answerCallbackQuery" || method === "deleteWebhook" || method === "setMyCommands") return reply(res, { ok: true, result: true });
      return reply(res, { ok: true, result: true });
    });
  })
  .listen(Number(process.env.MOCK_PORT || 3997), () => console.log("mock-tg2 ready"));
