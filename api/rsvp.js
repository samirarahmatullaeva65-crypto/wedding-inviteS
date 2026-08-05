/**
 * POST /api/rsvp
 *
 * Принимает ответ гостя со страницы приглашения и отправляет его
 * в личный чат Telegram через Bot API.
 *
 * Переменные окружения (задаются в Vercel → Settings → Environment Variables):
 *   BOT_TOKEN — токен бота из @BotFather
 *   CHAT_ID   — id чата, куда приходят уведомления
 */

const TELEGRAM_API = 'https://api.telegram.org';
const TIMEZONE = 'Asia/Tashkent';

/* ---------- ограничение частоты запросов (защита от спама) ---------- */
const RATE_LIMIT_MAX = 5; // запросов
const RATE_LIMIT_WINDOW = 60 * 1000; // за минуту
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW);
  list.push(now);
  hits.set(ip, list);

  // чистим устаревшие записи, чтобы Map не рос бесконечно
  if (hits.size > 500) {
    for (const [key, value] of hits) {
      if (!value.length || now - value[value.length - 1] > RATE_LIMIT_WINDOW) hits.delete(key);
    }
  }
  return list.length > RATE_LIMIT_MAX;
}

/* ---------- вспомогательные функции ---------- */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isValidName(value) {
  return /^[\p{L}][\p{L}\s'’-]{1,39}$/u.test(value);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded.length) return String(forwarded[0]).trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function formatDateTime() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
  return { date, time };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }

  // запасной путь: читаем поток вручную
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildMessage(data) {
  const { date, time } = formatDateTime();
  const fullName = escapeHtml(`${data.firstName} ${data.lastName}`);
  const userAgent = escapeHtml(data.userAgent || '—');

  const telegramLine = data.telegram
    ? `\n\n🔗 <b>Telegram:</b>\n${escapeHtml(
        data.telegram.username ? '@' + data.telegram.username : data.telegram.name || data.telegram.id
      )}`
    : '';

  if (data.answer === 'yes') {
    return (
      '💍 <b>Новое подтверждение</b>\n\n' +
      `👤 <b>Имя:</b>\n${fullName}\n\n` +
      `👥 <b>Количество гостей:</b>\n${data.guests}\n\n` +
      '✅ <b>Ответ:</b>\nПриду\n\n' +
      `💬 <b>Комментарий:</b>\n${escapeHtml(data.comment || '—')}\n\n` +
      `🌐 <b>User Agent:</b>\n${userAgent}\n\n` +
      `📅 <b>Дата:</b>\n${date}\n\n` +
      `🕒 <b>Время:</b>\n${time}` +
      telegramLine
    );
  }

  return (
    '💍 <b>Новый ответ</b>\n\n' +
    `👤 <b>Имя:</b>\n${fullName}\n\n` +
    '❌ <b>Ответ:</b>\nНе приду\n\n' +
    (data.comment ? `💬 <b>Комментарий:</b>\n${escapeHtml(data.comment)}\n\n` : '') +
    `🌐 <b>User Agent:</b>\n${userAgent}\n\n` +
    `📅 <b>Дата:</b>\n${date}\n\n` +
    `🕒 <b>Время:</b>\n${time}` +
    telegramLine
  );
}

async function sendToTelegram(token, chatId, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram responded with ${response.status}`);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- обработчик ---------- */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.BOT_TOKEN;
  const chatId = process.env.CHAT_ID;

  if (!token || !chatId) {
    console.error('RSVP: BOT_TOKEN или CHAT_ID не заданы в переменных окружения');
    return res.status(500).json({ ok: false, error: 'Server is not configured' });
  }

  if (rateLimited(getClientIp(req))) {
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  const firstName = cleanText(body.firstName, 40);
  const lastName = cleanText(body.lastName, 40);
  const answer = body.answer === 'yes' ? 'yes' : body.answer === 'no' ? 'no' : null;
  const comment = cleanText(body.comment, 500);
  const userAgent = cleanText(body.userAgent || req.headers['user-agent'], 300);

  let guests = Number.parseInt(body.guests, 10);
  if (!Number.isFinite(guests) || guests < 1) guests = 1;
  if (guests > 10) guests = 10;

  if (!answer) return res.status(400).json({ ok: false, error: 'Field "answer" must be "yes" or "no"' });
  if (!isValidName(firstName)) return res.status(400).json({ ok: false, error: 'Invalid first name' });
  if (!isValidName(lastName)) return res.status(400).json({ ok: false, error: 'Invalid last name' });

  let telegram = null;
  if (body.telegram && typeof body.telegram === 'object') {
    telegram = {
      id: Number.isFinite(Number(body.telegram.id)) ? Number(body.telegram.id) : null,
      username: cleanText(body.telegram.username, 40) || null,
      name: cleanText(body.telegram.name, 80) || null
    };
    if (!telegram.id && !telegram.username && !telegram.name) telegram = null;
  }

  const message = buildMessage({
    firstName,
    lastName,
    answer,
    guests: answer === 'yes' ? guests : 1,
    comment,
    userAgent,
    telegram
  });

  try {
    await sendToTelegram(token, chatId, message);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('RSVP: ошибка отправки в Telegram —', error && error.message ? error.message : error);
    return res.status(502).json({ ok: false, error: 'Telegram is unavailable' });
  }
}
