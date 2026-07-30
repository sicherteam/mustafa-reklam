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
  userDataDir: '/home/yasin2celik/mustafa-reklam/user_data',
  downloadPath: path.join(__dirname, 'downloads'),
  lockFilePath: path.join(__dirname, 'bot.lock'),
  // 🔹 DÜZELTME: Çalışan tam inbox URL'si ile değiştirildi
  lsaUrl: 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  // 🔹 DÜZELTME: Sistem chrome yolu stabiliteyi artırır
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
// 2. YARDIMCI FONKSİYONLAR
// ==========================================
function writeLog(msg, isError = false) {
  const timestamp = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  console.log(`[${timestamp}] ${isError ? '❌ ERROR: ' : 'ℹ️ INFO: '}${msg}`);
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
    const month = GERMAN_MONTHS[match[2].toLowerCase()] || '01';
    const year = match[3].slice(-2);
    const time = match[4] ? ` ${match[4].padStart(2, '0')}:${match[5]}` : '';
    return `${day}.${month}.${year}${time}`;
  }
  return clean;
}

function loadDatabase() {
  if (!fs.existsSync(CONFIG.dataFilePath)) return { leads: [] };
  try { return JSON.parse(fs.readFileSync(CONFIG.dataFilePath, 'utf8')); } 
  catch (e) { return { leads: [] }; }
}

function saveDatabaseSafe(data) {
  data.updatedAt = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  fs.writeFileSync(CONFIG.dataFilePath, JSON.stringify(data, null, 2));
}

function syncToGit() {
  try {
    execSync('git add data.json && git commit -m "update leads" && git push', { cwd: __dirname });
    writeLog("✅ Git Sync başarılı.");
  } catch (e) { writeLog("Git sync atlandı (değişiklik yok)."); }
}

// ==========================================
// 3. MAIN ENGINE
// ==========================================
async function runLsaCollector() {
  if (fs.existsSync(CONFIG.lockFilePath)) return;
  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());

  let browser;
  try {
    if (!fs.existsSync(CONFIG.downloadPath)) fs.mkdirSync(CONFIG.downloadPath, { recursive: true });

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: CONFIG.executablePath,
      userDataDir: CONFIG.userDataDir,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: CONFIG.downloadPath });

    writeLog("LSA Paneline bağlanılıyor...");
    await page.goto(CONFIG.lsaUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // İndirme işlemini tetikle
    const downloadBtn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('HERUNTERLADEN')));
    if (downloadBtn) { await downloadBtn.click(); await new Promise(r => setTimeout(r, 4000)); }

    const files = fs.readdirSync(CONFIG.downloadPath).filter(f => f.endsWith('.csv'));
    files.sort((a, b) => fs.statSync(path.join(CONFIG.downloadPath, b)).mtime - fs.statSync(path.join(CONFIG.downloadPath, a)).mtime);
    
    const csvPath = path.join(CONFIG.downloadPath, files[0]);
    const rawRows = [];
    await new Promise(res => fs.createReadStream(csvPath).pipe(csvParser()).on('data', r => rawRows.push(r)).on('end', res));

    const db = loadDatabase();
    const existingIds = new Set(db.leads.map(l => l.id));

    for (const row of rawRows) {
      const anfrageId = safeStr(row['Anfrage-ID'] || row['ID']);
      const leadId = anfrageId ? `lsa_${anfrageId}` : crypto.createHash('md5').update(`${row['Kunde']}_${row['Anfrage erhalten']}`).digest('hex');
      
      if (existingIds.has(leadId)) continue;

      let msg = safeStr(row['Art der Anfrage']);
      if (/SMS|Nachricht/i.test(msg) && anfrageId) {
        // Müşteri satırını tıkla
        await page.evaluate((id) => {
          const row = Array.from(document.querySelectorAll('tr')).find(r => r.innerText.includes(id));
          if(row) row.click();
        }, anfrageId);
        await new Promise(r => setTimeout(r, 2000));
        
        // Mesajı çek
        msg = await page.evaluate(() => document.querySelector('[class*="Unterhaltung"]')?.innerText || 'Mesaj okunamadı');
        
        // Listeye dön
        await page.evaluate(() => document.querySelector('button[aria-label*="Zurück"]')?.click() || window.history.back());
        await new Promise(r => setTimeout(r, 1000));
      }

      const newLead = { id: leadId, Musteri: row['Kunde'], Mesaj: msg, Tarih: parseCsvDate(row['Anfrage erhalten']) };
      db.leads.push(newLead);
      saveDatabaseSafe(db);
    }

    syncToGit();
    fs.unlinkSync(csvPath);
  } catch (err) {
    writeLog(`Hata: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) fs.unlinkSync(CONFIG.lockFilePath);
  }
}

runLsaCollector();
