#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ENV_PATH = path.resolve('.env');
const ENV_EXAMPLE_PATH = path.resolve('.env.example');

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      env[key] = val;
    }
  }
  return env;
}

function updateEnv(updates) {
  let content = '';
  if (fs.existsSync(ENV_PATH)) {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  }

  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

const env = { ...parseEnv(ENV_EXAMPLE_PATH), ...parseEnv(ENV_PATH), ...process.env };

const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('\n❌ HATA: GOOGLE_CLIENT_ID ve GOOGLE_CLIENT_SECRET .env dosyasında tanımlı olmalıdır.');
  process.exit(1);
}

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/adwords';

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  if (reqUrl.pathname !== '/oauth2callback') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Yetkilendirme Hatası</h1><p>${error}</p>`);
    console.error(`\n❌ Yetkilendirme hatası: ${error}`);
    server.close();
    process.exit(1);
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>Hata: Kod bulunamadı</h1>');
    return;
  }

  console.log('\n⏳ Yetkilendirme kodu alındı, Refresh Token isteniyor...');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      const msg = tokenData.error_description || tokenData.error || JSON.stringify(tokenData);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Token Alınamadı</h1><p>${msg}</p>`);
      console.error(`\n❌ Token alma başarısız: ${msg}`);
      server.close();
      process.exit(1);
      return;
    }

    const refreshToken = tokenData.refresh_token;
    updateEnv({ GOOGLE_REFRESH_TOKEN: refreshToken });

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1 style="color: #2e7d32;">🎉 Yetkilendirme Başarılı!</h1>
        <p>Google Ads API Refresh Token başarıyla alındı ve <code>.env</code> dosyasına kaydedildi.</p>
        <p>Bu tarayıcı sekmesini kapatabilirsiniz.</p>
      </div>
    `);

    console.log('\n✅ BAŞARILI! Refresh Token alındı ve .env dosyasına yazıldı:');
    console.log(`GOOGLE_REFRESH_TOKEN=${refreshToken.slice(0, 10)}...${refreshToken.slice(-5)}`);
    console.log('\nİşlem tamamlandı.');

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1500);

  } catch (err) {
    console.error(`\n❌ Bir hata oluştu: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>Sunucu Hatası</h1><p>${err.message}</p>`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n======================================================');
  console.log('🚀 GOOGLE ADS OAUTH KURULUM SİHİRBAZI BAŞLATILDI');
  console.log('======================================================');
  console.log(`Tarayıcınız otomatik açılıyor... Açılmazsa linke tıklayın:\n`);
  console.log(authUrl);
  console.log('\nTarayıcıda Google hesabınızla giriş yapıp onay verin.');
  console.log('İşlem bitince token otomatik olarak .env dosyasına yazılacaktır.');
  console.log('======================================================\n');

  // Tarayıcıyı aç
  execFile('powershell', ['-NoProfile', '-Command', `Start-Process '${authUrl.replace(/'/g, "''")}'`]);
});
