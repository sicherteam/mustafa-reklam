require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
// 2. GELİŞMİŞ LOGLAMA VE SİSTEM YARDIMCILARI
// ==========================================
function writeLog(stage, msg, isError = false) {
  const timestamp = new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
  const prefix = isError ? '❌ [ERROR]' : 'ℹ️ [INFO]';
  const formattedMsg = `[${timestamp}] ${prefix} [${stage}] => ${msg}`;
  if (isError) {
    console.error(formattedMsg);
  } else {
    console.log(formattedMsg);
  }
}

function clearChromeLocks() {
  writeLog('INIT', 'Chrome kilit dosyaları temizleniyor...');
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
  locks.forEach(lock => {
    const lockPath = path.join(CONFIG.userDataPath, lock);
    if (fs.existsSync(lockPath)) {
      try { 
        fs.unlinkSync(lockPath);
        writeLog('INIT', `Kilit dosyası silindi: ${lock}`);
      } catch (e) {
        writeLog('INIT', `Kilit dosyası silinemedi (${lock}): ${e.message}`, true);
      }
    }
  });
}

// ==========================================
// 3. ANA MOTOR (DEBUG & INTERCEPTOR)
// ==========================================
async function runLsaCollector() {
  writeLog('START', '================ PROCESS BAŞLATILDI ================');
  
  if (fs.existsSync(CONFIG.lockFilePath)) {
    writeLog('LOCK_CHECK', 'Çalışan başka bir işlem var (bot.lock mevcut). İptal ediliyor.', true);
    return;
  }

  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());
  writeLog('LOCK_CHECK', `Lock dosyası oluşturuldu. PID: ${process.pid}`);

  let browser;
  let capturedPayloads = [];

  try {
    clearChromeLocks();

    writeLog('BROWSER', 'Puppeteer başlatılıyor...');
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
    writeLog('BROWSER', 'Puppeteer başarıyla başlatıldı.');

    const page = await browser.newPage();
    writeLog('PAGE', 'Yeni sekme açıldı ve varsayılan ayarlar yapılıyor.');
    
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // --------------------------------------------------
    // NETWORK TRAFİK DINLEYICI (TAM KONTROL)
    // --------------------------------------------------
    writeLog('NETWORK', 'Network dinleyicileri (request/response) aktif ediliyor...');

    page.on('request', req => {
      const url = req.url();
      if (url.includes('batchexecute')) {
        writeLog('NETWORK_REQ', `[batchexecute İSTEĞİ ATILDI] URL: ${url.substring(0, 110)}... Method: ${req.method()}`);
      }
    });

    page.on('response', async res => {
      const url = res.url();
      const status = res.status();

      if (url.includes('batchexecute')) {
        writeLog('NETWORK_RES', `[batchexecute YANIT GELDİ] Status: ${status} | URL: ${url.substring(0, 110)}...`);
        
        if (url.includes('DiUHNe')) {
          writeLog('TARGET_API', '🎯🎯🎯 Aranan RPC ID (DiUHNe) Yakalandı!');
          try {
            const body = await res.text();
            writeLog('TARGET_API', `Gelen Yanıt Boyutu: ${body.length} Byte`);
            writeLog('TARGET_API', `Yanıt Önizleme (İlk 300 Karakter): ${body.substring(0, 300).replace(/\r?\n|\r/g, ' ')}`);
            capturedPayloads.push({ timestamp: new Date().toISOString(), body });
          } catch (e) {
            writeLog('TARGET_API', `Yanıt gövdesi (text) okunamadı: ${e.message}`, true);
          }
        }
      }
    });

    // --------------------------------------------------
    // NAVİGASYON ADIMI
    // --------------------------------------------------
    writeLog('GOTO', `Hedef adrese gidiliyor: ${CONFIG.targetUrl}`);
    const gotoResponse = await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });
    
    writeLog('GOTO', `Sayfa yüklendi. HTTP Status Code: ${gotoResponse ? gotoResponse.status() : 'N/A'}`);

    const pageTitle = await page.title();
    writeLog('DOM_CHECK', `Sayfa Başlığı: "${pageTitle}"`);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      writeLog('DOM_CHECK', `Oturum kapalı veya engelleme var! Başlık uyuştu: ${pageTitle}`, true);
      throw new Error(`Oturum açılamadı veya erişim engellendi. Title: ${pageTitle}`);
    }

    // --------------------------------------------------
    // BUTON ETKİLEŞİMİ VE TETİKLEME
    // --------------------------------------------------
    writeLog('WAIT', 'Sayfa bileşenlerinin tam oturması için 3 saniye bekleniyor...');
    await new Promise(r => setTimeout(r, 3000));

    if (capturedPayloads.length === 0) {
      writeLog('TRIGGER', 'Sayfa yüklenirken DiUHNe API yanıtı henüz gelmedi. Buton ile tetikleme deneniyor...');
      
      try {
        writeLog('TRIGGER', "'Herunterladen' butonu locator ile aranıyor...");
        const btn = page.getByText('Herunterladen', { exact: true });
        
        if (btn) {
          writeLog('TRIGGER', "Buton bulundu. Tıklama yapılıyor...");
          await btn.click();
          writeLog('TRIGGER', "✅ Tıklama gerçekleşti! Arka plan network yanıtları için 7 saniye bekleniyor...");
          await new Promise(r => setTimeout(r, 7000));
        } else {
          writeLog('TRIGGER', "❌ 'Herunterladen' butonu locator ile bulunamadı!", true);
        }
      } catch (e) {
        writeLog('TRIGGER', `Buton arama/tıklama aşamasında hata: ${e.message}`, true);
      }
    } else {
      writeLog('TRIGGER', 'DiUHNe API yanıtı sayfa açılışında zaten yakalandı! Ekstra tıklama yapılmıyor.');
    }

    // --------------------------------------------------
    // SONUÇ VE DOSYALAMA
    // --------------------------------------------------
    writeLog('SUMMARY', `Toplam yakalanan DiUHNe API Yanıt Sayısı: ${capturedPayloads.length}`);

    if (capturedPayloads.length > 0) {
      const debugLogPath = path.join(__dirname, 'last_rpc_response.log');
      fs.writeFileSync(debugLogPath, capturedPayloads[capturedPayloads.length - 1].body, 'utf8');
      writeLog('SUMMARY', `✅ En son yakalanan ham API yanıtı diske yazıldı: ${debugLogPath}`);
    } else {
      writeLog('SUMMARY', '❌ İşlem bitti fakat hiç DiUHNe yanıtı yakalanamadı.', true);
      
      // Ekran görüntüsü alarak DOM durumunu görelim
      const ssPath = path.join(__dirname, 'debug-screen.png');
      await page.screenshot({ path: ssPath, fullPage: true });
      writeLog('SUMMARY', `Hata analizi için ekran görüntüsü alındı: ${ssPath}`);
    }

  } catch (err) {
    writeLog('FATAL', `Kod çalışırken beklenmeyen bir hata fırlattı: ${err.message}`, true);
    if (err.stack) {
      writeLog('FATAL_STACK', err.stack, true);
    }
  } finally {
    if (browser) {
      writeLog('CLEANUP', 'Kapanış işlemleri: Tarayıcı kapatılıyor...');
      await browser.close();
      writeLog('CLEANUP', 'Tarayıcı kapatıldı.');
    }
    
    if (fs.existsSync(CONFIG.lockFilePath)) {
      try { 
        fs.unlinkSync(CONFIG.lockFilePath);
        writeLog('CLEANUP', 'Lock dosyası kaldırıldı.');
      } catch (_) {}
    }
    writeLog('END', '================ PROCESS TAMAMLANDI ================');
  }
}

runLsaCollector();
