require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ==========================================
// TEST MODU
// ==========================================
const SKIP_TELEGRAM = true;
const SKIP_GIT_PUSH = true;

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
// 3. GOOGLE RPC DECODER & INSPECTOR
// ==========================================
function extractLeadsFromRpc(rawText) {
  const leads = [];
  try {
    // Ham yanıtı debug için kaydedelim
    fs.writeFileSync(path.join(__dirname, 'debug_rpc.txt'), rawText, 'utf8');

    const cleanText = rawText.replace(/^\)\]\}'\s*/, '');
    let parsedJson = null;

    // Satır bazlı arama
    const lines = cleanText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (Array.isArray(json)) {
          parsedJson = json;
          break;
        }
      } catch (_) {}
    }

    if (!parsedJson) {
      writeLog("RPC JSON ayrıştırılamadı.", true);
      return leads;
    }

    const fullStr = JSON.stringify(parsedJson);

    // Bütün tırnak içindeki sayısal string ID'leri yakala (9-16 hane)
    const idMatches = fullStr.match(/"(\d{8,16})"/g) || [];
    const uniqueIds = [...new Set(idMatches.map(id => id.replace(/"/g, '')))];

    writeLog(`🔎 Taranan Aday ID Sayısı: ${uniqueIds.length}`);

    // Umzug / Dienst veya LSA özel kelimelerinin geçtiği yerleri süz
    for (const id of uniqueIds) {
      if (id.startsWith('178') || id.startsWith('179') || id.startsWith('180')) continue; // Zaman damgalarını ele

      // Bu ID'nin etrafında metin var mı?
      const idIdx = fullStr.indexOf(id);
      if (idIdx !== -1) {
        const snippet = fullStr.substring(Math.max(0, idIdx - 100), Math.min(fullStr.length, idIdx + 300));
        
        // Eğer snippet içinde bilinen terimler varsa lead kabul et
        if (/Umzug|Dienst|national_move|Anfrage|Mover|xcat|de-AT|Wien/i.test(snippet)) {
          
          let service = 'Umzugsdienst';
          const sMatch = snippet.match(/\["de","([^"]+)"\]/);
          if (sMatch) service = sMatch[1];

          leads.push({
            id: `lsa_${id}`,
            anfrageId: id,
            Musteri: 'Müşteri (LSA)',
            Telefon: '-',
            Hizmet: service,
            Konum: 'Wien / Österreich',
            Tarih: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
            Mesaj: `LSA Anfrage-ID: ${id}`
          });
        }
      }
    }

  } catch (err) {
    writeLog(`RPC Parsing hatası: ${err.message}`, true);
  }
  return leads;
}

// ==========================================
// 4. ANA MOTOR
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

    const fetchedLeads = extractLeadsFromRpc(rawRpcPayload);
    writeLog(`🔎 Toplam ${fetchedLeads.length} potansiyel lead ayrıştırıldı.`);

    const db = loadDatabase();
    const existingIds = new Set(db.leads.map(l => l.id));
    let newLeadsAdded = false;

    console.log("\n=================== TESPİT EDİLEN LEADLER ===================");
    for (const lead of fetchedLeads) {
      console.log(`📌 ID: ${lead.id} | Hizmet: ${lead.Hizmet} | Tarih: ${lead.Tarih}`);

      if (existingIds.has(lead.id)) continue;

      db.leads.push(lead);
      existingIds.add(lead.id);
      newLeadsAdded = true;
    }
    console.log("=============================================================\n");

    if (newLeadsAdded) {
      saveDatabaseSafe(db);
      writeLog(`✅ ${db.leads.length} adet lead 'data.json' dosyasına kaydedildi.`);
    } else {
      writeLog("ℹ️ Yeni bir lead bulunamadı.");
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
