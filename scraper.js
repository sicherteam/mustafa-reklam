const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// Doğrudan verdiğin URL
const INBOX_URL = 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT';
const USER_DATA_DIR = '/home/yasin2celik/mustafa-reklam/user_data';
const CHROME_BINARY = '/usr/bin/google-chrome';
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

(async () => {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log(`[${new Date().toLocaleString()}] ℹ️ INFO: Doğrudan LSA Inbox paneline gidiliyor...`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_BINARY,
    userDataDir: USER_DATA_DIR,
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--no-first-run',
      '--no-service-autorun',
      '--password-store=basic'
    ]
  });

  const page = await browser.newPage();

  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    // Sayfa yükleme isteği
    console.log("ℹ️ Sayfa açılıyor...");
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Açılır açılmaz panelin öğelerini render etmesi için kısa bekleme
    console.log("ℹ️ Elementlerin yüklenmesi bekleniyor...");
    await new Promise(r => setTimeout(r, 8000));

    console.log("ℹ️ 'Herunterladen' butonu aranıyor ve tıklanıyor...");

    const downloadSuccess = await page.evaluate(() => {
      // 1. Öncelik: Tam jsname ve role eşleşmesi
      let btn = document.querySelector('div[role="button"][jsname="I5dMCd"]');
      
      // 2. Öncelik: Herunterladen içeren herhangi bir buton elementi
      if (!btn) {
        const allElements = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
        btn = allElements.find(el => {
          const txt = (el.textContent || el.innerText || '').trim();
          return txt.includes('Herunterladen') || txt.includes('HERUNTERLADEN') || txt.includes('Download');
        });
      }

      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (downloadSuccess) {
      console.log("✅ 'Herunterladen' butonuna basıldı. Dosya indiriliyor...");
      await new Promise(r => setTimeout(r, 6000));
    } else {
      console.warn("⚠️ Buton bulunamadı, ekran görüntüsü kaydediliyor (debug_page.png)...");
      await page.screenshot({ path: 'debug_page.png', fullPage: true });
      throw new Error("Download button not found in DOM");
    }

    // İndirilen CSV dosyasını okuma
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.csv'));
    if (files.length === 0) {
      throw new Error("Klasörde işlenecek CSV dosyası bulunamadı!");
    }

    const latestFile = files.map(f => ({
      name: f,
      time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime.getTime()
    })).sort((a, b) => b.time - a.time)[0].name;

    const csvFilePath = path.join(DOWNLOAD_DIR, latestFile);
    console.log(`📄 İşlenen Dosya: ${csvFilePath}`);

    const results = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        console.log(`✅ CSV başarıyla işlendi. Toplam Kayıt: ${results.length}`);
        fs.writeFileSync(path.resolve(__dirname, 'data.json'), JSON.stringify(results, null, 2));
        console.log("💾 data.json dosyası güncellendi.");
        await browser.close();
        process.exit(0);
      });

  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] ❌ ERROR: Hata: ${error.message}`);
    await page.screenshot({ path: 'error_state.png', fullPage: true }).catch(() => {});
    await browser.close();
    process.exit(1);
  }
})();
