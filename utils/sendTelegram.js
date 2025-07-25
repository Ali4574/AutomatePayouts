import dotenv from 'dotenv';
import fetch from 'node-fetch';
dotenv.config({
    path: '../.env',
});

export async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  if (!token || !chatId) {
    console.error('❌ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables');
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('❌ Telegram API error:', errText);
    } else {
      console.log('📩 Telegram alert sent.');
    }
  } catch (err) {
    console.error('❌ Telegram request failed:', err.message);
  }
}
