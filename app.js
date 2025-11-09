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
        parse_mode: "Markdown"
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
    message = `🛒 *НОВЕ ЗАМОВЛЕННЯ*\n\n`;
    message += `🔔 ID: \`${order.id || order.number || "N/A"}\`\n`;
    message += `💵 Сума: *${order.total || "—"} ${order.currency || "UAH"}*\n`;
    message += `📦 Товарів: ${order.items?.length || 0}\n`;
    
    if (order.items && order.items.length > 0) {
      message += `\n*Склад:*\n`;
      order.items.forEach((item, idx) => {
        const title = (item.title || item.name || "Товар").substring(0, 50);
        const qty = item.quantity || 1;
        const price = item.price || "—";
        message += `${idx + 1}. ${title}\n   ×${qty} – ${price}\n`;
      });
    }
  } else if (payload.event === "callback_request_client") {
    message = `📞 *ЗАПИТ НА ДЗВІНОК*\n\n`;
    message += `👤 Ім'я: ${payload.name || "—"}\n`;
    message += `📱 Телефон: \`${payload.phone || "—"}\`\n`;
    message += `📧 Email: ${payload.email || "—"}\n`;
    message += `🌐 Сторінка: ${payload.page || "—"}`;
  } else if (payload.event === "order_success_page_hit") {
    const od = payload.orderData || {};
    message = `✅ *ЗАМОВЛЕННЯ УСПІШНО ОФОРМЛЕНО*\n\n`;
    
    // Дата
    if (od.date) {
      message += `📅 *Дата:* ${od.date}\n`;
    }
    
    // Номер замовлення
    if (od.orderNumber) {
      message += `🔔 *Замовлення №* \`${od.orderNumber}\`\n\n`;
    }
    
    // Дані користувача
    message += `*👤 Замовник:*\n`;
    if (od.customerName) {
      message += `  Ім'я: ${od.customerName}\n`;
    }
    if (od.phone) {
      message += `  📱 Телефон: \`${od.phone}\`\n`;
    }
    if (od.city) {
      message += `  📍 Місто: ${od.city}\n`;
    }
    if (od.address) {
      message += `  🏠 Адреса: ${od.address}\n`;
    }
    
    // Доставка та оплата
    message += `\n*📦 Деталі замовлення:*\n`;
    if (od.deliveryMethod) {
      message += `  Доставка: ${od.deliveryMethod}\n`;
    }
    if (od.paymentMethod) {
      message += `  Оплата: ${od.paymentMethod}\n`;
    }
    
    // ТОВАРИ - красиво!
    if (od.items && od.items.length > 0) {
      message += `\n*🛍️  Товари:*\n`;
      od.items.forEach((item, idx) => {
        const name = (item.name || "Товар").substring(0, 70);
        const pricePerUnit = item.pricePerUnit || "—";
        const quantity = item.quantity || "1";
        const total = item.total || "—";
        
        message += `\n${idx + 1}. ${name}\n`;
        message += `   💰 ${pricePerUnit} × ${quantity} = ${total}`;
      });
      message += `\n`;
    }
    
    // Сума
    if (od.total) {
      message += `\n*💰 Всього: ${od.total}*\n`;
    }
    
    message += `\n🌐 [Див. замовлення](${payload.url})`;
  } else {
    message = `📌 *${payload.event || "подія"}*\n\`\`\`\n${JSON.stringify(payload, null, 2).substring(0, 300)}\n\`\`\``;
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
