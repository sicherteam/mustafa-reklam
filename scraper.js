require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

// --- CONFIGURATION (MUSTAFA REKLAM) ---
const CONFIG = {
  projectName: 'Mustafa Reklam',
  userDataPath: '/home/ubuntu/mustafa-reklam/user_data',
  targetUrl: 'https://ads.google.com/localservices/inbox?cid=4747284491&bid=10999542772&pid=9999999999&euid=3547106212&hl=de-AT&gl=AT',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

// Native Fetch API ile Telegram Bildirimi
async function sendTelegramMessage(lead) {
  if (!CONFIG.telegramToken || !CONFIG.telegramChatId) {
    console.warn("⚠️ Telegram API bilgileri eksik (.env)");
    return;
  }

  const message = `🔔 *YENİ LSA LEAD!* (${CONFIG.projectName})\n\n` +
                  `👤 *Müşteri:* ${lead["Musteri"]}\n` +
                  `📍 *Konum:* ${lead["Konum"]}\n` +
                  `💼 *Hizmet:* ${lead["Hizmet"]}\n` +
                  `📅 *İlk Görüşme:* ${lead["Ilk gorusme"]}\n` +
                  `⏳ *Son Görüşme:* ${lead["Son gorusme"]}\n` +
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
    if (res.ok) console.log(`📱 Telegram bildirimi gönderildi: ${lead["Musteri"]}`);
  } catch (err) {
    console.error('⚠️ Telegram mesaj hatası:', err.message);
  }
}

// 24-Hour Strict Date Formatter
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

// Clear Chrome Locks
function clearChromeLocks() {
  const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  locks.forEach(lock => {
    const lockPath = path.join(CONFIG.userDataPath, lock);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  });
}

// --- MAIN EXECUTION ---
(async () => {
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
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--lang=de-AT,de'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(90000);

    console.log("LSA Inbox sayfasına gidiliyor...");
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const pageTitle = await page.title();
    console.log("Sayfa Başlığı:", pageTitle);

    if (/Anmelden|Sign in|YouTube|Error|504|Serverfehler/i.test(pageTitle)) {
      throw new Error(`❌ Oturum açılamadı veya Google engelledi! Başlık: ${pageTitle}`);
    }

    // Lazy load tetiklemek için smooth scroll
    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        window.scrollBy(0, 300);
        await new Promise(r => setTimeout(r, 200));
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    // 1. AŞAMA: TABLO VERİLERİNİ HASSAS FİLTRELEME İLE ÇEKME
    const validRows = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"], tr'));

      return rows.map((row, idx) => {
        const rawCells = Array.from(row.querySelectorAll('td, div[role="gridcell"]'));
        const cells = rawCells.map(c => c.innerText?.trim() || '').filter(Boolean);

        if (cells.length < 4) return null;
        if (/Gebührenstatus|Kunde|Kundenname/i.test(row.innerText || '')) return null;

        let customerName = cells[0] || '-';
        const jobType = cells[1] || '-';

        // Google sistem markalarını isim sanmasın
        if (/Google|Lokale Dienstleistungen|Potenzieller Kunde/i.test(customerName)) {
          customerName = '-';
        }

        // GÜVENLİK FİLTRELERİ (Takvim / Sayfa çöplerini temizleme)
        if (/^\d+$/.test(customerName) && /^\d+$/.test(jobType)) return null;
        if (/^\d{1,3}$/.test(customerName)) return null;

        // KONUM TESPİTİ (> 2 karakter kontrolü)
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

        // MÜŞTERİ İSMİ '-' İSE VEYA 'NACHRICHT' İSE HER TÜRLÜ TIKLA
        const hasNoCustomerName = !customerName || customerName === '-';
        const isExplicitMessage = /nachricht|message/i.test(row.innerText || '');

        const shouldOpenPanel = isExplicitMessage || hasNoCustomerName;

        return {
          domIndex: idx,
          phone: customerName,
          jobType,
          location,
          anfrageDate: dates[0] || '-',
          letzteDate: dates[1] || dates[0] || '-',
          isMessage: shouldOpenPanel
        };
      }).filter(Boolean);
    });

    console.log(`📊 Çekilen Temiz Lead Sayısı: ${validRows.length}`);

    if (validRows.length === 0) {
      throw new Error("❌ Hiç veri bulunamadı! Sayfa yüklenemedi veya Google yapıyı değiştirdi.");
    }

    // 2. AŞAMA: MESAJ DETAYLARINI VE PANEL VERİLERİNİ ALMA
    const leads = [];
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

          await new Promise(r => setTimeout(r, 5000));

          const panelData = await page.evaluate(() => {
            let msg = "-";
            let nameInHeader = null;

            // Chat / Unterhaltung Bloku
            const chatBlock = Array.from(document.querySelectorAll('div, section, article'))
                                  .find(el => (el.innerText || '').includes('Unterhaltung'));
            
            if (chatBlock) {
              let text = chatBlock.innerText.split('Unterhaltung').pop();
              msg = text.split('Wird geladen')[0]
                         .split('Audioinhalte')[0]
                         .split('Hier dem Kunden')[0]
                         .replace(/^P\s+|^Potenzieller Kunde\s+|^\d{2}\.\d{2}\.\d{2}\s+/gi, '')
                         .trim() || "-";
            }

            // Panel Header'ından Gerçek İsim Kurtarma
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

          // İsmi '-' ise ama panel header'ında gerçek isim varsa güncelle
          if ((finalCustomerName === '-' || !finalCustomerName) && panelData.nameInHeader) {
            finalCustomerName = panelData.nameInHeader;
          }

        } catch (e) {
          console.warn(`[${item.phone}] Mesaj okuma uyarısı:`, e.message);
        }
      }

      leads.push({
        "Musteri": finalCustomerName,
        "Hizmet": item.jobType,
        "Konum": item.location,
        "Ilk gorusme": parseTo24HourDate(item.anfrageDate),
        "Son gorusme": parseTo24HourDate(item.letzteDate),
        "Mesaj": messageText
      });
    }

    // 3. AŞAMA: SADECE YENİ MÜŞTERİ VARSA KAYDET VE BİLDİRİM GÖNDER
    let previousLeads = [];
    if (fs.existsSync('data.json')) {
      try {
        const oldContent = JSON.parse(fs.readFileSync('data.json', 'utf8'));
        previousLeads = oldContent.leads || [];
      } catch (e) {
        console.warn("⚠️ Eski data.json okunamadı, tümü yeni kabul edilecek:", e.message);
      }
    }

    // Var olan listede bulunmayan YENİ müşteri tespiti
    const newLeads = leads.filter(newLead => {
      return !previousLeads.some(oldLead => 
        oldLead["Musteri"] === newLead["Musteri"] &&
        oldLead["Ilk gorusme"] === newLead["Ilk gorusme"] &&
        oldLead["Mesaj"] === newLead["Mesaj"]
      );
    });

    console.log(`🔎 İnceleme Tamamlandı. Bulunan YENİ Lead Sayısı: ${newLeads.length}`);

    if (newLeads.length > 0) {
      const outputData = {
        updatedAt: new Date().toLocaleString('de-AT', { timeZone: 'Europe/Vienna' }),
        leads
      };

      fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
      console.log(`🎉 YENİ MÜŞTERİ GELMİŞ! ${newLeads.length} adet yeni lead data.json dosyasına yazıldı.`);

      try {
        console.log("⏳ GitHub Pages çakışma önleyici (10sn)...");
        await new Promise(r => setTimeout(r, 10000));

        execSync('git add data.json');
        execSync('git commit -m "Auto-update data.json [new leads] [skip ci]" || true');
        execSync('git pull origin main --rebase -X ours');
        execSync('git push origin main');
        console.log("✅ GitHub'a başarıyla push edildi!");

        // SADECE YENİ MÜŞTERİLER İÇİN TELEGRAM MESAJI AT
        for (const newLead of newLeads) {
          await sendTelegramMessage(newLead);
          await new Promise(r => setTimeout(r, 1000));
        }

      } catch (gitErr) {
        console.error("⚠️ Git push veya Telegram hatası:", gitErr.message);
      }
    } else {
      console.log("ℹ️ Yeni bir müşteri veya değişiklik yok. Telegram bildirimi ve Git push atlandı.");
    }

  } catch (error) {
    console.error("💥 Scraper hatası:", error.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
