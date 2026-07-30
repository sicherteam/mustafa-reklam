require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ==========================================
// 1. YAPILANDIRMA (CONFIG)
// ==========================================
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

// ==========================================
// 2. YARDIMCI FONKSİYONLAR
// ==========================================
function writeLog(msg, isError = false) {
  const timestamp = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  const formattedMsg = `[${timestamp}] ${isError ? '❌ ERROR: ' : 'ℹ️ INFO: '}${msg}`;
  if (isError) console.error(formattedMsg);
  else console.log(formattedMsg);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadDatabase() {
  if (!fs.existsSync(CONFIG.dataFilePath)) {
    return { updatedAt: new Date().toISOString(), leads: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG.dataFilePath, 'utf8'));
  } catch (err) {
    writeLog(`data.json okunurken hata: ${err.message}`, true);
    return { updatedAt: new Date().toISOString(), leads: [] };
  }
}

function saveDatabaseSafe(data) {
  const tempPath = `${CONFIG.dataFilePath}.tmp`;
  data.updatedAt = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, CONFIG.dataFilePath);
}

function syncToGit() {
  try {
    writeLog("Git senkronizasyonu başlatılıyor...");
    execSync('git add data.json', { cwd: __dirname });
    execSync('git commit -m "auto: update LSA leads via DiUHNe API [skip ci]"', { cwd: __dirname });
    execSync('git push origin main', { cwd: __dirname });
    writeLog("✅ Git'e başarıyla push edildi.");
  } catch (err) {
    writeLog(`Git Sync uyarısı: ${err.message}`, true);
  }
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

// ==========================================
// 3. GOOGLE RPC (DiUHNe) DATA PARSER
// ==========================================
function extractLeadsFromRpc(rawText) {
  const leads = [];
  try {
    const cleanText = rawText.replace(/^\)\]\}'\s*/, '');
    
    // JSON dizisini çözümle
    let parsedData = [];
    const lines = cleanText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (Array.isArray(json)) parsedData.push(json);
      } catch (_) {}
    }

    const fullStr = JSON.stringify(parsedData);

    // DiUHNe içindeki Lead bloklarını yakala (Anfrage ID ve metin dizilimi)
    // Google LSA, ID'leri genelde 9 haneli string sayı dizileri olarak saklar ("329076350")
    const idMatches = fullStr.match(/"(\d{9})"/g) || [];
    const uniqueIds = [...new Set(idMatches.map(id => id.replace(/"/g, '')))];

    for (const anfrageId of uniqueIds) {
      // Her ID'ye ait metin bloğunu tespit edelim
      const serviceMatch = fullStr.match(new RegExp(`"${anfrageId}"[\\s\\S]*?\\["de","([^"]+)"\\]`));
      const categoryMatch = fullStr.match(new RegExp(`"${anfrageId}"[\\s\\S]*?"([^"]+ Dienst)?"`));
      
      // Zaman damgası arayalım
      const dateMatch = fullStr.match(new RegExp(`"${anfrageId}"[\\s\\S]*?,(\\178\\d{13}|179\\d{13}|180\\d{13})`));
      let formattedDate = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
      
      if (dateMatch && dateMatch[1]) {
        const ms = Math.floor(parseInt(dateMatch[1], 10) / 1000);
        if (!isNaN(ms)) {
          formattedDate = new Date(ms).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
        }
      }

      const service = serviceMatch ? serviceMatch[1] : (categoryMatch ? categoryMatch[1] : 'Umzugsdienst');

      leads.push({
        id: `lsa_${anfrageId}`,
        anfrageId: anfrageId,
        Musteri: 'Müşteri (LSA)',
        Telefon: '-',
        Hizmet: service,
        Konum: 'Wien / Österreich',
        Tarih: formattedDate,
        Mesaj: `LSA Anfrage-ID: ${anfrageId}`
      });
    }

  } catch (err) {
    writeLog(`RPC Parsing hatası: ${err.message}`, true);
  }
  return leads;
}

// ==========================================
// 4. TELEGRAM BİLDİRİM
// ==========================================
async function sendTelegramMessage(lead, retries = 3) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId || CONFIG.telegramToken === 'YOUR_TELEGRAM_BOT_TOKEN') {
    writeLog("Telegram konfigürasyonu eksik!", true);
    return false;
  }

  const phoneStr = lead["Telefon"] && lead["Telefon"] !== '-' 
    ? `\n📞 <b>Telefon:</b> <code>${escapeHTML(lead["Telefon"])}</code>` 
    : '';

  const message = `🔔 <b>YENİ Müşteri!</b> (${escapeHTML(CONFIG.projectName)})\n\n` +
                  `👤 <b>Müşteri:</b> ${escapeHTML(lead["Musteri"])}${phoneStr}\n` +
                  `📍 <b>Konum:</b> ${escapeHTML(lead["Konum"])}\n` +
                  `💼 <b>Hizmet:</b> ${escapeHTML(lead["Hizmet"])}\n` +
                  `📅 <b>Tarih:</b> ${escapeHTML(lead["Tarih"])}\n` +
                  `💬 <b>İletişim / ID:</b> ${escapeHTML(lead["Mesaj"])}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.telegramChatId,
          text: message,
          parse_mode: 'HTML'
        })
      });

      if (res.ok) return true;
      if (res.status === 429) await new Promise(r => setTimeout(r, 3500 * attempt));
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

// ==========================================
// 5. ANA MOTOR
// ==========================================
async function runLsaCollector() {
  if (fs.existsSync(CONFIG.lockFilePath)) {
    writeLog("Çalışan başka bir işlem var (Lock file mevcut). İptal edildi.");
    return;
  }

  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());
  let browser;
  let rawRpcPayload = null;

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
        '--lang=de-AT,de',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // Network Interceptor
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('batchexecute') && url.includes('DiUHNe')) {
        try {
          rawRpcPayload = await response.text();
          writeLog("🎯 DiUHNe API yanıtı başarıyla yakalandı.");
        } catch (_) {}
      }
    });

    writeLog("🚀 LSA Inbox sayfasına gidiliyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    writeLog(`Sayfa Başlığı: "${pageTitle}"`);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    if (!rawRpcPayload) {
      writeLog("⏳ API yanıtı bekleniyor (3 saniye)...");
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!rawRpcPayload) {
      throw new Error("❌ 'DiUHNe' RPC yanıtı yakalanamadı!");
    }

    // Lead'leri Çıkar
    const fetchedLeads = extractLeadsFromRpc(rawRpcPayload);
    writeLog(`🔎 Toplam ${fetchedLeads.length} potansiyel lead ayrıştırıldı.`);

    const db = loadDatabase();
    const existingIds = new Set(db.leads.map(l => l.id));
    let newLeadsAdded = false;

    for (const lead of fetchedLeads) {
      if (existingIds.has(lead.id)) continue;

      const sent = await sendTelegramMessage(lead);
      lead.telegramSent = sent;

      db.leads.push(lead);
      existingIds.add(lead.id);
      newLeadsAdded = true;
      writeLog(`✅ Yeni Lead Eklendi ve Bildirildi: ID -> ${lead.id} (${lead.Hizmet})`);
    }

    if (newLeadsAdded) {
      saveDatabaseSafe(db);
      syncToGit();
    } else {
      writeLog("ℹ️ Yeni bir lead bulunamadı. Veritabanı güncel.");
    }

  } catch (err) {
    writeLog(`Hata oluştu: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) {
      try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
    }
    writeLog("İşlem tamamlandı, lock kaldırıldı.");
  }
}

runLsaCollector();
