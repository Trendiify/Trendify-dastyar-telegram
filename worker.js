/**
 * Trendify Group Manager Bot — v2.0
 * Cloudflare Worker + KV
 *
 * ── نصب سریع ─────────────────────────────────────────────
 * Secrets / Variables:
 *   BOT_TOKEN       (الزامی)  توکن ربات از BotFather
 *   WEBHOOK_SECRET  (پیشنهادی) یک رشته تصادفی؛ همان را در setWebhook به‌عنوان secret_token بدهید
 *   OWNER_ID        (اختیاری) آیدی عددی شما؛ گزارش خطاهای ربات به پیوی شما می‌آید
 * KV Binding:
 *   KV              (الزامی)  یک KV Namespace
 * Cron Trigger:
 *   هر ۵ دقیقه (برای تبلیغات خودکار و تایم‌اوت کپچا) — در README توضیح داده شده
 * ─────────────────────────────────────────────────────────
 */

// ================= ثابت‌ها =================

const FLOOD_WINDOW_MS = 6000;
const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;
const MEM_TTL_MS = 20 * 1000;
const ADMIN_TTL_MS = 60 * 1000;
const TELEGRAM_SERVICE_ID = 777000;
const MAX_WORDS = 500;

const DEFAULT_BADWORDS = ["کازینو", "بت", "شرطبندی", "صیغه"];
const DEFAULT_WELCOME = "👋 سلام {mention}، به گروه «{group}» خوش آمدی!\nلطفاً قوانین را رعایت کن.";

// تعریف قفل‌ها (کلید، عنوان فارسی)
const LOCKS = {
  media: [
    ["photo", "عکس"], ["video", "فیلم"], ["sticker", "استیکر"], ["gif", "گیف"],
    ["voice", "وویس/صدا"], ["document", "فایل"], ["contact", "مخاطب"],
    ["location", "موقعیت مکانی"], ["poll", "نظرسنجی"]
  ],
  text: [
    ["link", "لینک"], ["mention", "یوزرنیم @"], ["hashtag", "هشتگ #"],
    ["command", "دستورات /"], ["forward", "فوروارد"], ["edited", "ویرایش پیام"],
    ["badwords", "کلمات ممنوعه"]
  ],
  sec: [
    ["service", "حذف پیام ورود/خروج"], ["bots", "جلوگیری از ورود ربات"], ["flood", "ضد فلود"]
  ],
  welcome: [
    ["welcome", "پیام خوشامد"], ["captcha", "کپچا (تأیید ورود)"]
  ]
};

/** @type {Record<string, any>} */
const DEFAULT_SETTINGS = {
  photo: false, video: false, sticker: false, gif: false, voice: false,
  document: false, contact: false, location: false, poll: false,
  link: false, mention: false, hashtag: false, command: false,
  forward: false, edited: false, badwords: true,
  service: false, bots: false, flood: false,
  welcome: false, captcha: false,
  warn_limit: 3, warn_action: "mute", mute_hours: 24, flood_count: 5,
  welcome_text: DEFAULT_WELCOME, rules_text: ""
};

/** @type {Record<string, string>} */
const TOGGLE_MENU = {};
LOCKS.media.forEach(([k]) => (TOGGLE_MENU[k] = "media"));
LOCKS.text.forEach(([k]) => (TOGGLE_MENU[k] = "text"));
LOCKS.sec.forEach(([k]) => (TOGGLE_MENU[k] = "sec"));
LOCKS.welcome.forEach(([k]) => (TOGGLE_MENU[k] = "welcome"));

/** @type {Record<string, any[]>} */
const CYCLES = {
  warn_limit: [2, 3, 4, 5, 7, 10],
  warn_action: ["mute", "kick", "ban"],
  mute_hours: [1, 6, 12, 24, 72, 168],
  flood_count: [4, 5, 6, 8, 10]
};
/** @type {Record<string, string>} */
const CYCLE_MENU = { warn_limit: "warn", warn_action: "warn", mute_hours: "warn", flood_count: "sec" };
/** @type {Record<string, string>} */
const ACTION_LABEL = { mute: "سکوت", kick: "اخراج", ban: "بن دائم" };

const SERVICE_KEYS = [
  "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo",
  "delete_chat_photo", "group_chat_created", "supergroup_chat_created",
  "pinned_message", "video_chat_started", "video_chat_ended",
  "video_chat_scheduled", "video_chat_participants_invited", "message_auto_delete_timer_changed",
  "migrate_to_chat_id", "migrate_from_chat_id"
];

const FULL_PERMS = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true,
  can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_invite_users: true
};
const NO_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false
};

// ================= ابزارهای عمومی =================

const mem = new Map();
function memGet(key) {
  const h = mem.get(key);
  if (!h) return undefined;
  if (h.exp < Date.now()) { mem.delete(key); return undefined; }
  return h.v;
}
function memSet(key, v, ttl = MEM_TTL_MS) {
  if (mem.size > 3000) mem.clear();
  mem.set(key, { v, exp: Date.now() + ttl });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mention(id, name) {
  return `<a href="tg://user?id=${id}">${esc(name || "کاربر")}</a>`;
}
function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function toLatinDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}
function getBotId(env) {
  return parseInt(String(env.BOT_TOKEN || "").split(":")[0]) || 0;
}
function humanDuration(secs) {
  if (secs >= 86400) return `${Math.round(secs / 86400)} روز`;
  if (secs >= 3600) return `${Math.round(secs / 3600)} ساعت`;
  return `${Math.max(1, Math.round(secs / 60))} دقیقه`;
}
function hoursLabel(h) {
  return h >= 24 ? `${h / 24} روز` : `${h} ساعت`;
}

// نرمال‌سازی متن فارسی/عربی برای فیلتر کلمات
function normalizeText(t) {
  return toLatinDigits(String(t))
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u0622\u0623\u0625]/g, "\u0627")
    .replace(/[\u06C0\u0629]/g, "\u0647");
}

function findBadWord(text, words) {
  const norm = normalizeText(text);
  const tokens = norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const joined = " " + tokens.join(" ") + " ";
  for (const w of words) {
    const nw = normalizeText(w).trim();
    if (!nw) continue;
    if (/[^\p{L}\p{N}\s]/u.test(nw)) {
      if (norm.includes(nw)) return w;
      continue;
    }
    if (nw.includes(" ")) {
      if (joined.includes(" " + nw.split(/\s+/).join(" ") + " ")) return w;
    } else if (nw.length >= 4) {
      if (tokens.some((t) => t === nw || t.startsWith(nw))) return w;
    } else if (tokens.includes(nw)) {
      return w;
    }
  }
  return null;
}

// تشخیص دستور: اگر متن با یکی از نام‌ها شروع شود، بقیه متن را برمی‌گرداند، وگرنه null
function matchCmd(text, names) {
  for (const n of names) {
    if (text === n) return "";
    if (text.startsWith(n + " ") || text.startsWith(n + "\n")) return text.slice(n.length).trim();
  }
  return null;
}
function isExactCmd(text, names) {
  return matchCmd(text, names) === "";
}

// ================= KV =================

async function kvGet(env, key) {
  if (!env.KV) return null;
  try { return await env.KV.get(key); } catch (e) { console.error("KV get error:", key, e); return null; }
}
async function kvPut(env, key, value, opts) {
  if (!env.KV) return false;
  try { await env.KV.put(key, value, opts); return true; } catch (e) { console.error("KV put error:", key, e); return false; }
}
async function kvDelete(env, key) {
  if (!env.KV) return false;
  try { await env.KV.delete(key); return true; } catch (e) { console.error("KV delete error:", key, e); return false; }
}

// ================= ارتباط با API تلگرام =================

async function tg(env, method, payload, retry = true) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      if (data.error_code === 429 && retry) {
        const wait = Math.min((data.parameters && data.parameters.retry_after) || 1, 3);
        await sleep(wait * 1000);
        return tg(env, method, payload, false);
      }
      const d = String(data.description || "");
      if (!d.includes("message is not modified") && !d.includes("message to delete not found")) {
        console.error(`TG ${method} failed [${data.error_code}]: ${d}`);
      }
    }
    return data;
  } catch (e) {
    console.error(`TG ${method} exception:`, e);
    return { ok: false, error_code: 0, description: String(e) };
  }
}

function clip(text, max = 4000) {
  const t = String(text);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

async function sendMessage(env, chatId, text, replyMarkup = null, extra = {}) {
  /** @type {Record<string, any>} */
  const payload = {
    chat_id: chatId,
    text: clip(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
  let res = await tg(env, "sendMessage", payload);
  if (!res.ok && String(res.description || "").includes("parse entities")) {
    const { parse_mode, ...plain } = payload;
    res = await tg(env, "sendMessage", { ...plain, text: clip(stripTags(text)) });
  }
  return res;
}

async function editMessageText(env, chatId, messageId, text, replyMarkup = null) {
  /** @type {Record<string, any>} */
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: clip(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  };
  let res = await tg(env, "editMessageText", payload);
  if (!res.ok && String(res.description || "").includes("parse entities")) {
    const { parse_mode, ...plain } = payload;
    res = await tg(env, "editMessageText", { ...plain, text: clip(stripTags(text)) });
  }
  return res;
}

const deleteMessage = (env, chatId, messageId) => tg(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
const answerCallback = (env, id, text = null, alert = false) =>
  tg(env, "answerCallbackQuery", {
    callback_query_id: id,
    ...(text ? { text } : {}),
    ...(alert ? { show_alert: true } : {})
  });
const restrictChatMember = (env, chatId, userId, perms, untilDate = 0) =>
  tg(env, "restrictChatMember", { chat_id: chatId, user_id: userId, permissions: perms, until_date: untilDate });
const banChatMember = (env, chatId, userId) => tg(env, "banChatMember", { chat_id: chatId, user_id: userId });
const unbanChatMember = (env, chatId, userId) => tg(env, "unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
async function kickChatMember(env, chatId, userId) {
  const r = await banChatMember(env, chatId, userId);
  if (r.ok) await unbanChatMember(env, chatId, userId);
  return r;
}

// بررسی ادمین بودن (با کش ۶۰ ثانیه‌ای داخل حافظه برای کاهش تعداد درخواست‌ها)
const adminCache = new Map();
async function checkIfAdmin(env, chatId, userId, fresh = false) {
  if (!userId) return false;
  const key = `${chatId}:${userId}`;
  const hit = adminCache.get(key);
  if (!fresh && hit && hit.exp > Date.now()) return hit.v;
  const data = await tg(env, "getChatMember", { chat_id: chatId, user_id: userId });
  if (!(data.ok && data.result)) return false;
  const v = data.result.status === "administrator" || data.result.status === "creator";
  if (adminCache.size > 3000) adminCache.clear();
  adminCache.set(key, { v, exp: Date.now() + ADMIN_TTL_MS });
  return v;
}

let lastErrorReport = 0;
async function reportError(env, err, where) {
  console.error("Worker error @", where, err);
  if (!env.OWNER_ID) return;
  const now = Date.now();
  if (now - lastErrorReport < 60000) return;
  lastErrorReport = now;
  const body = esc(String((err && err.stack) || err)).slice(0, 1500);
  await sendMessage(env, env.OWNER_ID, `🚨 <b>خطا در ربات</b> (${esc(where)})\n<pre>${body}</pre>`);
}

// ================= تنظیمات و داده‌های گروه =================

async function getSettings(env, chatId) {
  const key = `settings:${chatId}`;
  const c = memGet(key);
  if (c) return { ...c };
  let s = { ...DEFAULT_SETTINGS };
  const raw = await kvGet(env, key);
  if (raw) {
    try { s = { ...s, ...JSON.parse(raw) }; } catch (e) { console.error("settings parse error", e); }
  }
  memSet(key, s);
  return { ...s };
}
async function saveSettings(env, chatId, settings) {
  memSet(`settings:${chatId}`, { ...settings });
  await kvPut(env, `settings:${chatId}`, JSON.stringify(settings));
}

async function getBadWords(env, chatId) {
  const key = `badwords:${chatId}`;
  const c = memGet(key);
  if (c) return [...c];
  let words = [...DEFAULT_BADWORDS];
  const raw = await kvGet(env, key);
  if (raw) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) words = p; } catch (e) { console.error("badwords parse error", e); }
  }
  memSet(key, words);
  return [...words];
}
async function saveBadWords(env, chatId, words) {
  memSet(`badwords:${chatId}`, [...words]);
  await kvPut(env, `badwords:${chatId}`, JSON.stringify(words));
}

async function getAdSettings(env, chatId) {
  const def = {
    enabled: false, interval_hours: 2, last_sent: 0, last_msg_id: 0,
    text: "🔥 برای ساخت ربات‌های پیشرفته هوش مصنوعی به چنل ترندیفای بپیوندید!\n🆔 @Trendify"
  };
  const raw = await kvGet(env, `ad_config:${chatId}`);
  if (!raw) return def;
  try { return { ...def, ...JSON.parse(raw) }; } catch (e) { return def; }
}
async function saveAdSettings(env, chatId, ad) {
  await kvPut(env, `ad_config:${chatId}`, JSON.stringify(ad));
}

async function resetGroupData(env, chatId) {
  memSet(`settings:${chatId}`, { ...DEFAULT_SETTINGS });
  memSet(`badwords:${chatId}`, [...DEFAULT_BADWORDS]);
  if (!env.KV) return;
  await kvDelete(env, `settings:${chatId}`);
  await kvDelete(env, `badwords:${chatId}`);
  await kvDelete(env, `ad_config:${chatId}`);
  try {
    for (const prefix of [`warn:${chatId}:`, `captcha:${chatId}:`, `muted:${chatId}:`]) {
      let cursor;
      do {
        const list = await env.KV.list({ prefix, cursor });
        for (const k of list.keys) await env.KV.delete(k.name);
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    }
  } catch (e) { console.error("reset list error", e); }
}

// گروه‌هایی که هر ادمین مدیریت می‌کند (برای کنسول پیوی)
const seenAdminGroups = new Set();
async function registerAdminGroup(env, userId, chatId, title) {
  const memoKey = `${userId}:${chatId}:${title}`;
  if (seenAdminGroups.has(memoKey)) return;
  if (seenAdminGroups.size > 5000) seenAdminGroups.clear();
  seenAdminGroups.add(memoKey);

  const key = `admin_groups:${userId}`;
  let list = [];
  try { list = JSON.parse((await kvGet(env, key)) || "[]"); } catch (e) { list = []; }
  const id = String(chatId);
  const existing = list.find((g) => g.id === id);
  if (!existing) {
    list.push({ id, title });
    await kvPut(env, key, JSON.stringify(list.slice(-20)));
  } else if (existing.title !== title) {
    existing.title = title;
    await kvPut(env, key, JSON.stringify(list));
  }
  const selected = await kvGet(env, `admin_group:${userId}`);
  if (!selected) await kvPut(env, `admin_group:${userId}`, id);
}

async function getGroupTitle(env, userId, chatId) {
  try {
    const list = JSON.parse((await kvGet(env, `admin_groups:${userId}`)) || "[]");
    const g = list.find((x) => x.id === String(chatId));
    return g ? g.title : String(chatId);
  } catch (e) {
    return String(chatId);
  }
}

// ================= ورودی اصلی Worker =================

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot is running!");

    // تأیید اصالت درخواست‌ها (فقط تلگرام با secret_token درست)
    if (env.WEBHOOK_SECRET) {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    let update;
    try { update = await request.json(); } catch (e) { return new Response("OK"); }

    const job = processUpdate(env, update).catch((e) => reportError(env, e, "update"));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
    else await job;
    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    const job = runScheduled(env).catch((e) => reportError(env, e, "scheduled"));
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
    else await job;
  }
};

async function processUpdate(env, update) {
  if (update.callback_query) return handleCallbackQuery(env, update.callback_query);

  const edited = !!update.edited_message;
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  if (msg.chat.type === "private") {
    if (!edited) await handlePrivateMessage(env, msg);
    return;
  }
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    await handleGroupMessage(env, msg, edited);
  }
}

// ================= پردازش پیام‌های گروه =================

function isServiceMessage(msg) {
  return SERVICE_KEYS.some((k) => msg[k] !== undefined);
}

async function handleGroupMessage(env, msg, edited) {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;
  const userId = from.id;
  if (userId === TELEGRAM_SERVICE_ID || msg.is_automatic_forward) return;

  const settings = await getSettings(env, chatId);

  // پیام‌های سرویسی (ورود/خروج و ...)
  if (!edited && isServiceMessage(msg)) {
    if (msg.new_chat_members) await handleNewMembers(env, msg, settings);
    if (settings.service) await deleteMessage(env, chatId, msg.message_id);
    return;
  }

  const isAnon = !!(msg.sender_chat && msg.sender_chat.id === chatId);
  if (msg.sender_chat && !isAnon) return; // پست کانال‌ها
  const isAdmin = isAnon || (await checkIfAdmin(env, chatId, userId));
  const text = (msg.text || "").trim();

  if (isAdmin && !isAnon && !edited) {
    await registerAdminGroup(env, userId, chatId, msg.chat.title || "گروه بدون نام");
  }

  if (!edited && text) {
    const norm = text.replace(/^(\/\w+)@\w+/, "$1");

    // قوانین: برای همه
    if (isExactCmd(norm, ["قوانین", "/rules"])) {
      const rules = settings.rules_text;
      await sendMessage(env, chatId, rules ? `📜 <b>قوانین گروه</b>\n\n${esc(rules)}` : "ℹ️ هنوز قوانینی برای این گروه ثبت نشده است.");
      return;
    }

    if (isAdmin) {
      const handled = await handleAdminCommands(env, {
        chatId, msg, text: norm, isPrivate: false,
        reply: (t, kb) => sendMessage(env, chatId, t, kb)
      });
      if (handled) return;
    }
  }

  if (!isAdmin) await moderate(env, msg, settings, edited);
}

// ================= موتور نظارت =================

const floodMap = new Map();
function floodCheck(chatId, userId, settings) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  if (floodMap.size > 5000) floodMap.clear();
  const rec = floodMap.get(key) || { times: [], lastWarn: 0 };
  rec.times = rec.times.filter((t) => now - t < FLOOD_WINDOW_MS);
  rec.times.push(now);
  floodMap.set(key, rec);
  if (rec.times.length > (settings.flood_count || 5)) {
    if (now - rec.lastWarn > FLOOD_WINDOW_MS) { rec.lastWarn = now; return "warn"; }
    return "silent";
  }
  return null;
}

const URL_RE = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[a-z0-9-]+\.(com|ir|org|net|me|io|info|xyz|ly|co|app|link|site|top|club|online)\b)/i;

async function moderate(env, msg, settings, edited) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";
  const entities = msg.entities || msg.caption_entities || [];
  const hasEntity = (...types) => entities.some((e) => types.includes(e.type));
  let reason = null;
  let silent = false;

  if (edited && settings.edited) { reason = "ویرایش پیام"; silent = true; }

  if (!reason && !edited && settings.flood) {
    const f = floodCheck(chatId, msg.from.id, settings);
    if (f) { reason = "ارسال پیام پشت‌سرهم (فلود)"; silent = f === "silent"; }
  }

  if (!reason) {
    if (settings.photo && msg.photo) reason = "ارسال تصویر";
    else if (settings.video && (msg.video || msg.video_note)) reason = "ارسال ویدیو";
    else if (settings.sticker && msg.sticker) reason = "ارسال استیکر";
    else if (settings.gif && msg.animation) reason = "ارسال گیف";
    else if (settings.voice && (msg.voice || msg.audio)) reason = "ارسال وویس/صدا";
    else if (settings.document && msg.document && !msg.animation) reason = "ارسال فایل";
    else if (settings.contact && msg.contact) reason = "ارسال مخاطب";
    else if (settings.location && (msg.location || msg.venue)) reason = "ارسال موقعیت مکانی";
    else if (settings.poll && msg.poll) reason = "ارسال نظرسنجی";
    else if (settings.forward && (msg.forward_origin || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name || msg.forward_date)) reason = "فوروارد پیام";
  }

  if (!reason && text) {
    if (settings.link && (hasEntity("url", "text_link") || URL_RE.test(text))) reason = "ارسال لینک";
    else if (settings.mention && (hasEntity("mention", "text_mention") || /@\w{4,}/.test(text))) reason = "ارسال یوزرنیم";
    else if (settings.hashtag && hasEntity("hashtag")) reason = "ارسال هشتگ";
    else if (settings.command && hasEntity("bot_command")) reason = "ارسال دستور";
  }

  if (!reason && settings.badwords && text) {
    const w = findBadWord(text, await getBadWords(env, chatId));
    if (w) reason = `استفاده از کلمه ممنوعه (${w})`;
  }

  if (!reason) return;

  await deleteMessage(env, chatId, msg.message_id);
  if (silent) return;
  await issueWarn(env, chatId, msg.from, settings, reason);
}

async function applyPunishment(env, chatId, userId, settings) {
  const action = settings.warn_action || "mute";
  if (action === "ban") return banChatMember(env, chatId, userId);
  if (action === "kick") return kickChatMember(env, chatId, userId);
  const until = Math.floor(Date.now() / 1000) + (settings.mute_hours || 24) * 3600;
  return restrictChatMember(env, chatId, userId, NO_PERMS, until);
}

async function getWarn(env, chatId, userId) {
  const raw = await kvGet(env, `warn:${chatId}:${userId}`);
  if (!raw) return { n: 0, name: "" };
  try {
    const p = JSON.parse(raw);
    if (typeof p === "number") return { n: p, name: "" };
    return { n: parseInt(p.n) || 0, name: p.name || "" };
  } catch (e) {
    return { n: parseInt(raw) || 0, name: "" };
  }
}

async function recordMute(env, chatId, userId, name, secs) {
  await kvPut(env, `muted:${chatId}:${userId}`, JSON.stringify({ name: name || "" }), { expirationTtl: Math.max(60, Math.floor(secs)) });
}

// اگر کاربر در تلگرام محدود (سکوت) است، محدودیت را برمی‌دارد؛ اگر برداشت true برمی‌گرداند
async function liftMute(env, chatId, userId) {
  await kvDelete(env, `muted:${chatId}:${userId}`);
  const r = await tg(env, "getChatMember", { chat_id: chatId, user_id: userId });
  if (r.ok && r.result && r.result.status === "restricted") {
    const res = await restrictChatMember(env, chatId, userId, FULL_PERMS, 0);
    return !!res.ok;
  }
  return false;
}

async function clearUserWarns(env, chatId, userId) {
  await kvDelete(env, `warn:${chatId}:${userId}`);
  return liftMute(env, chatId, userId);
}

async function getWarnList(env, gid) {
  if (!env.KV) return { entries: [], total: 0 };
  const wPrefix = `warn:${gid}:`;
  const mPrefix = `muted:${gid}:`;
  const wNames = await listAllKeys(env, wPrefix);
  const mNames = await listAllKeys(env, mPrefix);
  /** @type {Record<string, {id: string, n: number, name: string, muted: boolean}>} */
  const map = {};
  for (const name of wNames.slice(0, 60)) {
    const uid = name.slice(wPrefix.length);
    const w = await getWarn(env, gid, uid);
    if (w.n > 0) map[uid] = { id: uid, n: w.n, name: w.name, muted: false };
  }
  for (const name of mNames.slice(0, 60)) {
    const uid = name.slice(mPrefix.length);
    let nm = "";
    try { nm = JSON.parse((await kvGet(env, name)) || "{}").name || ""; } catch (e) { nm = ""; }
    if (map[uid]) { map[uid].muted = true; if (!map[uid].name) map[uid].name = nm; }
    else map[uid] = { id: uid, n: 0, name: nm, muted: true };
  }
  const entries = Object.values(map).sort((a, b) => b.n - a.n);
  return { entries, total: entries.length };
}

function warnLabel(e) {
  return (e.name && e.name !== e.id ? e.name : e.id).slice(0, 25);
}

async function renderWarnList(env, gid) {
  const { entries, total } = await getWarnList(env, gid);
  if (!entries.length) return { text: "✅ هیچ کاربری اخطار یا سکوت فعال ندارد.", entries };
  const lines = entries.slice(0, 40).map((e) => `▫️ ${e.muted ? "🔇 " : ""}${esc(warnLabel(e))} — <b>${e.n}</b> اخطار (<code>${e.id}</code>)`);
  const more = total > entries.length ? `\n… و ${total - entries.length} مورد دیگر` : "";
  return {
    text: `⚠️ <b>کاربران دارای اخطار یا سکوت (${entries.length}):</b>\n\n${lines.join("\n")}${more}\n\n🔇 = در حال سکوت\nحذف یک نفر (و برداشتن سکوتش): <code>حذف اخطار [آیدی]</code>\nحذف همه: <code>حذف همه اخطارها</code>`,
    entries
  };
}

async function clearAllWarns(env, gid) {
  if (!env.KV) return 0;
  const { entries } = await getWarnList(env, gid);
  for (const e of entries) await clearUserWarns(env, gid, e.id);
  return entries.length;
}

async function issueWarn(env, chatId, user, settings, reason) {
  const key = `warn:${chatId}:${user.id}`;
  const warns = (await getWarn(env, chatId, user.id)).n + 1;
  const limit = settings.warn_limit || 3;
  const who = mention(user.id, user.first_name);

  if (warns >= limit) {
    await kvDelete(env, key);
    const res = await applyPunishment(env, chatId, user.id, settings);
    if (!res.ok) {
      await sendMessage(env, chatId, `⚠️ ${who} به ${limit} اخطار رسید (${esc(reason)}) اما ربات دسترسی کافی ندارد.\nربات را ادمین کنید و دسترسی «محدود کردن/مسدود کردن کاربران» بدهید.`);
      return;
    }
    const act = settings.warn_action || "mute";
    if (act === "mute") await recordMute(env, chatId, user.id, user.first_name, (settings.mute_hours || 24) * 3600);
    const phrase = act === "ban" ? "برای همیشه <b>مسدود</b> شد" : act === "kick" ? "<b>اخراج</b> شد" : `به مدت <b>${hoursLabel(settings.mute_hours || 24)}</b> <b>سکوت</b> شد`;
    await sendMessage(env, chatId, `🚫 کاربر ${who} به دلیل دریافت ${limit} اخطار (${esc(reason)}) ${phrase}!`);
  } else {
    await kvPut(env, key, JSON.stringify({ n: warns, name: user.first_name || "" }), { expirationTtl: 86400 * 7 });
    await sendMessage(env, chatId, `⚠️ ${who}، <b>${esc(reason)}</b> در این گروه مجاز نیست!\n📊 اخطار شما: <b>${warns} از ${limit}</b>`);
  }
}

// ================= ورود اعضای جدید، کپچا، خوشامد =================

async function sendWelcome(env, chatId, settings, user, groupTitle) {
  if (!settings.welcome) return;
  const out = esc(settings.welcome_text || DEFAULT_WELCOME)
    .split("{mention}").join(mention(user.id, user.first_name))
    .split("{name}").join(esc(user.first_name || "کاربر"))
    .split("{group}").join(esc(groupTitle || ""))
    .split("{id}").join(String(user.id));
  await sendMessage(env, chatId, out);
}

async function handleNewMembers(env, msg, settings) {
  const chatId = msg.chat.id;
  const adder = msg.from;
  const botId = getBotId(env);
  const adderIsAdmin = adder ? await checkIfAdmin(env, chatId, adder.id) : false;

  for (const m of msg.new_chat_members) {
    if (m.id === botId) {
      await sendMessage(env, chatId, "👋 سلام! برای کار کامل، ربات را <b>ادمین</b> کنید (حذف پیام، محدود کردن و مسدود کردن کاربران).\nسپس بنویسید: <code>پنل</code>");
      continue;
    }
    if (m.is_bot) {
      if (settings.bots && !adderIsAdmin) await banChatMember(env, chatId, m.id);
      continue;
    }
    const addedByAdmin = adder && adder.id !== m.id && adderIsAdmin;

    if (settings.captcha && !addedByAdmin && !(await checkIfAdmin(env, chatId, m.id))) {
      const r = await restrictChatMember(env, chatId, m.id, NO_PERMS, 0);
      if (r.ok) {
        const sent = await sendMessage(
          env, chatId,
          `🔐 ${mention(m.id, m.first_name)}، برای تأیید ورود روی دکمه زیر بزنید.\n⏳ مهلت: ${Math.round(CAPTCHA_TIMEOUT_MS / 60000)} دقیقه`,
          { inline_keyboard: [[{ text: "✅ من ربات نیستم", callback_data: `cap|${m.id}` }]] }
        );
        if (sent.ok) {
          await kvPut(env, `captcha:${chatId}:${m.id}`, JSON.stringify({ m: sent.result.message_id, t: Date.now() }), { expirationTtl: 3600 });
        }
        continue;
      }
    }
    await sendWelcome(env, chatId, settings, m, msg.chat.title);
  }
}

// ================= دستورات ادمین (گروه و پیوی) =================

// ================= صفحات راهنما (منوی دکمه‌ای) =================

/** @type {Record<string, {label: string, text: string}>} */
const HELP_PAGES = {
  help_users: {
    label: "👤 مدیریت کاربران",
    text: [
      "👤 <b>مدیریت کاربران</b>",
      "روی پیام کاربر <b>ریپلای</b> کنید یا آیدی عددی بنویسید.",
      "",
      "▫️ <code>سکوت 30 دقیقه</code> | <code>سکوت 2 ساعت</code> | <code>سکوت 1 روز</code>",
      "▫️ <code>رفع سکوت</code>",
      "▫️ <code>بن</code> : مسدود کردن دائم",
      "▫️ <code>انبن</code> : رفع مسدودیت + صفر شدن اخطارها",
      "▫️ <code>اخراج</code> : اخراج (امکان ورود دوباره)",
      "",
      "مثال با آیدی: <code>بن 1868832604</code>",
      "ℹ️ این دستورات روی ادمین‌ها اجرا نمی‌شوند."
    ].join("\n")
  },
  help_warns: {
    label: "⚠️ اخطارها",
    text: [
      "⚠️ <b>اخطارها</b>",
      "",
      "▫️ <code>اخطار [دلیل]</code> : اخطار دستی (ریپلای یا آیدی)",
      "▫️ <code>اخطارها</code> : وضعیت اخطار یک کاربر",
      "▫️ <code>لیست اخطارها</code> : فهرست کاربران دارای اخطار",
      "▫️ <code>حذف اخطار</code> : صفر کردن اخطار یک کاربر",
      "▫️ <code>حذف همه اخطارها</code> : صفر کردن اخطار همه",
      "",
      "تعداد اخطار مجاز و نوع مجازات (سکوت/اخراج/بن) از <b>پنل ← تنظیمات اخطار</b> تنظیم می‌شود.",
      "🎛 در <b>پیوی ربات</b> منوی «کاربران اخطاردار» هم وجود دارد که با یک دکمه اخطار هر کاربر را پاک می‌کند."
    ].join("\n")
  },
  help_locks: {
    label: "🔐 قفل‌ها و پنل",
    text: [
      "🔐 <b>قفل‌ها و پنل</b>",
      "",
      "▫️ <code>پنل</code> : باز کردن پنل تنظیمات",
      "▫️ <code>بستن پنل</code> : بستن پنل",
      "",
      "<b>قفل‌های متن:</b> لینک، یوزرنیم، هشتگ، دستورات، فوروارد، ویرایش پیام، کلمات ممنوعه",
      "<b>قفل‌های رسانه:</b> عکس، فیلم، استیکر، گیف، وویس، فایل، مخاطب، موقعیت، نظرسنجی",
      "<b>امنیت:</b> ضد فلود، حذف پیام ورود/خروج، جلوگیری از ورود ربات",
      "",
      "قفل‌ها فقط روی اعضای عادی اعمال می‌شوند؛ ادمین‌ها آزادند."
    ].join("\n")
  },
  help_words: {
    label: "📋 فیلتر کلمات",
    text: [
      "📋 <b>فیلتر کلمات</b>",
      "",
      "▫️ <code>فیلتر کلمه</code>",
      "▫️ <code>فیلتر کلمه۱, کلمه۲, کلمه۳</code> : افزودن چندتایی",
      "▫️ <code>حذف فیلتر کلمه</code>",
      "▫️ <code>فیلترها</code> : تعداد کلمات",
      "",
      "🔒 برای حفظ حریم، <b>لیست کامل کلمات فقط در پیوی ربات</b> (پنل ← کلمات ممنوعه) نمایش داده می‌شود.",
      "",
      "ℹ️ تطبیق روی کلمه کامل انجام می‌شود (ی/ک عربی، نیم‌فاصله و اعراب نادیده گرفته می‌شود). عبارت چندکلمه‌ای هم پشتیبانی می‌شود."
    ].join("\n")
  },
  help_welcome: {
    label: "👋 خوشامد و قوانین",
    text: [
      "👋 <b>خوشامد و قوانین</b>",
      "",
      "▫️ <code>تنظیم خوشامد [متن]</code>",
      "▫️ <code>حذف خوشامد</code>",
      "متغیرها: {mention} {name} {group} {id}",
      "",
      "▫️ <code>تنظیم قوانین [متن]</code>",
      "▫️ <code>حذف قوانین</code>",
      "▫️ <code>قوانین</code> : نمایش قوانین (برای همه اعضا)",
      "",
      "🔐 کپچا و روشن/خاموش کردن خوشامد از <b>پنل ← خوشامد و قوانین</b>."
    ].join("\n")
  },
  help_tools: {
    label: "🛠 ابزارهای گروه",
    text: [
      "🛠 <b>ابزارهای گروه</b>",
      "",
      "▫️ <code>قفل گروه</code> | <code>بازکردن گروه</code>",
      "▫️ <code>پاکسازی 20</code> : حذف ۲۰ پیام اخیر (یا ریپلای روی اولین پیام)",
      "▫️ <code>پین</code> | <code>آنپین</code> (ریپلای)",
      "▫️ <code>آیدی</code> : نمایش آیدی عددی",
      "▫️ <code>ریست گروه</code> : بازگشت همه تنظیمات به حالت اول"
    ].join("\n")
  },
  help_private: {
    label: "🎛 پیوی و تبلیغات",
    text: [
      "🎛 <b>کنسول پیوی</b>",
      "",
      "▫️ <code>/start</code> : باز کردن کنسول",
      "▫️ <code>گروه‌ها</code> : انتخاب/تغییر گروه",
      "▫️ تنظیمات حساس (لیست کلمات، کاربران اخطاردار، تبلیغات) <b>فقط در پیوی</b> هستند.",
      "▫️ دستورات مدیریتی با آیدی عددی در پیوی هم کار می‌کنند: <code>بن 1868832604</code>",
      "",
      "📢 تبلیغات خودکار:",
      "▫️ <code>تنظیم تبلیغ [متن]</code> سپس از منو روشن کنید.",
      "▫️ ارسال خودکار نیاز به Cron Trigger دارد (در README)."
    ].join("\n")
  }
};


function resolveTarget(msg, textL) {
  const r = msg && msg.reply_to_message;
  if (r) {
    if (r.sender_chat || !r.from) return null;
    return { id: r.from.id, html: mention(r.from.id, r.from.first_name), name: r.from.first_name || "کاربر" };
  }
  const ent = ((msg && msg.entities) || []).find((e) => e.type === "text_mention" && e.user);
  if (ent) return { id: ent.user.id, html: mention(ent.user.id, ent.user.first_name), name: ent.user.first_name };
  const m = textL.match(/\d{6,15}/);
  if (m) return { id: parseInt(m[0]), html: `<code>${m[0]}</code>`, name: m[0] };
  return null;
}

function parseDuration(textL) {
  const m = textL.replace(/\d{6,15}/g, "").match(/(\d{1,4})\s*(ثانیه|دقیقه|ساعت|روز|هفته|min|s|m|h|d|w)?/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = (m[2] || "دقیقه").toLowerCase();
  /** @type {Record<string, number>} */
  const multTable = { "ثانیه": 1, s: 1, "دقیقه": 60, m: 60, min: 60, "ساعت": 3600, h: 3600, "روز": 86400, d: 86400, "هفته": 604800, w: 604800 };
  const mult = multTable[unit] || 60;
  return Math.max(60, n * mult);
}

function splitWords(str) {
  return str.split(/[,\n،؛;]+/).map((w) => w.trim()).filter((w) => w.length > 1);
}

async function sendPanel(env, chatId) {
  const { text, kb } = await renderMenu(env, "g", chatId, "main", 0);
  await sendMessage(env, chatId, text, kb);
}

async function handleAdminCommands(env, c) {
  const { chatId, msg, isPrivate, reply } = c;
  const text = c.text;
  const textL = toLatinDigits(text);
  const botId = getBotId(env);
  let rest;

  // ---- گروه‌محور ----
  if (!isPrivate && isExactCmd(text, ["/panel", "پنل"])) { await sendPanel(env, chatId); return true; }

  if (!isPrivate && isExactCmd(text, ["بستن پنل", "/close"])) {
    if (msg.reply_to_message) await deleteMessage(env, chatId, msg.reply_to_message.message_id);
    await deleteMessage(env, chatId, msg.message_id);
    return true;
  }

  if (isExactCmd(text, ["راهنما", "/help"])) {
    const hm = await renderMenu(env, isPrivate ? "p" : "g", chatId, "help", c.userId || 0);
    await reply(hm.text, hm.kb);
    return true;
  }

  if (isExactCmd(text, ["آیدی", "/id"])) {
    const t = resolveTarget(msg, "");
    const lines = [`💬 آیدی چت: <code>${chatId}</code>`];
    if (t) lines.unshift(`👤 آیدی ${t.html}: <code>${t.id}</code>`);
    else if (msg.from && !isPrivate) lines.unshift(`👤 آیدی شما: <code>${msg.from.id}</code>`);
    await reply(lines.join("\n"));
    return true;
  }

  // ---- فیلتر کلمات ----
  if (isExactCmd(text, ["فیلترها", "/filters"])) {
    const words = await getBadWords(env, chatId);
    if (!isPrivate) {
      await reply(`📋 تعداد کلمات فیلتر شده: <b>${words.length}</b>\n🔒 لیست کامل فقط در پیوی ربات (پنل ← کلمات ممنوعه) نمایش داده می‌شود.`);
      return true;
    }
    await reply(words.length ? `📋 <b>کلمات فیلتر شده (${words.length}):</b>\n\n${words.slice(0, 100).map((w) => `▫️ ${esc(w)}`).join("\n")}` : "📋 هیچ کلمه‌ای ثبت نشده است.");
    return true;
  }

  if ((rest = matchCmd(text, ["حذف فیلتر", "/delword"])) !== null) {
    const del = splitWords(rest);
    if (!del.length) { await reply("⚠️ مثال: <code>حذف فیلتر کلمه</code>"); return true; }
    const norm = del.map((w) => normalizeText(w));
    const words = await getBadWords(env, chatId);
    const kept = words.filter((w) => !norm.includes(normalizeText(w)));
    await saveBadWords(env, chatId, kept);
    await reply(`🗑 ${words.length - kept.length} کلمه از لیست فیلتر حذف شد.`);
    return true;
  }

  if ((rest = matchCmd(text, ["فیلتر کلمات", "فیلتر", "/addwords"])) !== null) {
    const add = splitWords(rest);
    if (!add.length) { await reply("⚠️ مثال:\n<code>فیلتر کلمه</code>\n<code>فیلتر کلمه۱, کلمه۲, کلمه۳</code>"); return true; }
    const words = await getBadWords(env, chatId);
    const known = new Set(words.map((w) => normalizeText(w)));
    let added = 0;
    for (const w of add) {
      if (words.length >= MAX_WORDS) break;
      if (!known.has(normalizeText(w))) { words.push(w); known.add(normalizeText(w)); added++; }
    }
    await saveBadWords(env, chatId, words);
    await reply(`✅ ${added} کلمه جدید به فیلتر اضافه شد. (مجموع: ${words.length})`);
    return true;
  }

  // ---- خوشامد و قوانین ----
  if ((rest = matchCmd(text, ["تنظیم خوشامد", "/setwelcome"])) !== null) {
    if (!rest) { await reply("⚠️ مثال:\n<code>تنظیم خوشامد سلام {mention} به {group} خوش آمدی</code>\nمتغیرها: {mention} {name} {group} {id}"); return true; }
    const s = await getSettings(env, chatId);
    s.welcome_text = rest.slice(0, 1000);
    s.welcome = true;
    await saveSettings(env, chatId, s);
    await reply("✅ پیام خوشامد ذخیره و <b>فعال</b> شد.");
    return true;
  }
  if (isExactCmd(text, ["حذف خوشامد"])) {
    const s = await getSettings(env, chatId);
    s.welcome_text = DEFAULT_WELCOME; s.welcome = false;
    await saveSettings(env, chatId, s);
    await reply("✅ پیام خوشامد غیرفعال و به حالت پیش‌فرض برگشت.");
    return true;
  }
  if ((rest = matchCmd(text, ["تنظیم قوانین", "/setrules"])) !== null) {
    if (!rest) { await reply("⚠️ مثال:\n<code>تنظیم قوانین ۱. احترام ۲. بدون تبلیغ</code>"); return true; }
    const s = await getSettings(env, chatId);
    s.rules_text = rest.slice(0, 3000);
    await saveSettings(env, chatId, s);
    await reply("✅ قوانین ذخیره شد. اعضا با نوشتن <code>قوانین</code> آن را می‌بینند.");
    return true;
  }
  if (isExactCmd(text, ["حذف قوانین"])) {
    const s = await getSettings(env, chatId);
    s.rules_text = "";
    await saveSettings(env, chatId, s);
    await reply("✅ قوانین حذف شد.");
    return true;
  }

  // ---- اخطارها ----
  if (isExactCmd(text, ["لیست اخطارها", "اخطارداران", "/warnlist"])) {
    const wl = await renderWarnList(env, chatId);
    await reply(wl.text);
    return true;
  }
  if (isExactCmd(text, ["حذف همه اخطارها", "/clearwarns"])) {
    const cnt = await clearAllWarns(env, chatId);
    await reply(`✅ اخطارهای ${cnt} کاربر پاک شد.`);
    return true;
  }

  if ((rest = matchCmd(text, ["حذف اخطار", "صفر اخطار", "/resetwarn"])) !== null) {
    const t = resolveTarget(msg, textL);
    if (!t) { if (rest === "") await reply("⚠️ ریپلای کنید یا آیدی عددی بنویسید:\n<code>حذف اخطار 1868832604</code>"); return true; }
    const lifted = await clearUserWarns(env, chatId, t.id);
    await reply(`✅ اخطارهای ${t.html} صفر شد.${lifted ? "\n🔊 سکوت او هم برداشته شد." : ""}`);
    return true;
  }

  if ((rest = matchCmd(text, ["اخطارها", "وضعیت اخطار", "/warns"])) !== null) {
    const t = resolveTarget(msg, textL);
    if (!t) { if (rest === "") await reply("⚠️ ریپلای کنید یا آیدی عددی بنویسید:\n<code>اخطارها 1868832604</code>"); return true; }
    const s = await getSettings(env, chatId);
    const w = (await getWarn(env, chatId, t.id)).n;
    await reply(`📊 وضعیت اخطار ${t.html}:\n⚠️ تعداد: <b>${w} از ${s.warn_limit}</b>`);
    return true;
  }

  // ---- اقدام روی کاربر (نیازمند هدف) ----
  const userActions = [
    ["اخطار", ["اخطار", "/warn"]],
    ["unban", ["انبن", "آنبن", "آن‌بن", "/unban"]],
    ["ban", ["بن", "/ban"]],
    ["kick", ["اخراج", "/kick"]],
    ["unmute", ["رفع سکوت", "حذف سکوت", "/unmute"]],
    ["mute", ["سکوت", "/mute"]]
  ];
  // رفع سکوت باید قبل از سکوت بررسی شود
  const order = ["اخطار", "unban", "ban", "kick", "unmute", "mute"];
  for (const key of order) {
    const names = userActions.find((a) => a[0] === key)[1];
    rest = matchCmd(text, names);
    if (rest === null) continue;

    const t = resolveTarget(msg, textL);
    /** @type {Record<string, string>} */
    const usageTable = { "اخطار": "اخطار", unban: "انبن", ban: "بن", kick: "اخراج", unmute: "رفع سکوت", mute: "سکوت 30 دقیقه" };
    const usage = usageTable[key];
    if (!t) {
      if (rest === "") await reply(`⚠️ ریپلای کنید یا آیدی عددی بنویسید:\n<code>${usage} 1868832604</code>`);
      return rest === "";
    }

    if (key !== "unban" && key !== "unmute") {
      if (t.id === botId) { await reply("😅 نمی‌توانم این کار را روی خودم انجام دهم."); return true; }
      if (await checkIfAdmin(env, chatId, t.id, true)) { await reply("⛔️ این دستور روی ادمین‌ها قابل اجرا نیست."); return true; }
    }

    if (key === "اخطار") {
      const s = await getSettings(env, chatId);
      const reasonText = textL.replace(/\d{6,15}/g, "").replace(/^\S+\s*/, "").trim() || "رعایت نکردن قوانین";
      await issueWarn(env, chatId, { id: t.id, first_name: t.name }, s, reasonText);
    } else if (key === "unban") {
      const r = await unbanChatMember(env, chatId, t.id);
      await kvDelete(env, `warn:${chatId}:${t.id}`);
      await kvDelete(env, `muted:${chatId}:${t.id}`);
      await restrictChatMember(env, chatId, t.id, FULL_PERMS, 0);
      await reply(r.ok ? `✅ ${t.html} آزاد شد و اخطارهایش صفر گردید.` : "⚠️ انجام نشد؛ ربات باید ادمین باشد.");
    } else if (key === "ban") {
      const r = await banChatMember(env, chatId, t.id);
      await reply(r.ok ? `⛔️ ${t.html} مسدود شد.` : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی مسدود کردن باشد.");
    } else if (key === "kick") {
      const r = await kickChatMember(env, chatId, t.id);
      await reply(r.ok ? `👢 ${t.html} اخراج شد.` : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی مسدود کردن باشد.");
    } else if (key === "unmute") {
      const r = await restrictChatMember(env, chatId, t.id, FULL_PERMS, 0);
      await kvDelete(env, `muted:${chatId}:${t.id}`);
      await reply(r.ok ? `🔊 سکوت ${t.html} برداشته شد.` : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی محدود کردن باشد.");
    } else if (key === "mute") {
      const s = await getSettings(env, chatId);
      const secs = parseDuration(textL) || s.mute_hours * 3600;
      const r = await restrictChatMember(env, chatId, t.id, NO_PERMS, Math.floor(Date.now() / 1000) + secs);
      if (r.ok) await recordMute(env, chatId, t.id, t.name, secs);
      await reply(r.ok ? `🔇 ${t.html} به مدت <b>${humanDuration(secs)}</b> سکوت شد.` : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی محدود کردن باشد.");
    }
    return true;
  }

  if (isPrivate) return false;

  // ---- فقط گروه ----
  if (isExactCmd(text, ["قفل گروه", "/lockgroup"])) {
    const r = await tg(env, "setChatPermissions", { chat_id: chatId, permissions: NO_PERMS });
    await reply(r.ok ? "🔒 گروه قفل شد؛ فقط ادمین‌ها می‌توانند پیام بدهند." : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی «تغییر اطلاعات گروه» باشد.");
    return true;
  }
  if (isExactCmd(text, ["بازکردن گروه", "باز کردن گروه", "/unlockgroup"])) {
    const r = await tg(env, "setChatPermissions", { chat_id: chatId, permissions: FULL_PERMS });
    await reply(r.ok ? "🔓 گروه باز شد." : "⚠️ انجام نشد؛ ربات باید ادمین با دسترسی «تغییر اطلاعات گروه» باشد.");
    return true;
  }

  if ((rest = matchCmd(text, ["پاکسازی", "پاک", "/purge"])) !== null) {
    const n = parseInt(toLatinDigits(rest));
    let fromId;
    if (msg.reply_to_message) fromId = msg.reply_to_message.message_id;
    else if (n > 0) fromId = msg.message_id - Math.min(n, 99);
    else { await reply("⚠️ مثال: <code>پاکسازی 20</code> یا ریپلای روی اولین پیامی که می‌خواهید از آن به بعد پاک شود."); return true; }
    let ids = [];
    for (let i = fromId; i <= msg.message_id; i++) ids.push(i);
    if (ids.length > 100) ids = ids.slice(ids.length - 100);
    await tg(env, "deleteMessages", { chat_id: chatId, message_ids: ids });
    await reply(`🧹 تا ${ids.length} پیام اخیر پاک شد. (پیام‌های قدیمی‌تر از ۴۸ ساعت حذف نمی‌شوند)`);
    return true;
  }

  if (isExactCmd(text, ["پین", "/pin"])) {
    if (!msg.reply_to_message) { await reply("⚠️ روی پیام مورد نظر ریپلای کنید و بنویسید <code>پین</code>"); return true; }
    const r = await tg(env, "pinChatMessage", { chat_id: chatId, message_id: msg.reply_to_message.message_id });
    if (!r.ok) await reply("⚠️ انجام نشد؛ ربات باید ادمین با دسترسی «پین کردن پیام» باشد.");
    return true;
  }
  if (isExactCmd(text, ["آنپین", "/unpin"])) {
    const r = await tg(env, "unpinChatMessage", {
      chat_id: chatId,
      ...(msg.reply_to_message ? { message_id: msg.reply_to_message.message_id } : {})
    });
    if (!r.ok) await reply("⚠️ انجام نشد؛ ربات باید ادمین با دسترسی «پین کردن پیام» باشد.");
    return true;
  }

  if (isExactCmd(text, ["ریست گروه", "/resetgroup"])) {
    await resetGroupData(env, chatId);
    await reply("♻️ تمام تنظیمات این گروه (قفل‌ها، فیلترها، تبلیغات، اخطارها) به حالت اولیه برگشت.");
    return true;
  }

  return false;
}

// ================= کنسول پیوی =================

async function handlePrivateMessage(env, msg) {
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  const norm = text.replace(/^(\/\w+)@\w+/, "$1");
  const say = (t, kb) => sendMessage(env, userId, t, kb);

  let targetChatId = await kvGet(env, `admin_group:${userId}`);
  if (targetChatId && !(await checkIfAdmin(env, targetChatId, userId))) {
    await kvDelete(env, `admin_group:${userId}`);
    targetChatId = null;
  }

  if (isExactCmd(norm, ["/groups", "گروه‌ها", "گروه ها"])) { await showGroupPicker(env, userId); return; }

  if (isExactCmd(norm, ["/start", "/menu", "/panel", "منو", "پنل"])) {
    if (!targetChatId) { await showGroupPicker(env, userId, true); return; }
    await sendPvPanel(env, userId, targetChatId);
    return;
  }

  if (isExactCmd(norm, ["/help", "راهنما"])) {
    if (!targetChatId) { await showGroupPicker(env, userId, true); return; }
    const hm = await renderMenu(env, "p", targetChatId, "help", userId);
    await say(hm.text, hm.kb);
    return;
  }

  if (!targetChatId) { await showGroupPicker(env, userId, true); return; }

  // حالت انتظار برای دریافت کلمات فیلتر
  const stateRaw = await kvGet(env, `pv_state:${userId}`);
  if (stateRaw) {
    if (isExactCmd(norm, ["/cancel", "لغو"])) {
      await kvDelete(env, `pv_state:${userId}`);
      await say("❎ لغو شد.");
      return;
    }
    if (stateRaw.startsWith("words:")) {
      const gid = stateRaw.slice(6);
      const words = splitWords(text);
      const cur = await getBadWords(env, gid);
      const known = new Set(cur.map((w) => normalizeText(w)));
      let added = 0;
      for (const w of words) {
        if (cur.length >= MAX_WORDS) break;
        if (!known.has(normalizeText(w))) { cur.push(w); known.add(normalizeText(w)); added++; }
      }
      await saveBadWords(env, gid, cur);
      await kvDelete(env, `pv_state:${userId}`);
      await say(`✅ ${added} کلمه جدید اضافه شد. (مجموع: ${cur.length})`);
      return;
    }
  }

  // تنظیم متن تبلیغ
  const adRest = matchCmd(text, ["تنظیم تبلیغ", "تنظیم آگهی"]);
  if (adRest !== null) {
    if (!adRest) { await say("⚠️ مثال:\n<code>تنظیم تبلیغ متن آگهی شما</code>"); return; }
    const ad = await getAdSettings(env, targetChatId);
    ad.text = adRest.slice(0, 3000);
    await saveAdSettings(env, targetChatId, ad);
    await say("✅ متن تبلیغ ذخیره شد. برای فعال‌سازی از منوی «📢 تبلیغات» استفاده کنید.");
    return;
  }

  const handled = await handleAdminCommands(env, { chatId: targetChatId, msg, text: norm, isPrivate: true, userId, reply: say });
  if (handled) return;

  await say("🤔 دستور شناخته نشد. برای دیدن دستورات بنویسید <code>راهنما</code> یا <code>پنل</code>.");
}

async function showGroupPicker(env, userId, noGroupHint = false) {
  const { text, kb } = await renderGroups(env, userId, noGroupHint);
  await sendMessage(env, userId, text, kb);
}

async function renderGroups(env, userId, noGroupHint = false) {
  let list = [];
  try { list = JSON.parse((await kvGet(env, `admin_groups:${userId}`)) || "[]"); } catch (e) { list = []; }
  const valid = [];
  for (const g of list) if (await checkIfAdmin(env, g.id, userId)) valid.push(g);
  if (!valid.length) {
    return {
      text: "👋 سلام! من ربات مدیریت گروه هستم.\n\n1️⃣ مرا به گروهتان اضافه و <b>ادمین</b> کنید.\n2️⃣ در گروه یک بار بنویسید <code>پنل</code>.\n3️⃣ سپس اینجا برگردید و گروهتان را انتخاب کنید.",
      kb: null
    };
  }
  return {
    text: noGroupHint ? "📂 <b>کدام گروه را مدیریت می‌کنید؟</b>" : "📂 <b>گروه مورد نظر را انتخاب کنید:</b>",
    kb: { inline_keyboard: valid.map((g) => [{ text: g.title.slice(0, 40), callback_data: `p|${g.id}|x|sel` }]) }
  };
}

async function sendPvPanel(env, userId, gid) {
  const { text, kb } = await renderMenu(env, "p", gid, "main", userId);
  await sendMessage(env, userId, text, kb);
}

// ================= منوها (پنل گروه و کنسول پیوی با یک منطق مشترک) =================

function toggleRows(D, settings, list) {
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map(([k, label]) => ({ text: `${label} ${settings[k] ? "✅" : "❌"}`, callback_data: D("t", k) })));
  }
  return rows;
}

async function renderMenu(env, scope, gid, menu, userId) {
  const D = (a, arg = "") => (scope === "g" ? `g|${a}|${arg}` : `p|${gid}|${a}|${arg}`);
  const settings = await getSettings(env, gid);
  const back = [{ text: "🔙 بازگشت", callback_data: D("m", "main") }];
  const kb = (rows) => ({ inline_keyboard: rows });

  switch (menu) {
    case "text":
      return { text: "🔐 <b>قفل‌های متن و لینک</b>\nبا لمس هر گزینه وضعیت آن تغییر می‌کند:", kb: kb([...toggleRows(D, settings, LOCKS.text), back]) };

    case "media":
      return { text: "🎬 <b>قفل‌های رسانه</b>\nبا لمس هر گزینه وضعیت آن تغییر می‌کند:", kb: kb([...toggleRows(D, settings, LOCKS.media), back]) };

    case "sec":
      return {
        text: "🛡 <b>امنیت و ضد اسپم</b>\nبا لمس هر گزینه وضعیت آن تغییر می‌کند:",
        kb: kb([
          ...toggleRows(D, settings, LOCKS.sec),
          [{ text: `حساسیت فلود: ${settings.flood_count} پیام در ${FLOOD_WINDOW_MS / 1000} ثانیه 🔄`, callback_data: D("c", "flood_count") }],
          back
        ])
      };

    case "warn": {
      const act = settings.warn_action;
      const phrase = act === "mute" ? `${ACTION_LABEL.mute} (${hoursLabel(settings.mute_hours)})` : ACTION_LABEL[act];
      return {
        text: `⚠️ <b>تنظیمات اخطار</b>\n\nبا رسیدن کاربر به <b>${settings.warn_limit}</b> اخطار، مجازات: <b>${phrase}</b>\nبا لمس هر دکمه مقدار بعدی انتخاب می‌شود:`,
        kb: kb([
          [{ text: `حداکثر اخطار: ${settings.warn_limit} 🔄`, callback_data: D("c", "warn_limit") }],
          [{ text: `مجازات: ${ACTION_LABEL[act]} 🔄`, callback_data: D("c", "warn_action") }],
          [{ text: `مدت سکوت: ${hoursLabel(settings.mute_hours)} 🔄`, callback_data: D("c", "mute_hours") }],
          back
        ])
      };
    }

    case "welcome": {
      const preview = esc((settings.welcome_text || DEFAULT_WELCOME).slice(0, 300));
      return {
        text: `👋 <b>خوشامد، کپچا و قوانین</b>\n\n<b>متن خوشامد فعلی:</b>\n${preview}\n\n<b>قوانین:</b> ${settings.rules_text ? "ثبت شده ✅" : "ثبت نشده ❌"}\n\nتغییر متن با دستور (در گروه یا پیوی):\n<code>تنظیم خوشامد متن شما</code>\n<code>تنظیم قوانین متن قوانین</code>\nمتغیرها: {mention} {name} {group} {id}`,
        kb: kb([...toggleRows(D, settings, LOCKS.welcome), back])
      };
    }

    case "words": {
      const words = await getBadWords(env, gid);
      const list = words.length ? words.slice(0, 60).map((w) => `▫️ ${esc(w)}`).join("\n") : "هیچ کلمه‌ای ثبت نشده است.";
      const rows = [];
      if (scope === "p") rows.push([{ text: "➕ افزودن کلمات", callback_data: D("x", "aw") }]);
      rows.push([{ text: "🗑 پاکسازی کل لیست", callback_data: D("x", "cw") }]);
      rows.push(back);
      return {
        text: `📋 <b>کلمات فیلتر شده (${words.length}):</b>\n\n${list}\n\nافزودن: <code>فیلتر کلمه۱, کلمه۲</code>\nحذف: <code>حذف فیلتر کلمه</code>`,
        kb: kb(rows)
      };
    }

    case "clearwords":
      return {
        text: "⚠️ <b>مطمئن هستید؟</b>\nکل لیست کلمات فیلتر شده پاک می‌شود.",
        kb: kb([[{ text: "✅ بله، پاک شود", callback_data: D("x", "cwy") }, { text: "❌ انصراف", callback_data: D("m", "words") }]])
      };

    case "warned": {
      const wl = await renderWarnList(env, gid);
      const rows = wl.entries.slice(0, 20).map((e) => [{ text: `${e.muted ? "🔇" : "🧹"} ${warnLabel(e).slice(0, 20)} (${e.n})`, callback_data: D("x", "wr" + e.id) }]);
      if (wl.entries.length) rows.push([{ text: "🗑 پاک کردن اخطار همه", callback_data: D("x", "wra") }]);
      rows.push(back);
      return { text: wl.text + (wl.entries.length ? "\n\nبا لمس نام هر کاربر، اخطارهایش پاک و در صورت سکوت، سکوتش برداشته می‌شود:" : ""), kb: kb(rows) };
    }

    case "clearwarns":
      return {
        text: "⚠️ <b>مطمئن هستید؟</b>\nاخطار همه کاربران پاک و سکوت‌ها برداشته می‌شود.",
        kb: kb([[{ text: "✅ بله، پاک شود", callback_data: D("x", "wray") }, { text: "❌ انصراف", callback_data: D("m", "warned") }]])
      };

    case "ads": {
      const ad = await getAdSettings(env, gid);
      return {
        text: `📢 <b>تبلیغات خودکار گروه</b>\n\nوضعیت: ${ad.enabled ? "✅ روشن" : "❌ خاموش"}\nبازه ارسال: هر ${ad.interval_hours} ساعت\n\n<b>متن آگهی:</b>\n${esc(ad.text)}\n\nتغییر متن (در پیوی):\n<code>تنظیم تبلیغ [متن]</code>`,
        kb: kb([
          [{ text: ad.enabled ? "🔴 خاموش کردن" : "🟢 روشن کردن", callback_data: D("x", "ad") }],
          [{ text: `⏰ بازه: ${ad.interval_hours} ساعت 🔄`, callback_data: D("x", "adi") }],
          [{ text: "🚀 ارسال تست به گروه", callback_data: D("x", "adt") }],
          back
        ])
      };
    }

    default: {
      if (menu === "help") {
        const keys = Object.keys(HELP_PAGES);
        const hrows = [];
        for (let i = 0; i < keys.length; i += 2) {
          hrows.push(keys.slice(i, i + 2).map((k) => ({ text: HELP_PAGES[k].label, callback_data: D("m", k) })));
        }
        hrows.push(back);
        return { text: "📖 <b>راهنمای دستورات</b>\nیک بخش را انتخاب کنید:\n\n💡 دستورات مدیریت کاربران با <b>ریپلای</b> روی پیام کاربر یا آیدی عددی کار می‌کنند.", kb: kb(hrows) };
      }
      if (HELP_PAGES[menu]) {
        return {
          text: HELP_PAGES[menu].text,
          kb: kb([[{ text: "🔙 فهرست راهنما", callback_data: D("m", "help") }, { text: "🏠 منوی اصلی", callback_data: D("m", "main") }]])
        };
      }
      const rows = [
        [{ text: "🔐 قفل‌های متن", callback_data: D("m", "text") }, { text: "🎬 قفل‌های رسانه", callback_data: D("m", "media") }],
        [{ text: "🛡 امنیت و ضد اسپم", callback_data: D("m", "sec") }, { text: "⚠️ تنظیمات اخطار", callback_data: D("m", "warn") }]
      ];
      if (scope === "p") {
        rows.push([{ text: "👋 خوشامد و قوانین", callback_data: D("m", "welcome") }, { text: "📋 کلمات ممنوعه", callback_data: D("m", "words") }]);
        rows.push([{ text: "⚠️ کاربران اخطاردار", callback_data: D("m", "warned") }, { text: "📢 تبلیغات خودکار", callback_data: D("m", "ads") }]);
        rows.push([{ text: "📖 راهنمای دستورات", callback_data: D("m", "help") }, { text: "🔄 تغییر گروه", callback_data: D("x", "grp") }]);
      } else {
        rows.push([{ text: "👋 خوشامد و قوانین", callback_data: D("m", "welcome") }, { text: "📖 راهنمای دستورات", callback_data: D("m", "help") }]);
      }
      rows.push([{ text: "❌ بستن", callback_data: D("x", "close") }]);
      if (scope === "g") {
        return { text: "⚙️ <b>پنل مدیریت گروه</b>\nبخش مورد نظر را انتخاب کنید:\n\nبخش‌های حساس (کلمات ممنوعه، کاربران اخطاردار، تبلیغات) فقط در پیوی ربات هستند.", kb: kb(rows) };
      }
      const title = await getGroupTitle(env, userId, gid);
      return { text: `🎛 <b>کنسول مدیریت گروه</b>\n📂 گروه فعال: <b>${esc(title)}</b>\n\nبخش مورد نظر را انتخاب کنید:`, kb: kb(rows) };
    }
  }
}

// ================= کلیک دکمه‌ها =================

async function handleCallbackQuery(env, q) {
  const userId = q.from.id;
  let data = q.data || "";
  const message = q.message;
  if (!message) { await answerCallback(env, q.id); return; }
  const msgChatId = message.chat.id;
  const msgId = message.message_id;

  // کپچا
  if (data.startsWith("cap|")) {
    const target = parseInt(data.split("|")[1]);
    if (userId !== target) { await answerCallback(env, q.id, "⛔️ این دکمه برای شما نیست.", true); return; }
    await restrictChatMember(env, msgChatId, userId, FULL_PERMS, 0);
    await kvDelete(env, `captcha:${msgChatId}:${userId}`);
    await deleteMessage(env, msgChatId, msgId);
    await answerCallback(env, q.id, "✅ تأیید شد. خوش آمدید!");
    const s = await getSettings(env, msgChatId);
    await sendWelcome(env, msgChatId, s, q.from, message.chat.title);
    return;
  }

  // سازگاری با دکمه‌های نسخه قبلی
  if (message.chat.type !== "private") {
    /** @type {Record<string, string>} */
    const legacy = { menu_main: "g|m|main", menu_locks_media: "g|m|media", menu_locks_text: "g|m|text", cmd_close_panel: "g|x|close", cmd_badwords_list: "g|m|words", cmd_help: "g|m|main" };
    if (legacy[data]) data = legacy[data];
    else if (data.startsWith("toggle_")) data = `g|t|${data.slice(7)}`;
  }

  let scope, gid, action, arg;
  const parts = data.split("|");
  if (parts[0] === "g" && message.chat.type !== "private") {
    scope = "g"; gid = msgChatId; action = parts[1]; arg = parts[2] || "";
  } else if (parts[0] === "p" && message.chat.type === "private") {
    scope = "p"; gid = parts[1]; action = parts[2]; arg = parts[3] || "";
  } else {
    await answerCallback(env, q.id, "این پنل قدیمی است؛ دوباره آن را باز کنید.");
    return;
  }

  if (!(await checkIfAdmin(env, gid, userId))) {
    await answerCallback(env, q.id, "⛔️ این منو فقط برای ادمین‌های گروه است!", true);
    return;
  }

  // بخش‌هایی که در گروه نمایش داده نمی‌شوند (محتوای حساس یا مخصوص صاحب ربات)
  if (scope === "g") {
    const privOnlyMenus = ["words", "clearwords", "ads", "warned", "clearwarns"];
    const privOnlyActions = ["cw", "cwy", "aw", "ad", "adi", "adt", "wra", "wray", "grp", "sel"];
    if ((action === "m" && privOnlyMenus.includes(arg)) || (action === "x" && (privOnlyActions.includes(arg) || /^wr\d+$/.test(arg)))) {
      await answerCallback(env, q.id, "🔒 این بخش فقط در پیوی ربات در دسترس است.", true);
      return;
    }
  }

  let menu = "main";
  let toast = null;

  switch (action) {
    case "m":
      menu = arg;
      break;

    case "t": {
      if (!TOGGLE_MENU[arg]) { await answerCallback(env, q.id); return; }
      const s = await getSettings(env, gid);
      s[arg] = !s[arg];
      await saveSettings(env, gid, s);
      toast = s[arg] ? "🔒 فعال شد" : "🔓 غیرفعال شد";
      menu = TOGGLE_MENU[arg];
      break;
    }

    case "c": {
      const opts = CYCLES[arg];
      if (!opts) { await answerCallback(env, q.id); return; }
      const s = await getSettings(env, gid);
      s[arg] = opts[(opts.indexOf(s[arg]) + 1) % opts.length];
      await saveSettings(env, gid, s);
      menu = CYCLE_MENU[arg];
      break;
    }

    case "x": {
      if (arg === "close") {
        await deleteMessage(env, msgChatId, msgId);
        await answerCallback(env, q.id);
        return;
      }
      if (arg === "grp" && scope === "p") {
        const { text, kb } = await renderGroups(env, userId);
        await editMessageText(env, msgChatId, msgId, text, kb);
        await answerCallback(env, q.id);
        return;
      }
      if (arg === "sel" && scope === "p") {
        await kvPut(env, `admin_group:${userId}`, String(gid));
        await answerCallback(env, q.id, "گروه انتخاب شد ✅");
        break;
      }
      if (arg === "aw" && scope === "p") {
        await kvPut(env, `pv_state:${userId}`, `words:${gid}`, { expirationTtl: 600 });
        await answerCallback(env, q.id);
        await sendMessage(env, userId, "✍️ کلمات ممنوعه را بفرستید (با ویرگول یا خط جدید جدا کنید).\nبرای لغو: <code>لغو</code>");
        return;
      }
      if (arg === "wra") { menu = "clearwarns"; break; }
      if (arg === "wray") {
        const cnt = await clearAllWarns(env, gid);
        toast = `✅ اخطار ${cnt} کاربر پاک شد`;
        menu = "warned";
        break;
      }
      if (/^wr\d+$/.test(arg)) {
        const lifted = await clearUserWarns(env, gid, arg.slice(2));
        toast = lifted ? "✅ اخطار پاک و سکوت برداشته شد" : "✅ اخطارهای کاربر پاک شد";
        menu = "warned";
        break;
      }
      if (arg === "cw") { menu = "clearwords"; break; }
      if (arg === "cwy") {
        await saveBadWords(env, gid, []);
        toast = "🗑 لیست پاک شد";
        menu = "words";
        break;
      }
      if (arg === "ad" || arg === "adi" || arg === "adt") {
        const ad = await getAdSettings(env, gid);
        if (arg === "ad") { ad.enabled = !ad.enabled; if (ad.enabled) ad.last_sent = 0; await saveAdSettings(env, gid, ad); toast = ad.enabled ? "✅ تبلیغات روشن شد" : "❌ تبلیغات خاموش شد"; }
        if (arg === "adi") {
          const iv = [1, 2, 4, 6, 12, 24];
          ad.interval_hours = iv[(iv.indexOf(ad.interval_hours) + 1) % iv.length];
          await saveAdSettings(env, gid, ad);
          toast = `بازه روی هر ${ad.interval_hours} ساعت تنظیم شد`;
        }
        if (arg === "adt") {
          const r = await sendMessage(env, gid, esc(ad.text));
          toast = r.ok ? "🚀 پیام تست ارسال شد" : "⚠️ ارسال نشد؛ ربات در گروه ادمین است؟";
          await answerCallback(env, q.id, toast);
          return;
        }
        menu = "ads";
        break;
      }
      await answerCallback(env, q.id);
      return;
    }

    default:
      await answerCallback(env, q.id);
      return;
  }

  const { text, kb } = await renderMenu(env, scope, gid, menu, userId);
  await editMessageText(env, msgChatId, msgId, text, kb);
  await answerCallback(env, q.id, toast);
}

// ================= کارهای زمان‌بندی‌شده (Cron) =================

async function runScheduled(env) {
  if (!env.KV) return;
  await processCaptchaTimeouts(env);
  await processAds(env);
}

async function listAllKeys(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const list = await env.KV.list({ prefix, cursor });
    keys.push(...list.keys.map((k) => k.name));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return keys;
}

async function processCaptchaTimeouts(env) {
  const now = Date.now();
  for (const name of await listAllKeys(env, "captcha:")) {
    const [, chatId, userId] = name.split(":");
    let rec = null;
    try { rec = JSON.parse(await env.KV.get(name)); } catch (e) { rec = null; }
    if (!rec) { await env.KV.delete(name); continue; }
    if (now - rec.t < CAPTCHA_TIMEOUT_MS) continue;
    await kickChatMember(env, chatId, parseInt(userId));
    if (rec.m) await deleteMessage(env, chatId, rec.m);
    await env.KV.delete(name);
  }
}

async function processAds(env) {
  const now = Date.now();
  for (const name of await listAllKeys(env, "ad_config:")) {
    const chatId = name.slice("ad_config:".length);
    const ad = await getAdSettings(env, chatId);
    if (!ad.enabled) continue;
    if (now - (ad.last_sent || 0) < ad.interval_hours * 3600 * 1000 - 60 * 1000) continue;
    if (ad.last_msg_id) await deleteMessage(env, chatId, ad.last_msg_id);
    const res = await sendMessage(env, chatId, esc(ad.text));
    if (res.ok) {
      ad.last_sent = now;
      ad.last_msg_id = res.result.message_id;
    } else if (res.error_code === 403 || res.error_code === 400) {
      ad.enabled = false; // ربات از گروه حذف شده یا دسترسی ندارد
    }
    await saveAdSettings(env, chatId, ad);
  }
}
