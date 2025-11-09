const express = require("express");
const app = express();

const SECRET = process.env.SECRET || "default-secret";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
// ✅ КІЛЬКА CHAT_ID - розділяємо комою
const CHAT_IDS = (process.env.CHAT_ID || "").split(",").map(id => id.trim()).filter(id => id);
const PORT = process.env.PORT || 3000;

console.log(`🚀 Telegram Chat IDs: ${CHAT_IDS.join(", ")}`);

app.use(express.json());

// === CORS HEADERS ===
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Secret");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Telegram webhook сервер працює", chatIds: CHAT_IDS });
});

// Функція для екранування HTML символів
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Функція для відправки в Telegram
async function sendToTelegram(chatId, message) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
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

app.post("/api/telegram-webhook", async (req, res) => {
  const incomingSecret = req.headers["x-secret"] || req.query.secret;
  
  if (incomingSecret !== SECRET) {
    console.warn("❌ Невірний SECRET");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  console.log("📨 Отримано:", payload.event);

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
    message = `📞 <b>ЗАПИТ НА ДЗВІНОК</b>\n\n`;
    message += `👤 Ім'я: ${escapeHtml(payload.name || "—")}\n`;
    message += `📱 Телефон: <code>${escapeHtml(payload.phone || "—")}</code>\n`;
    message += `📧 Email: ${escapeHtml(payload.email || "—")}\n`;
    message += `🌐 Сторінка: ${escapeHtml(payload.page || "—")}`;
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
  } else {
    message = `📌 <b>${escapeHtml(payload.event || "подія")}</b>\n<code>${escapeHtml(JSON.stringify(payload, null, 2).substring(0, 300))}</code>`;
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
});

app.listen(PORT, () => {
  console.log(`🚀 Запущено на порту ${PORT}`);
  console.log(`📨 Слухаємо замовлення для ${CHAT_IDS.length} користувачів`);
});