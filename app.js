const express = require("express");
const app = express();

const SECRET = process.env.SECRET || "default-secret";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const CHAT_IDS = (process.env.CHAT_ID || "").split(",").map(id => id.trim()).filter(id => id);
const PORT = process.env.PORT || 3000;

// ⚠️ SECRET лежить у коді сторінки milwest.net, тобто він ПУБЛІЧНИЙ —
// сам по собі нікого не зупиняє. Справжній захист — фільтри нижче.
const SITE_HOST = "milwest.net";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://milwest.net,https://www.milwest.net")
  .split(",").map(o => o.trim()).filter(o => o);
const KNOWN_EVENTS = ["order_created_client", "callback_request_client", "order_success_page_hit"];

// Ліміти (заявок на дзвінок у реальності — кілька на день)
const IP_WINDOW_MS = 10 * 60 * 1000;        // з однієї IP: не більше 3 подій за 10 хв
const IP_MAX = Number(process.env.IP_MAX || 3);
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;    // загалом: не більше 20 подій за годину
const GLOBAL_MAX = Number(process.env.GLOBAL_MAX || 20);
const PHONE_DEDUP_MS = 30 * 60 * 1000;      // той самий телефон — раз на 30 хв (обидва скрипти шлють ту саму заявку)

// Мобільні коди операторів України (+380 XX ...): Київстар, Vodafone, lifecell, Інтертелеком, ТриМоб, PEOPLEnet.
// Стаціонарні (044, 061, 053...), окупаційні 071/072 і неіснуючі (090) — це спам-генератор.
const UA_MOBILE_CODES = new Set(["39", "50", "63", "66", "67", "68", "73", "75", "77", "89", "91", "92", "93", "94", "95", "96", "97", "98", "99"]);

console.log(`🚀 Telegram Chat IDs: ${CHAT_IDS.length}`);

// Railway стоїть перед нами проксі — довіряємо одному хопу, щоб req.ip був IP клієнта
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));

// === CORS HEADERS ===
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Secret");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Telegram webhook сервер працює" });
});

// === АНТИСПАМ ===
const ipHits = new Map();      // ip -> [timestamps]
let globalHits = [];           // [timestamps]
const recentPhones = new Map(); // phone -> timestamp
let blockedSinceAlert = 0;
let lastSpamAlert = 0;

// Railway кладе IP клієнта в X-Real-IP; req.ip — запасний варіант
function clientIp(req) {
  return String(req.headers["x-real-ip"] || req.ip || "unknown").split(",")[0].trim();
}

function prune(list, windowMs, now) {
  return list.filter(t => now - t < windowMs);
}

// Прибираємо старі записи, щоб Map не росли безкінечно
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of ipHits) {
    const fresh = prune(list, IP_WINDOW_MS, now);
    if (fresh.length) ipHits.set(ip, fresh); else ipHits.delete(ip);
  }
  for (const [phone, t] of recentPhones) {
    if (now - t > PHONE_DEDUP_MS) recentPhones.delete(phone);
  }
}, 5 * 60 * 1000).unref();

// "+38 (096) 123-45-67" / "0961234567" / "380961234567" → "380961234567" або null
function normalizeUaMobile(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) digits = "38" + digits;
  if (digits.length === 11 && digits.startsWith("80")) digits = "3" + digits;
  if (digits.length !== 12 || !digits.startsWith("380")) return null;
  if (!UA_MOBILE_CODES.has(digits.slice(3, 5))) return null;
  if (/^(\d)\1+$/.test(digits.slice(5))) return null; // 0000000, 1111111
  return digits;
}

// Сторінка має бути шляхом або URL саме milwest.net — інакше бот
// показав би «Відкрити сторінку» на будь-який (фішинговий) сайт
function isOwnPage(page) {
  if (!page) return true;
  const value = String(page);
  if (value.length > 500) return false;
  if (!/^https?:/i.test(value)) return !/^\/\//.test(value);
  try {
    const host = new URL(value).hostname;
    return host === SITE_HOST || host === `www.${SITE_HOST}`;
  } catch (e) {
    return false;
  }
}

// Повертає причину відмови або null, якщо запит схожий на справжній
function spamReason(req, payload) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return `чужий Origin: ${origin || "—"}`;
  if (!payload || !KNOWN_EVENTS.includes(payload.event)) return `невідома подія: ${payload && payload.event}`;

  if (payload.event === "callback_request_client") {
    const phone = normalizeUaMobile(payload.phone);
    if (!phone) return `не мобільний UA номер: ${payload.phone}`;
    if (String(payload.name || "").length > 60) return "задовге ім'я";
    if (/https?:|www\.|<|>/i.test(String(payload.name || ""))) return "посилання в імені";
    if (!isOwnPage(payload.page)) return `чужа сторінка: ${payload.page}`;
  }
  if (payload.event === "order_created_client" && (!payload.order || typeof payload.order !== "object")) {
    return "замовлення без даних";
  }
  if (payload.event === "order_success_page_hit" && !isOwnPage(payload.url)) {
    return `чужа сторінка: ${payload.url}`;
  }

  const now = Date.now();
  const ip = clientIp(req);
  const hits = prune(ipHits.get(ip) || [], IP_WINDOW_MS, now);
  if (hits.length >= IP_MAX) return `ліміт IP ${ip}`;
  globalHits = prune(globalHits, GLOBAL_WINDOW_MS, now);
  if (globalHits.length >= GLOBAL_MAX) return "загальний ліміт за годину";

  if (payload.event === "callback_request_client") {
    const phone = normalizeUaMobile(payload.phone);
    const seen = recentPhones.get(phone);
    if (seen && now - seen < PHONE_DEDUP_MS) return `дубль телефону ${phone}`;
    recentPhones.set(phone, now);
  }

  hits.push(now);
  ipHits.set(ip, hits);
  globalHits.push(now);
  return null;
}

// Одне попередження в чат на годину, якщо щось масово відсіюється
async function maybeAlertSpam() {
  blockedSinceAlert++;
  const now = Date.now();
  if (blockedSinceAlert < 5 || now - lastSpamAlert < 60 * 60 * 1000) return;
  const count = blockedSinceAlert;
  blockedSinceAlert = 0;
  lastSpamAlert = now;
  const message = `🛡 <b>Вебхук відсіяв ${count} підозрілих запитів</b>\nСхоже на спам-скрипт. Справжні заявки — в адмінці Хорошопу.`;
  for (const chatId of CHAT_IDS) {
    try { await sendToTelegram(chatId, message); } catch (e) {}
  }
}

// Функція для екранування HTML символів
function escapeHtml(text) {
  if (text === undefined || text === null || text === "") return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Функція для форматування URL в посилання
function formatPageUrl(url) {
  if (!url) return "—";
  
  // Якщо це просто path (починається з /)
  if (url.startsWith("/")) {
    return `https://milwest.net${url}`;
  }
  
  // Якщо це уже повна URL
  if (url.startsWith("http")) {
    return url;
  }
  
  return `https://milwest.net/${url}`;
}

// Функція для екстракції імені сторінки з URL
function getPageName(url) {
  if (!url) return "Головна";
  
  // Якщо це просто /
  if (url === "/" || url === "") {
    return "🏠 Головна сторінка";
  }
  
  // Витягуємо останню частину URL і розшифровуємо
  const parts = url.split("/").filter(p => p);
  const lastPart = parts[parts.length - 1];
  
  // Замінюємо дефіси на пробіли і капіталізуємо
  let pageName = lastPart
    .replace(/[-_]/g, " ")
    .replace(/\?.*/, "") // видаляємо query параметри
    .substring(0, 60); // обмежуємо довжину
  
  return pageName || "Товар";
}

// Функція для відправки в Telegram
async function sendToTelegram(chatId, message) {
  const response = await fetch(
    `${TELEGRAM_API_BASE}/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Telegram помилка для ${chatId}:`, error);
    throw new Error(error);
  }

  console.log(`✅ Відправлено в Telegram (${chatId})`);
  return response.json();
}

// Кривий payload (items не масив тощо) → 400, а не завислий запит
function safeHandler(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("💥 Помилка обробки:", error.message);
      if (!res.headersSent) res.status(400).json({ error: "Bad request" });
    }
  };
}

app.post("/api/telegram-webhook", safeHandler(async (req, res) => {
  const incomingSecret = req.headers["x-secret"];

  if (incomingSecret !== SECRET) {
    console.warn("❌ Невірний SECRET");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  const reason = spamReason(req, payload);
  if (reason) {
    // Відповідаємо «ok», щоб спамер не бачив, що його відсіюють
    console.warn(`🛡 Відсіяно (${clientIp(req)}): ${reason}`);
    maybeAlertSpam();
    return res.json({ ok: true });
  }
  console.log(`📨 Отримано: ${payload.event} (${clientIp(req)})`);

  let message = "";

  if (payload.event === "order_created_client") {
    const { order } = payload;
    message = `🛒 <b>НОВЕ ЗАМОВЛЕННЯ</b>\n\n`;
    message += `🔔 ID: <code>${escapeHtml(order.id || order.number || "N/A")}</code>\n`;
    message += `💵 Сума: <b>${escapeHtml(order.total || "—")} ${escapeHtml(order.currency || "UAH")}</b>\n`;
    message += `📦 Товарів: ${order.items?.length || 0}\n`;
    
    if (order.items && order.items.length > 0) {
      message += `\n<b>Склад:</b>\n`;
      order.items.forEach((item, idx) => {
        const title = escapeHtml((item.title || item.name || "Товар").substring(0, 50));
        const qty = item.quantity || 1;
        const price = escapeHtml(item.price || "—");
        message += `${idx + 1}. ${title}\n   ×${qty} – ${price}\n`;
      });
    }
  } else if (payload.event === "callback_request_client") {
    // 📱 CALLBACK ФОРМА
    const pageUrl = String(payload.page || "/");
    const pageName = getPageName(pageUrl);
    const fullPageUrl = formatPageUrl(pageUrl);

    message = `📞 <b>ЗАПИТ НА ДЗВІНОК</b>\n\n`;
    message += `👤 <b>Ім'я:</b> ${escapeHtml(payload.name || "—")}\n`;
    message += `📱 <b>Телефон:</b> <code>${escapeHtml(payload.phone || "—")}</code>\n`;
    message += `📧 <b>Email:</b> ${escapeHtml(payload.email || "—")}\n`;
    message += `\n📍 <b>Сторінка:</b>\n`;
    message += `   ${escapeHtml(pageName)}\n`;
    message += `   <a href="${escapeHtml(fullPageUrl)}">Відкрити сторінку</a>`;
  } else if (payload.event === "order_success_page_hit") {
    const od = payload.orderData || {};
    message = `✅ <b>ЗАМОВЛЕННЯ УСПІШНО ОФОРМЛЕНО</b>\n\n`;
    
    // Дата
    if (od.date) {
      message += `📅 <b>Дата:</b> ${escapeHtml(od.date)}\n`;
    }
    
    // Номер замовлення
    if (od.orderNumber) {
      message += `🔔 <b>Замовлення №</b> <code>${escapeHtml(od.orderNumber)}</code>\n\n`;
    }
    
    // Дані користувача
    message += `<b>👤 Замовник:</b>\n`;
    if (od.customerName) {
      message += `  Ім'я: ${escapeHtml(od.customerName)}\n`;
    }
    if (od.phone) {
      message += `  📱 Телефон: <code>${escapeHtml(od.phone)}</code>\n`;
    }
    if (od.city) {
      message += `  📍 Місто: ${escapeHtml(od.city)}\n`;
    }
    if (od.address) {
      message += `  🏠 Адреса: ${escapeHtml(od.address)}\n`;
    }
    
    // Доставка та оплата
    message += `\n<b>📦 Деталі замовлення:</b>\n`;
    if (od.deliveryMethod) {
      message += `  Доставка: ${escapeHtml(od.deliveryMethod)}\n`;
    }
    if (od.paymentMethod) {
      message += `  Оплата: ${escapeHtml(od.paymentMethod)}\n`;
    }
    
    // ТОВАРИ
    if (od.items && od.items.length > 0) {
      message += `\n<b>🛍️ Товари:</b>\n`;
      od.items.forEach((item, idx) => {
        const name = escapeHtml((item.name || "Товар").substring(0, 70));
        const pricePerUnit = escapeHtml(item.pricePerUnit || "—");
        const quantity = item.quantity || "1";
        const total = escapeHtml(item.total || "—");
        
        message += `\n${idx + 1}. ${name}\n`;
        message += `   💰 ${pricePerUnit} × ${quantity} = ${total}`;
      });
      message += `\n`;
    }
    
    // Сума
    if (od.total) {
      message += `\n<b>💰 Всього: ${escapeHtml(od.total)}</b>\n`;
    }
    
    message += `\n🌐 <a href="${escapeHtml(payload.url)}">Див. замовлення</a>`;
  }

  try {
    // ✅ ВІДПРАВЛЯЄМО В ВСІ CHAT_ID
    const results = [];
    for (const chatId of CHAT_IDS) {
      try {
        await sendToTelegram(chatId, message);
        results.push({ chatId, status: "ok" });
      } catch (error) {
        console.error(`❌ Помилка для ${chatId}:`, error.message);
        results.push({ chatId, status: "error", error: error.message });
      }
    }

    console.log("📤 Результати відправки:", results);
    res.json({ ok: true, sent: results });
  } catch (error) {
    console.error("💥 Помилка:", error.message);
    res.status(500).json({ error: error.message });
  }
}));

// Помилка в обробнику не повинна валити весь процес (Node 18 вбиває його
// на unhandled rejection — після цього Railway віддає 502)
process.on("unhandledRejection", (err) => {
  console.error("💥 unhandledRejection:", err && err.message ? err.message : err);
});

app.listen(PORT, () => {
  console.log(`🚀 Запущено на порту ${PORT}`);
  console.log(`📨 Слухаємо замовлення для ${CHAT_IDS.length} користувачів`);
});