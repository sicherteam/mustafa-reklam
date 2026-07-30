require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ==========================================
// AYARLAR
// ==========================================
const SKIP_TELEGRAM = false; // Telegram bildirimleri AKTİF
const SKIP_GIT_PUSH = false; // Git sync AKTİF

const CONFIG = {
  projectName: 'Mustafa Reklam - LSA',
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

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadDatabase() {
  if (!fs.existsSync(CONFIG.dataFilePath)) {
    return { updatedAt: new Date().toISOString(), leads: [] };
  }
  try {
    const content = fs.readFileSync(CONFIG.dataFilePath, 'utf8').trim();
    if (!content) return { updatedAt: new Date().toISOString(), leads: [] };
    return JSON.parse(content);
  } catch (err) {
    writeLog(`data.json okunurken hata alındı, yeni şablon oluşturuluyor: ${err.message}`, true);
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
  if (SKIP_GIT_PUSH) return;
  try {
    writeLog("Git senkronizasyonu başlatılıyor...");
    execSync('git add data.json', { cwd: __dirname });
    execSync('git commit -m "auto: update LSA lead details (phones/emails) [skip ci]"', { cwd: __dirname });
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
// PARSER (GELEN RPC YANITINI COZUMLEME)
// ==========================================
function parseDiUHNePayload(rawText) {
  const leads = [];
  try {
    // 1. JSON sarmalından kurtul
    let cleanJsonStr = rawText;
    if (rawText.startsWith(")]}'\n")) {
      cleanJsonStr = rawText.substring(5);
    }

    const outerParsed = JSON.parse(cleanJsonStr);
    
    // Google RPC formatı: [["wrb.fr", "DiUHNe", "PAYLOAD_STRING", ...]]
    const innerPayloadStr = outerParsed[0][2];
    const data = JSON.parse(innerPayloadStr);

    // Lead listesi data[1] altındaki dizidedir
    const leadItems = data[1] || [];

    for (const item of leadItems) {
      if (!Array.isArray(item) || item.length < 2) continue;

      const meta = item[0] || [];
      const contact = item[1] || [];

      const leadId = meta[0] || `lsa_${Date.now()}`;
      const timestampMicro = meta[10] || meta[11] || Date.now() * 1000;
      
      // Hizmet Adını Al
      let serviceName = "Umzugsdienst";
      if (meta[5] && meta[5][6] && meta[5][6][1] && meta[5][6][1][1]) {
        serviceName = meta[5][6][1][1];
      } else if (meta[5] && meta[5][7] && meta[5][7][1]) {
        serviceName = meta[5][7][1];
      }

      // Müşteri Detaylarını Al
      const realPhone = contact[3] || "-";
      const email = contact[7] || "-";
      const city = (contact[8] && contact[8][1]) ? contact[8][1] : "Wien / Österreich";
      const googleForwardPhone = meta[21] || "-";

      // Tarih Hesapla
      const ms = Math.floor(parseInt(timestampMicro, 10) / 1000);
      const formattedDate = !isNaN(ms) 
        ? new Date(ms).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })
        : new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });

      // Müşteri İsmi (Email'den veya varsayılan)
      let customerName = "Google LSA Müşterisi";
      if (email !== "-") {
        customerName = email.split('@')[0].replace(/[._]/g, ' ');
        customerName = customerName.charAt(0).toUpperCase() + customerName.slice(1);
      }

      leads.push({
        id: `lsa_${leadId}`,
        anfrageId: leadId,
        Musteri: customerName,
        Telefon: realPhone,
        Email: email,
        GoogleForwardTel: googleForwardPhone,
        Hizmet: serviceName,
        Konum: city,
        Tarih: formattedDate,
        Mesaj: `LSA Lead ID: ${leadId}`
      });
    }

    writeLog(`🔎 DiUHNe üzerinden ${leads.length} adet FULL DETAYLI lead başarıyla çıkarıldı.`);
  } catch (err) {
    writeLog(`Payload Parse Hatası: ${err.message}`, true);
  }
  return leads;
}

async function sendTelegramMessage(lead, retries = 3) {
  if (SKIP_TELEGRAM) return true;

  if (!CONFIG.telegramToken || !CONFIG.telegramChatId || CONFIG.telegramToken === 'YOUR_TELEGRAM_BOT_TOKEN') {
    writeLog("Telegram konfigürasyonu eksik!", true);
    return false;
  }

  const message = `🔔 <b>YENİ LSA TALEBİ!</b> (${escapeHTML(CONFIG.projectName)})\n\n` +
                  `👤 <b>Müşteri:</b> ${escapeHTML(lead["Musteri"])}\n` +
                  `📞 <b>Telefon:</b> <code>${escapeHTML(lead["Telefon"])}</code>\n` +
                  `📧 <b>E-Mail:</b> ${escapeHTML(lead["Email"])}\n` +
                  `📍 <b>Konum:</b> ${escapeHTML(lead["Konum"])}\n` +
                  `💼 <b>Hizmet:</b> ${escapeHTML(lead["Hizmet"])}\n` +
                  `📅 <b>Tarih:</b> ${escapeHTML(lead["Tarih"])}\n` +
                  `🆔 <b>ID:</b> ${escapeHTML(lead["anfrageId"])}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CONFIG.telegramChatId, text: message, parse_mode: 'HTML' })
      });
      if (res.ok) return true;
      if (res.status === 429) await new Promise(r => setTimeout(r, 3500 * attempt));
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

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
        '--lang=de-AT,de'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('batchexecute') && url.includes('DiUHNe')) {
        try {
          rawRpcPayload = await response.text();
          writeLog("🎯 DiUHNe API yanıtı başarıyla yakalandı.");
        } catch (_) {}
      }
    });

    writeLog("🚀 LSA Inbox yükleniyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    if (!rawRpcPayload) {
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!rawRpcPayload) {
      throw new Error("❌ 'DiUHNe' RPC yanıtı yakalanamadı!");
    }

    const fetchedLeads = parseDiUHNePayload(rawRpcPayload);
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
    }

    if (newLeadsAdded) {
      saveDatabaseSafe(db);
      writeLog(`✅ Veritabanı güncellendi. Toplam lead: ${db.leads.length}`);
      syncToGit();
    } else {
      writeLog("ℹ️ Yeni lead yok. Veritabanı güncel.");
    }

  } catch (err) {
    writeLog(`Hata oluştu: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) {
      try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
    }
    writeLog("🏁 İşlem tamamlandı.");
  }
}

runLsaCollector();
