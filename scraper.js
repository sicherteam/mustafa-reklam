const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');

puppeteer.use(StealthPlugin());

// --- CONFIGURATION ---
const INBOX_URL = 'https://ads.google.com/aw/servicemads/inbox'; // Kendi LSA Inbox URL'in
const USER_DATA_DIR = '/home/yasin2celik/mustafa-reklam/user_data';
const CHROME_BINARY = '/usr/bin/google-chrome';
const DOWNLOAD_DIR = path.resolve(__dirname, 'downloads');

// Telegram Bilgileri (Gerekliyse doldur/kontrol et)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('❌ Telegram mesajı gönderilemedi:', err.message);
  }
}

(async () => {
  // 1. İndirme Klasörü Hazırlığı
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
    // Puppeteer İndirme Desteğini Aktif Et (CDP)
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
    });

    // Sayfa Yükleme
    await page.goto(INBOX_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000)); // DOM tam otursun

    console.log("ℹ️ 'Herunterladen' butonu taranıyor...");

    // 2. Butona Tıklama (Görseldeki div[role="button"][jsname="I5dMCd"] yapısına özel)
    const downloadSuccess = await page.evaluate(() => {
      // Öncelik 1: Tam JSNAME ve ROLE eşleşmesi
      let btn = document.querySelector('div[role="button"][jsname="I5dMCd"]');
      
      // Öncelik 2: Genel role="button" veya button etiketleri içinde 'Herunterladen' arama
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
      console.log("✅ 'Herunterladen' butonuna tıklandı. Dosya indiriliyor...");
      await new Promise(r => setTimeout(r, 6000)); // İndirme tamamlanma süresi
    } else {
      console.warn("⚠️ 'Herunterladen' butonu bulunamadı! Ekran görüntüsü alınıyor (debug_page.png)...");
      await page.screenshot({ path: 'debug_page.png', fullPage: true });
      throw new Error("Download button not found in DOM");
    }

    // 3. İndirilen CSV Dosyasını Tespit Etme
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.csv'));

    if (files.length === 0) {
      throw new Error("Klasörde işlenecek CSV dosyası bulunamadı!");
    }

    // En güncel CSV dosyasını seç
    const latestFile = files.map(f => ({
      name: f,
      time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime.getTime()
    })).sort((a, b) => b.time - a.time)[0].name;

    const csvFilePath = path.join(DOWNLOAD_DIR, latestFile);
    console.log(`📄 İşlenen Dosya: ${csvFilePath}`);

    // 4. CSV İçeriğini Okuma ve İşleme
    const results = [];
    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        console.log(`✅ CSV başarıyla okundu. Toplam Kayıt: ${results.length}`);
        
        // Örnek: Verileri data.json dosyasına yazma
        const dataJsonPath = path.resolve(__dirname, 'data.json');
        fs.writeFileSync(dataJsonPath, JSON.stringify(results, null, 2));
        console.log("💾 Veriler data.json dosyasına kaydedildi.");

        // İşlem bitince indirilen dosyayı temizlemek istersen:
        // fs.unlinkSync(csvFilePath);

        await browser.close();
        process.exit(0);
      });

  } catch (error) {
    console.error(`[${new Date().toLocaleString()}] ❌ ERROR: Hata: ${error.message}`);
    // Hata durumunda ekran görüntüsü kaydet
    await page.screenshot({ path: 'error_state.png', fullPage: true }).catch(() => {});
    await browser.close();
    process.exit(1);
  }
})();
