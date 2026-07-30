require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// ==========================================
// 1. YAPILANDIRMA (KUSURSUZ EŞLEŞEN PATH'LER)
// ==========================================
const CONFIG = {
  projectName: 'Mustafa Reklam',
  userDataPath: '/home/yasin2celik/mustafa-reklam/user_data',
  targetUrl: 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  lockFilePath: path.join(__dirname, 'bot.lock')
};

// --- TELEGRAM BİLDİRİMİ ---
async function sendTelegramMessage(lead) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    console.warn("⚠️ Telegram API bilgileri eksik (.env)");
    return false;
  }

  const message = `🔔 *YENİ Müşteri!* (${CONFIG.projectName})\n\n` +
                  `👤 *Müşteri:* ${lead["Musteri"]}\n` +
                  `📍 *Konum:* ${lead["Konum"]}\n` +
                  `💼 *Hizmet:* ${lead["Hizmet"]}\n` +
                  `📅 *Tarih:* ${lead["Tarih"]}\n` +
                  `💬 *Mesaj:* ${lead["Mesaj"]}`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    return res.ok;
  } catch (err) {
    console.error('⚠️ Telegram mesaj hatası:', err.message);
    return false;
  }
}

// --- TARİH DÜZENLEME FONKSİYONLARI ---
function parseTo24HourDate(dateStr) {
  if (!dateStr || dateStr === '-') return '-';

  const fixedStr = dateStr.replace(/(\b\d{1,2})(\d{2})\s*(AM|PM)/gi, '$1:$2 $3');
  const match = fixedStr.match(/(\d{2}\.\d{2}\.\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return dateStr;

  let [, datePart, hoursStr, minutes, modifier] = match;
  let hours = parseInt(hoursStr, 10);

  if (modifier) {
    const isPM = modifier.toUpperCase() === 'PM';
    const isAM = modifier.toUpperCase() === 'AM';
    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
  }

  return `${datePart} ${String(hours).padStart(2, '0')}:${minutes}`;
}

function parseDateForSorting(dateStr) {
  if (!dateStr || dateStr === '-') return 0;
  const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})/);
  if (!match) return 0;
  const [, day, month, year, hour, minute] = match;
  return new Date(`20${year}-${month}-${day}T${hour}:${minute}:00`).getTime();
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
// 2. ANA ÇALIŞMA AKIŞI
// ==========================================
(async () => {
  if (fs.existsSync(CONFIG.lockFilePath)) {
    console.log("⚠️ Çalışan başka bir işlem var (bot.lock mevcut). Çıkılıyor.");
    return;
  }
  fs.writeFileSync(CONFIG.lockFilePath, process.pid.toString());

  let freshLeads = [];
  let browser;

  try {
    clearChromeLocks();

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: '/usr/bin/google-chrome',
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
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-breakpad'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);

    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log("🚀 LSA Inbox sayfasına gidiliyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        window.scrollBy(0, 300);
        await new Promise(r => setTimeout(r, 200));
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    // TABLO VERİLERİNİ ÇEKME
    const validRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"], tr'));

      return rows.map((row, idx) => {
        const rawCells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        const cells = rawCells.map(c => c.innerText?.trim() || '').filter(Boolean);

        if (cells.length < 4) return null;
        if (/Gebührenstatus|Kunde|Kundenname/i.test(row.innerText || '')) return null;

        let customerName = cells[0] || '-';
        const jobType = cells[1] || '-';

        if (/Google|Lokale Dienstleistungen|Potenzieller Kunde/i.test(customerName)) {
          customerName = '-';
        }

        if (/^\d+$/.test(customerName) && /^\d+$/.test(jobType)) return null;
        if (/^\d{1,3}$/.test(customerName)) return null;

        let location = cells[3] || '-';
        if (!location || location === '-' || location.length <= 2 || location === jobType || /^\+?\d[\d\s-]{6,}$/.test(location)) {
          location = cells.find((t, i) => 
            i > 1 && 
            t.length > 2 && 
            t !== customerName && 
            t !== jobType && 
            !/^\+?\d[\d\s-]{6,}$/.test(t) && 
            !/^(Kategorie|Direkte|Telefon|Nachricht|Belastet|Wird)/i.test(t) &&
            !/\d{2}\.\d{2}\.\d{2}/.test(t)
          ) || '-';
        }

        const dates = cells.filter(t => /\d{2}\.\d{2}\.\d{2}/.test(t));
        const hasNoCustomerName = !customerName || customerName === '-';
        const isExplicitMessage = /nachricht|message/i.test(row.innerText || '');

        return {
          domIndex: idx,
          phone: customerName,
          jobType,
          location,
          anfrageDate: dates[0] || '-',
          isMessage: isExplicitMessage || hasNoCustomerName
        };
      }).filter(Boolean);
    });

    console.log(`📊 Çekilen Temiz Lead Sayısı: ${validRows.length}`);

    if (validRows.length === 0) {
      throw new Error("❌ Hiç veri bulunamadı! Sayfa yüklenemedi veya Google yapıyı değiştirdi.");
    }

    // MESAJ DETAYLARINI ALMA
    for (const item of validRows) {
      let messageText = "-";
      let finalCustomerName = item.phone;

      if (item.isMessage) {
        try {
          await page.evaluate((index) => {
            const rows = Array.from(document.querySelectorAll('[role="row"], tr'));
            const row = rows[index];
            if (row) (row.querySelector('td, div[role="gridcell"]') || row).click();
          }, item.domIndex);

          await new Promise(r => setTimeout(r, 3500));

          const panelData = await page.evaluate(() => {
            let msg = "-";
            let nameInHeader = null;

            const chatBlock = Array.from(document.querySelectorAll('div, section, article'))
                                  .find(el => (el.innerText || '').includes('Unterhaltung'));
            
            if (chatBlock) {
              let text = chatBlock.innerText.split('Unterhaltung').pop();
              msg = text.split('Wird geladen')[0]
                         .split('Audioinhalte')[0]
                         .split('Hier dem Kunden')[0]
                         .replace(/^P\s+|^Potenzieller Kunde\s+|^\d{2}\.\d{2}\.\d{2}\s+/gi, '')
                         .trim() || "NO MESSAGE";
            }

            const headerBar = Array.from(document.querySelectorAll('div, header'))
                                     .find(el => (el.innerText || '').includes('ARCHIVIEREN') || (el.innerText || '').includes('MARKIEREN'));
            if (headerBar) {
              const lines = headerBar.innerText.split('\n').map(l => l.trim()).filter(Boolean);
              if (lines.length > 0 && !lines[0].includes('ARCHIVIEREN')) {
                const candidate = lines[0].split('|')[0].trim();
                if (!/Google|Lokale|Dienstleistungen|Potenzieller|Anrufer/i.test(candidate)) {
                  nameInHeader = candidate;
                }
              }
            }

            return { msg, nameInHeader };
          });

          messageText = panelData.msg;

          if ((finalCustomerName === '-' || !finalCustomerName) && panelData.nameInHeader) {
            finalCustomerName = panelData.nameInHeader;
          }

        } catch (e) {
          console.warn(`[${item.phone}] Mesaj okuma uyarısı:`, e.message);
        }
      }

      if (!finalCustomerName || finalCustomerName.trim() === '-' || finalCustomerName === '') {
        finalCustomerName = 'Müşteri';
      }

      freshLeads.push({
        "Musteri": finalCustomerName,
        "Hizmet": item.jobType,
        "Konum": item.location,
        "Tarih": parseTo24HourDate(item.anfrageDate),
        "Mesaj": messageText
      });
    }

  } catch (error) {
    console.error("💥 Scraper hatası:", error.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        console.log("🛑 Tarayıcı kapatılıyor...");
        await browser.close();
      } catch (_) {}
    }
    if (fs.existsSync(CONFIG.lockFilePath)) {
      fs.unlinkSync(CONFIG.lockFilePath);
    }
  }

  // ==========================================
  // 3. VERİ İŞLEME VE GIT PUSH
  // ==========================================
  if (freshLeads.length > 0) {
    console.log("⚙️ Veriler işleniyor...");
    
    let previousLeads = [];
    if (fs.existsSync('data.json')) {
      try {
        const oldContent = JSON.parse(fs.readFileSync('data.json', 'utf8'));
        previousLeads = oldContent.leads || [];
      } catch (e) {
        console.warn("⚠️ Eski data.json okunamadı:", e.message);
      }
    }

    const leads = freshLeads.map(newLead => {
      const existing = previousLeads.find(old => old["Tarih"] === newLead["Tarih"]);
      return {
        ...newLead,
        telegramSent: existing ? (existing.telegramSent || false) : false
      };
    });

    leads.sort((a, b) => parseDateForSorting(b["Tarih"]) - parseDateForSorting(a["Tarih"]));

    const unsentLeads = leads.filter(l => !l.telegramSent);
    console.log(`🔎 İnceleme Tamamlandı. Bildirim Gitmemiş Yeni Lead Sayısı: ${unsentLeads.length}`);

    if (unsentLeads.length > 0 || leads.length !== previousLeads.length) {
      for (const leadToNotify of unsentLeads) {
        const isSuccess = await sendTelegramMessage(leadToNotify);
        if (isSuccess) {
          leadToNotify.telegramSent = true;
          console.log(`📱 Telegram bildirimi gönderildi: ${leadToNotify["Musteri"]}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      const outputData = {
        updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
        leads
      };

      fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
      console.log(`💾 data.json tarihe göre sıralandı ve kaydedildi.`);

      try {
        console.log("⏳ GitHub Sync Yapılıyor...");
        execSync('git add data.json', { timeout: 15000 });
        execSync('git commit -m "Auto-update & sort data.json [skip ci]" || true', { timeout: 15000 });
        execSync('git pull origin main --rebase -X ours', { timeout: 20000 });
        execSync('git push origin main', { timeout: 20000 });
        console.log("✅ Git Push Başarılı!");
      } catch (gitErr) {
        console.error("⚠️ Git push hatası:", gitErr.message);
      }
    } else {
      console.log("ℹ️ Yeni müşteri veya gönderilmemiş bildirim yok.");
    }
  }
})();
