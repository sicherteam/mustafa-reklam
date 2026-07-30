require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const csvParser = require('csv-parser');

puppeteer.use(StealthPlugin());

// ==========================================
// 1. KONTROL VE YAPILANDIRMA (CONFIG)
// ==========================================
const CONFIG = {
  projectName: 'Mustafa Reklam',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID',
  dataFilePath: path.join(__dirname, 'data.json'),
  userDataPath: '/home/yasin2celik/mustafa-reklam/user_data',
  downloadPath: path.join(__dirname, 'downloads'),
  lockFilePath: path.join(__dirname, 'bot.lock'),
  targetUrl: 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  executablePath: '/usr/bin/google-chrome'
};

const GERMAN_MONTHS = {
  'jan': '01', 'januar': '01', 'feb': '02', 'februar': '02',
  'mär': '03', 'märz': '03', 'maerz': '03', 'apr': '04', 'april': '04',
  'mai': '05', 'jun': '06', 'juni': '06', 'jul': '07', 'juli': '07',
  'aug': '08', 'august': '08', 'sep': '09', 'sept': '09', 'september': '09',
  'okt': '10', 'oktober': '10', 'nov': '11', 'november': '11', 'dez': '12', 'dezember': '12'
};

// ==========================================
// 2. YARDIMCI VE GÜVENLİK FONKSİYONLARI
// ==========================================
function writeLog(msg, isError = false) {
  const timestamp = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  const formattedMsg = `[${timestamp}] ${isError ? '❌ ERROR: ' : 'ℹ️ INFO: '}${msg}`;
  if (isError) console.error(formattedMsg);
  else console.log(formattedMsg);
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeStr(val) {
  if (val === null || val === undefined) return '';
  const strVal = String(val).trim();
  if (['null', 'undefined', 'nan'].includes(strVal.toLowerCase())) return '';
  return strVal;
}

function parseCsvDate(dateStr) {
  const clean = safeStr(dateStr);
  if (!clean || clean === '-') return '-';
  const match = clean.match(/(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const monthStr = match[2].toLowerCase();
    const month = GERMAN_MONTHS[monthStr] || '01';
    const year = match[3].slice(-2);
    const timePart = match[4] ? ` ${match[4].padStart(2, '0')}:${match[5]}` : '';
    return `${day}.${month}.${year}${timePart}`;
  }
  return clean;
}

function loadDatabase() {
  if (!fs.existsSync(CONFIG.dataFilePath)) {
    return { updatedAt: new Date().toISOString(), leads: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG.dataFilePath, 'utf8');
    return JSON.parse(raw);
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
    execSync('git commit -m "auto: update LSA leads database [skip ci]"', { cwd: __dirname });
    execSync('git push origin main', { cwd: __dirname });
    writeLog("✅ Git'e başarıyla push edildi.");
  } catch (err) {
    writeLog(`Git Sync uyarısı (Değişiklik olmayabilir): ${err.message}`, true);
  }
}

function clearChromeLocks() {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  locks.forEach(lock => {
    const lockPath = path.join(CONFIG.userDataPath, lock);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  });
}

// ==========================================
// 3. TELEGRAM BİLDİRİM
// ==========================================
async function sendTelegramMessage(lead, retries = 3) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId || CONFIG.telegramToken === 'YOUR_TELEGRAM_BOT_TOKEN') {
    writeLog("Telegram token/chatId eksik veya varsayılan değerde kalmış!", true);
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
                  `💬 <b>İletişim / Mesaj:</b> ${escapeHTML(lead["Mesaj"])}`;

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
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 3500 * attempt));
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

// ==========================================
// 4. KUSURSUZ DOM TIKLAMA (dispatchEvent)
// ==========================================
async function clickLeadByAnfrageId(page, targetAnfrageId) {
  return await page.evaluate((anfrageId) => {
    const rows = Array.from(document.querySelectorAll('tr, [role="row"]'));

    for (const row of rows) {
      if (row.innerText && row.innerText.includes(anfrageId)) {
        const targetElement = row.querySelector('td, [role="gridcell"]') || row;

        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });

        targetElement.dispatchEvent(clickEvent);
        return true;
      }
    }
    return false;
  }, targetAnfrageId);
}

// ==========================================
// 5. ANA ÇALIŞMA AKIŞI (MAIN ENGINE)
// ==========================================
async function runLsaCollector() {
  if (fs.existsSync(CONFIG.lockFilePath)) {
    writeLog("Çalışan başka bir işlem var (Lock file mevcut). İptal edildi.");
    return;
  }

  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());

  let browser;
  let hasNewLeadsAdded = false;

  try {
    if (!fs.existsSync(CONFIG.downloadPath)) fs.mkdirSync(CONFIG.downloadPath, { recursive: true });

    // Düzeltme: Dosyada kalmış olan eski .csv dosyalarını temizle
    fs.readdirSync(CONFIG.downloadPath).forEach(f => {
      if (f.endsWith('.csv')) fs.unlinkSync(path.join(CONFIG.downloadPath, f));
    });

    // 1. BÖLÜM: TARAYICI İŞLEMLERİ (Robust Initialization)
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
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-breakpad'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // 🔹 GÜNCELLEME 1: YENİ NESİL CHROME İNDİRME İZİNLERİ (Headless: "new" için tam uyum)
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: CONFIG.downloadPath
    });
    // Chrome v115+ için ek indirme yetkisi
    try {
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: CONFIG.downloadPath,
        eventsEnabled: true
      });
    } catch(e) {}

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: CONFIG.downloadPath
    });

    writeLog("🚀 LSA Inbox sayfasına gidiliyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    writeLog(`Sayfa Başlığı: ${pageTitle}`);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        window.scrollBy(0, 300);
        await new Promise(r => setTimeout(r, 200));
      }
    });

    // 🔹 GÜNCELLEME 2: GERÇEK İNSAN FARESİ SİMÜLASYONU VE KOORDİNAT TIKLAMASI
    writeLog("📥 CSV indirme butonu aranıyor ve sayfanın oturması bekleniyor...");
    await new Promise(r => setTimeout(r, 4000)); // Google'ın Event Listener'ları yüklemesi için KRİTİK bekleme
    
    let clicked = false;
    try {
      const btnSelector = 'div[role="button"][jsname="I5dMCd"]';
      await page.waitForSelector(btnSelector, { timeout: 10000 }).catch(() => null);
      const btn = await page.$(btnSelector);

      if (btn) {
        // 1. Elementi tam ekranın ortasına kaydır
        await page.evaluate(el => el.scrollIntoView({behavior: 'smooth', block: 'center'}), btn);
        await new Promise(r => setTimeout(r, 1000));

        // 2. Elementin X ve Y koordinatlarını al
        const box = await btn.boundingBox();
        if (box) {
          const x = box.x + (box.width / 2);
          const y = box.y + (box.height / 2);

          writeLog(`🖱️ Gerçek fare simülasyonu ile tıklanıyor (X: ${Math.round(x)}, Y: ${Math.round(y)})...`);
          
          // 3. İnsan gibi fareyi elementin üzerine sürükle (mouseenter tetiklenir)
          await page.mouse.move(x, y, { steps: 10 });
          await new Promise(r => setTimeout(r, 300));
          
          // 4. Sol tıkla ve basılı tut (mousedown tetiklenir)
          await page.mouse.down();
          await new Promise(r => setTimeout(r, 150)); // 150ms insani basılı tutma süresi
          
          // 5. Parmağı fareden çek (mouseup ve click tetiklenir)
          await page.mouse.up();
          clicked = true;
          writeLog("✅ Koordinat bazlı tıklama başarılı.");
        }
      }

      // Eğer koordinat bulamazsa Yedek Plan (Standart JS click)
      if (!clicked) {
        writeLog("⚠️ Yedek tıklama planına geçiliyor...");
        const buttons = await page.$$('div[role="button"]');
        for (const el of buttons) {
          const text = await page.evaluate(e => e.innerText || e.textContent || '', el);
          if (text.toUpperCase().includes('HERUNTERLADEN')) {
            await page.evaluate(e => e.click(), el);
            clicked = true;
            break;
          }
        }
      }
    } catch (e) {
      writeLog(`Tıklama mekanizması hatası: ${e.message}`, true);
    }

    if (!clicked) throw new Error("❌ 'HERUNTERLADEN' butonu bulunamadı veya tıklanamadı!");

    // CSV Dosyasının İnməsini Bekle
    writeLog("⏳ CSV dosyasının inmesi bekleniyor...");
    let downloadedFilePath = null;
    const startTime = Date.now();
    while (Date.now() - startTime < 15000) {
      const files = fs.readdirSync(CONFIG.downloadPath);
      const csvFile = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload'));
      if (csvFile) {
        downloadedFilePath = path.join(CONFIG.downloadPath, csvFile);
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!downloadedFilePath) {
      throw new Error("❌ CSV dosyası indirilemedi (zaman aşıldı).");
    }

    writeLog(`✅ CSV İndirildi: ${downloadedFilePath}. Okunuyor...`);

    // CSV Parse
    const rawRows = [];
    await new Promise((resolve) => {
      fs.createReadStream(downloadedFilePath)
        .pipe(csvParser())
        .on('data', (row) => rawRows.push(row))
        .on('end', resolve);
    });

    const db = loadDatabase();
    const existingIds = new Set(db.leads.map(l => l.id));

    // Veri İşleme ve DOM Etkileşimi
    for (const row of rawRows) {
      const anfrageId = safeStr(row['Anfrage-ID'] || row['ID']);
      const rawKunde = safeStr(row['Kunde']);
      const rawHizmet = safeStr(row['Art der Dienstleistung']);
      const location = safeStr(row['Standort']) || '-';
      const requestType = safeStr(row['Art der Anfrage']) || 'Anfrage';
      const formattedDate = parseCsvDate(row['Anfrage erhalten']);

      let customerName = 'Müşteri';
      let phone = safeStr(row['Telefonnummer'] || row['Telefon']);

      if (rawKunde) {
        if (/\d{5,}/.test(rawKunde) && (!phone || phone === '-')) {
          phone = rawKunde;
        } else if (!/\d{5,}/.test(rawKunde)) {
          customerName = rawKunde;
        }
      }

      const service = (rawHizmet && rawHizmet !== '-') ? rawHizmet : '-';
      const phoneClean = (phone && phone.length > 5) ? phone : '-';

      const leadId = anfrageId ? `lsa_${anfrageId}` : crypto.createHash('md5').update(`${customerName}_${location}_${formattedDate}`).digest('hex');

      if (existingIds.has(leadId)) continue;

      let messageText = requestType;
      const isSmsOrNachricht = /SMS|Nachricht|Text/i.test(requestType);

      if (isSmsOrNachricht && anfrageId) {
        writeLog(`Yeni mesaj tespit edildi. Anfrage-ID (${anfrageId}) tıklanıyor...`);
        const targetFound = await clickLeadByAnfrageId(page, anfrageId);
        
        if (targetFound) {
          await new Promise(r => setTimeout(r, 2000));
          const extractedMsg = await page.evaluate(() => {
            const container = document.querySelector('div[role="dialog"], [class*="Unterhaltung"], div[class*="detail"]');
            if (!container) return null;
            const text = container.innerText || '';
            const match = text.match(/Unterhaltung\n([\s\S]*)/i);
            return match ? match[1].trim() : text.trim();
          });

          if (extractedMsg) messageText = extractedMsg;

          await page.evaluate(() => {
            const backBtn = document.querySelector('button[aria-label*="Zurück"], button[aria-label*="Close"], div[role="button"][aria-label*="Zurück"]');
            if (backBtn) backBtn.click();
            else window.history.back();
          });
          await new Promise(r => setTimeout(r, 1500));
        } else {
             writeLog(`⚠️ Satır bulunamadı: ${anfrageId}`, true);
        }
      }

      const newLead = {
        id: leadId,
        Musteri: customerName,
        Telefon: phoneClean,
        Hizmet: service,
        Konum: location,
        Tarih: formattedDate,
        Mesaj: messageText,
        telegramSent: false
      };

      const sent = await sendTelegramMessage(newLead);
      newLead.telegramSent = sent;

      db.leads.push(newLead);
      existingIds.add(leadId);
      saveDatabaseSafe(db);
      hasNewLeadsAdded = true;
      writeLog(`✅ Yeni Lead Kaydedildi ve Bildirildi: ID -> ${leadId}`);
    }

    fs.unlinkSync(downloadedFilePath);

    if (hasNewLeadsAdded) {
      syncToGit();
    }

  } catch (err) {
    writeLog(`İşlem sırasında beklenmeyen hata: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) fs.unlinkSync(CONFIG.lockFilePath);
    writeLog("Döngü tamamlandı, kilit kaldırıldı.");
  }
}

runLsaCollector();
