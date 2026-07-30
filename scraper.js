const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

puppeteer.use(StealthPlugin());

const INBOX_URL = 'https://ads.google.com/aw/servicemads/inbox';
const USER_DATA_DIR = '/home/yasin2celik/mustafa-reklam/user_data';
const CHROME_BINARY = '/usr/bin/google-chrome';
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

(async () => {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log(`[${new Date().toLocaleString()}] ℹ️ INFO: LSA Paneline bağlanılıyor...`);

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

    console.log("ℹ️ Sayfa yükleniyor...");
    // Frame kopmalarını önlemek için sadece temel DOM yüklenmesini bekliyoruz
    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Yönlendirmelerin ve panelin tamamen oturması için sabit bekleme (12 saniye)
    console.log("ℹ️ Panelin oturması bekleniyor...");
    await new Promise(r => setTimeout(r, 12000));

    console.log("ℹ️ 'Herunterladen' butonu taranıyor...");

    // Doğrudan ana sayfa context'inde çalıştırıyoruz (Frame takibi yok)
    const downloadSuccess = await page.evaluate(() => {
      let btn = document.querySelector('div[role="button"][jsname="I5dMCd"]');
      
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
      console.log("✅ 'Herunterladen' butonuna tıklandı! Dosya indiriliyor...");
      await new Promise(r => setTimeout(r, 6000));
    } else {
      console.warn("⚠️ Buton bulunamadı, ekran görüntüsü kaydediliyor...");
      await page.screenshot({ path: 'debug_page.png', fullPage: true });
      throw new Error("Download button not found in DOM");
    }

    // CSV İşleme
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
        console.log(`✅ CSV okundu. Toplam Kayıt: ${results.length}`);
        fs.writeFileSync(path.resolve(__dirname, 'data.json'), JSON.stringify(results, null, 2));
        console.log("💾 data.json güncellendi.");
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
