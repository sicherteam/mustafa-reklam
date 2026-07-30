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
  userDataDir: path.join(__dirname, '.chrome_user_data'),
  downloadPath: path.join(__dirname, 'downloads'),
  lockFilePath: path.join(__dirname, 'bot.lock'),
  lsaUrl: 'https://ads.google.com/localservices/leads'
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

// ==========================================
// 3. TELEGRAM BİLDİRİM
// ==========================================
async function sendTelegramMessage(lead, retries = 3) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    writeLog("Telegram token/chatId eksik!", true);
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

    browser = await puppeteer.launch({
      headless: 'new',
      userDataDir: CONFIG.userDataDir,
      defaultViewport: { width: 1920, height: 1080 },
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: CONFIG.downloadPath
    });

    writeLog("LSA Paneline gidiliyor...");
    await page.goto(CONFIG.lsaUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    writeLog("CSV indirme tetikleniyor...");
    const downloadBtn = await page.waitForSelector('button[aria-label*="Herunterladen"], button:has-text("HERUNTERLADEN")', { timeout: 15000 }).catch(() => null);
    
    if (downloadBtn) {
      await downloadBtn.click();
      await new Promise(r => setTimeout(r, 4000));
    }

    const files = fs.readdirSync(CONFIG.downloadPath).filter(f => f.endsWith('.csv'));
    if (files.length === 0) {
      writeLog("İndirilen CSV dosyası bulunamadı!", true);
      return;
    }
    
    files.sort((a, b) => fs.statSync(path.join(CONFIG.downloadPath, b)).mtime - fs.statSync(path.join(CONFIG.downloadPath, a)).mtime);
    const latestCsvPath = path.join(CONFIG.downloadPath, files[0]);

    const rawRows = [];
    await new Promise((resolve) => {
      fs.createReadStream(latestCsvPath)
        .pipe(csvParser())
        .on('data', (row) => rawRows.push(row))
        .on('end', resolve);
    });

    const db = loadDatabase();
    const existingIds = new Set(db.leads.map(l => l.id));

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
        const clicked = await clickLeadByAnfrageId(page, anfrageId);
        
        if (clicked) {
          await new Promise(r => setTimeout(r, 1500));
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

    fs.unlinkSync(latestCsvPath);

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
