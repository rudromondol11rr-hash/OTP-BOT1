const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const BOT_TOKEN = '9100726768:AAFIPksNHSbJw6PluOebpFN3nJpUOruUKJA';
const IPRN_API_TOKEN = '559486|0uM6fxwjlMETjoaN9C0p9Fh9FB01ZVoBOVWGReKg17ccd457';
const GROUP_ID = '-1003930981242';
const CHECK_INTERVAL_MS = 2500;
const EDR_API_URL = 'https://api.iprn.pro/api/stock/public/edr?page=1&perPage=15';
const STATS_FILE = './sms_stats.json';

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 300000 });

const seenSignatures = new Set();
let isInitialSyncDone = false;
let isChecking = false;

const refreshOnlyButton = Markup.inlineKeyboard([
  [Markup.button.callback('🔄 Refresh', 'REFRESH_SMS')]
]);

bot.catch((err) => {
  console.error('Bot Global Error:', err.message);
});

const apiClient = axios.create({
  timeout: 12000,
  headers: {
    'Authorization': `Bearer ${IPRN_API_TOKEN}`,
    'Accept': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'User-Agent': 'Mozilla/5.0'
  }
});

function maskPhoneNumber(rawNumber) {
  if (!rawNumber || rawNumber === 'N/A') return '+Unknown';
  const digits = String(rawNumber).replace(/\D/g, '');
  if (digits.length <= 6) return `+${digits}`;
  const firstTwo = digits.slice(0, 2);
  const lastFour = digits.slice(-4);
  const stars = '*'.repeat(digits.length - 6);
  return `+${firstTwo}${stars}${lastFour}`;
}

function getCountryFlag(destText, digits) {
  const cleanDest = destText ? destText.replace(/\d+/g, '').trim() : '';
  if (/china/i.test(cleanDest) || digits.startsWith('86')) return `${cleanDest || 'China'} 🇨🇳`;
  if (/usa|united states/i.test(cleanDest) || digits.startsWith('1')) return `${cleanDest || 'USA'} 🇺🇸`;
  if (/uk|united kingdom/i.test(cleanDest) || digits.startsWith('44')) return `${cleanDest || 'UK'} 🇬🇧`;
  if (/bangladesh/i.test(cleanDest) || digits.startsWith('880')) return `${cleanDest || 'Bangladesh'} 🇧🇩`;
  if (/india/i.test(cleanDest) || digits.startsWith('91')) return `${cleanDest || 'India'} 🇮🇳`;
  if (/russia/i.test(cleanDest) || digits.startsWith('7')) return `${cleanDest || 'Russia'} 🇷🇺`;
  if (/indonesia/i.test(cleanDest) || digits.startsWith('62')) return `${cleanDest || 'Indonesia'} 🇮🇩`;
  if (/vietnam/i.test(cleanDest) || digits.startsWith('84')) return `${cleanDest || 'Vietnam'} 🇻🇳`;
  if (/bulgaria/i.test(cleanDest) || digits.startsWith('359')) return `${cleanDest || 'Bulgaria'} 🇧🇬`;
  if (/monaco/i.test(cleanDest) || digits.startsWith('377')) return `${cleanDest || 'Monaco'} 🇲🇨`;
  return cleanDest ? `${cleanDest} 🌍` : 'Unknown 🌍';
}

function updateSmsStats() {
  const todayStr = new Date().toISOString().split('T')[0];
  let stats = { date: todayStr, todayCount: 0, lifetimeCount: 0 };

  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      stats.lifetimeCount = saved.lifetimeCount || 0;
      if (saved.date === todayStr) {
        stats.todayCount = saved.todayCount || 0;
      }
    }
  } catch (e) {}

  stats.todayCount += 1;
  stats.lifetimeCount += 1;

  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {}

  return stats;
}

function parseSmsItem(item) {
  const number = String(item.b_number || 'N/A').trim();
  const message = String(item.message || 'N/A').trim();
  const service = String(item.a_number || 'Unknown').trim();
  const destination = String(item.destination || '').trim();
  const timeStr = String(item.created_at || new Date().toISOString()).trim();

  const signature = `${timeStr}|${number}|${message}`;

  return {
    signature,
    number,
    message,
    service,
    destination,
    timeStr
  };
}

async function checkAndSendNewSms(isManual = false) {
  if (isChecking) return 0;
  isChecking = true;
  let newSentCount = 0;

  try {
    const res = await apiClient.get(`${EDR_API_URL}&_t=${Date.now()}`);
    const records = Array.isArray(res.data?.data) ? res.data.data : [];

    if (!isInitialSyncDone) {
      records.forEach((raw) => {
        const parsed = parseSmsItem(raw);
        seenSignatures.add(parsed.signature);
      });
      isInitialSyncDone = true;
      console.log(`Initial sync complete. Tracking ${records.length} existing records.`);
      return 0;
    }

    const freshRecords = [];
    for (const raw of records) {
      const parsed = parseSmsItem(raw);
      if (!seenSignatures.has(parsed.signature)) {
        seenSignatures.add(parsed.signature);
        freshRecords.push(parsed);
      }
    }

    if (seenSignatures.size > 500) {
      const arr = Array.from(seenSignatures);
      seenSignatures.clear();
      arr.slice(-250).forEach((s) => seenSignatures.add(s));
    }

    for (const record of freshRecords.reverse()) {
      const otpMatch = record.message.match(/\b\d{4,8}\b/);
      const otpCode = otpMatch ? otpMatch[0] : (record.message || 'N/A');

      const digits = record.number.replace(/\D/g, '');
      const maskedNumber = maskPhoneNumber(record.number);
      const country = getCountryFlag(record.destination, digits);
      const stats = updateSmsStats();

      const formattedMessage =
        `🔔 *OTP Received*\n\n` +
        `⏰ *Time:* ${record.timeStr}\n` +
        `📱 *Service:* ${record.service}\n` +
        `🌍 *Country:* ${country}\n` +
        `☎ *Number:* \`${maskedNumber}\`\n` +
        `🔑 *Your OTP:* \`${otpCode}\`\n` +
        `💬 *Message:* ${record.message}\n` +
        `📊 *Today's SMS:* ${stats.todayCount}\n` +
        `📈 *Lifetime SMS:* ${stats.lifetimeCount}`;

      await bot.telegram.sendMessage(GROUP_ID, formattedMessage, {
        parse_mode: 'Markdown',
        ...refreshOnlyButton
      });
      newSentCount += 1;
    }

    return newSentCount;
  } catch (err) {
    const status = err.response?.status;
    console.error('API Fetch Error:', status || err.message);
    if (isManual) {
      throw new Error(status === 401 ? 'API টোকেন অবৈধ বা মেয়াদোত্তীর্ণ!' : err.message);
    }
    return 0;
  } finally {
    isChecking = false;
  }
}

bot.command('start', async (ctx) => {
  if (String(ctx.chat.id) !== GROUP_ID) return;
  await ctx.reply(
    `✅ *বট সচল আছে!*\n⚡ ক্লাউড সার্ভার থেকে রিয়েল-টাইম OTP চেক হচ্ছে।`,
    { parse_mode: 'Markdown', ...refreshOnlyButton }
  ).catch(() => {});
});

bot.action('REFRESH_SMS', async (ctx) => {
  await ctx.answerCbQuery('🔄 নতুন OTP চেক করা হচ্ছে...').catch(() => {});
  if (String(ctx.chat.id) !== GROUP_ID) return;

  try {
    const count = await checkAndSendNewSms(true);
    if (count === 0) {
      const msg = await ctx.reply('ℹ এই মুহূর্তে নতুন কোনো OTP আসেনি।');
      setTimeout(() => bot.telegram.deleteMessage(GROUP_ID, msg.message_id).catch(() => {}), 4000);
    }
  } catch (e) {
    await ctx.reply(`❌ *সমস্যা:* ${e.message}`, { parse_mode: 'Markdown' }).catch(() => {});
  }
});

bot.launch({ dropPendingUpdates: true }).then(async () => {
  console.log('Bot started cleanly on Cloud Server...');
  try {
    await checkAndSendNewSms(false);

    await bot.telegram.sendMessage(
      GROUP_ID,
      `✅ *সিস্টেম রেডি (Cloud Server)*\n⚡ রিয়েল-টাইম OTP মনিটরিং চালু হয়েছে।`,
      { parse_mode: 'Markdown', ...refreshOnlyButton }
    );

    setInterval(() => {
      checkAndSendNewSms(false).catch(() => {});
    }, CHECK_INTERVAL_MS);
  } catch (err) {
    console.error('Startup Error:', err.message);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));

process.once('SIGTERM', () => bot.stop('SIGTERM'));
