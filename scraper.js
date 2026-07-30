require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ==========================================
// AYARLAR (DEBUG VE TEST)
// ==========================================
const SKIP_TELEGRAM = true;  // Telegram Kapalı
const SKIP_GIT_PUSH = true;  // Git Push Kapalı

const CONFIG = {
  projectName: 'Mustafa Reklam',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID',
  dataFilePath: path.join(__dirname, 'data.json'),
  userDataPath: '/home/yasin2celik/mustafa-reklam/user_data',
  lockFilePath: path.join(__dirname, 'bot.lock'),
  targetUrl: 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  executablePath: '/usr/bin/google-chrome'
};

function writeLog(msg, isError = false) {
  const timestamp = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  const formattedMsg = `[${timestamp}] ${isError ? '❌ ERROR: ' : 'ℹ️ INFO: '}${msg}`;
  if (isError) console.error(formattedMsg);
  else console.log(formattedMsg);
}

function clearChromeLocks() {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
  locks.forEach(lock => {
    const lockPath = path.join(CONFIG.userDataPath, lock);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  });
}

function extractLeadsFromRpc(rawText) {
  const leads = [];
  try {
    const unescaped = rawText.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const blockRegex = /(?:\["([a-z_]+)",\["de","([^"]+)"\]\]|\[null,"([^"]+ Dienst)","xcat:[^"]+"\])[\s\S]*?,(\d{16})/g;

    let match;
    const seenTimestamps = new Set();

    while ((match = blockRegex.exec(unescaped)) !== null) {
      const specificService = match[2];
      const fallbackCategory = match[3];
      const timestampMicro = match[4];

      if (seenTimestamps.has(timestampMicro)) continue;
      seenTimestamps.add(timestampMicro);

      const serviceName = specificService || fallbackCategory || 'Umzugsdienst';
      const ms = Math.floor(parseInt(timestampMicro, 10) / 1000);
      const formattedDate = !isNaN(ms) 
        ? new Date(ms).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })
        : new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });

      leads.push({
        id: `lsa_${timestampMicro}`,
        anfrageId: timestampMicro,
        Hizmet: serviceName,
        Tarih: formattedDate
      });
    }
  } catch (err) {
    writeLog(`RPC Parsing hatası: ${err.message}`, true);
  }
  return leads;
}

async function runDebugScraper() {
  if (fs.existsSync(CONFIG.lockFilePath)) {
    try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
  }

  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());
  let browser;
  let rpcCount = 0;

  try {
    clearChromeLocks();

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: CONFIG.executablePath,
      userDataDir: CONFIG.userDataPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--lang=de-AT,de'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // 1. GİDEN İSTEKLERİ İZLE
    page.on('request', request => {
      const url = request.url();
      if (url.includes('batchexecute')) {
        const rpcMatch = url.match(/rpcids=([^&]+)/);
        const rpcIds = rpcMatch ? rpcMatch[1] : 'Bilinmeyen_RPC';
        writeLog(`➡️ [RPC ISTEK] ID'ler: ${rpcIds}`);
      }
    });

    // 2. GELEN YANITLARI YAKALA VE LOGLA
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('batchexecute')) {
        rpcCount++;
        try {
          const text = await response.text();
          const rpcMatch = url.match(/rpcids=([^&]+)/);
          const rpcIds = rpcMatch ? rpcMatch[1] : `rpc_${rpcCount}`;
          
          writeLog(`⬅️ [RPC YANIT] ID: ${rpcIds} | Boyut: ${text.length} Byte`);

          // Her RPC yanıtını ayrı log dosyasına kaydet
          const logFileName = `debug_rpc_${rpcIds}_${Date.now()}.log`;
          fs.writeFileSync(path.join(__dirname, logFileName), text, 'utf8');
          writeLog(`   📁 Ham Yanıt Kaydedildi: ${logFileName}`);

          // Eğer DiUHNe ise lead çıkarımını da dene
          if (rpcIds.includes('DiUHNe')) {
            const leads = extractLeadsFromRpc(text);
            writeLog(`   🔎 'DiUHNe' içerisinden ${leads.length} adet lead ayıklandı.`);
          }
        } catch (e) {
          writeLog(`RPC Okuma Hatası: ${e.message}`, true);
        }
      }
    });

    writeLog("🚀 LSA Inbox yükleniyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    writeLog(`Sayfa Başlığı: "${pageTitle}"`);

    writeLog("⏳ Ekstra ağ istekleri için 5 saniye bekleniyor...");
    await new Promise(r => setTimeout(r, 5000));

  } catch (err) {
    writeLog(`Hata: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) {
      try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
    }
    writeLog("🏁 Debug taraması tamamlandı.");
  }
}

runDebugScraper();
