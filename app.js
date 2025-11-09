const express = require("express");
const app = express();

const SECRET = process.env.SECRET || "default-secret";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

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
  res.json({ status: "ok", message: "Telegram webhook сервер працює" });
});

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
    
    // Товари
    if (od.items && od.items.length > 0) {
      message += `\n*🛍️  Товари:*\n`;
      od.items.forEach((item, idx) => {
        const name = (item.name || "Товар").substring(0, 60);
        const price = item.price || "—";
        message += `  ${idx + 1}. ${name}\n     ${price}\n`;
      });
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
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown"
        })
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("❌ Telegram помилка:", error);
      return res.status(500).json({ error: "Telegram failed" });
    }

    console.log("✅ Відправлено в Telegram");
    res.json({ ok: true });
  } catch (error) {
    console.error("💥 Помилка:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Запущено на ${PORT}`);
});