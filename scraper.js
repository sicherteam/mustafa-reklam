require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const CONFIG = {
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

async function runClickDebugScraper() {
  if (fs.existsSync(CONFIG.lockFilePath)) {
    try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
  }

  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());
  let browser;

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

    // DİNLEYİCİ
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('batchexecute')) {
        try {
          const text = await response.text();
          const rpcMatch = url.match(/rpcids=([^&]+)/);
          const rpcIds = rpcMatch ? rpcMatch[1] : 'unknown';
          
          writeLog(`⬅️ [RPC YANIT] ID: ${rpcIds} | Boyut: ${text.length} Byte`);

          const logFileName = `debug_click_${rpcIds}_${Date.now()}.log`;
          fs.writeFileSync(path.join(__dirname, logFileName), text, 'utf8');
        } catch (_) {}
      }
    });

    writeLog("🚀 LSA Inbox yükleniyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    writeLog("⏳ Kart tıklaması simüle ediliyor...");
    await new Promise(r => setTimeout(r, 3000));

    // Ekrandaki ilk öğeye veya detay butonuna tıklayalım
    const clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('div, td, span, li'));
      const target = elements.find(el => el.innerText && el.innerText.includes('Umzug'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      writeLog("⚡ 'Umzug' içeren öğeye tıklandı! Yeni RPC yanıtları bekleniyor...");
    } else {
      writeLog("⚠️ Tıklanacak öğe otomatik bulunamadı, bekleniyor...");
    }

    await new Promise(r => setTimeout(r, 5000));

  } catch (err) {
    writeLog(`Hata: ${err.message}`, true);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(CONFIG.lockFilePath)) {
      try { fs.unlinkSync(CONFIG.lockFilePath); } catch (_) {}
    }
    writeLog("🏁 Tıklama testi tamamlandı.");
  }
}

runClickDebugScraper();
