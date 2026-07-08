// Soak test: screenshot every 10s, note when the page stops responding.
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
};

function startServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(BUILD_DIR, req.url.split('?')[0].replace(/^\//, '') || 'index.html');
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const totalSeconds = parseInt(process.argv[2] || '90', 10);
  const server = await startServer(8777);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.stack || err.message}`));
  page.on('crash', () => logs.push('[CRASH] page crashed'));

  await page.goto('http://127.0.0.1:8777/index.html', { waitUntil: 'domcontentloaded' });

  const t0 = Date.now();
  for (let s = 10; s <= totalSeconds; s += 10) {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    try {
      await page.screenshot({ path: `soak_${s}s.png`, timeout: 8000 });
      console.log(`t=${s}s OK`);
    } catch {
      console.log(`t=${s}s SCREENSHOT TIMEOUT (page unresponsive)`);
    }
  }

  fs.writeFileSync('soak_console.log', logs.join('\n'));
  console.log('--- console tail ---');
  console.log(logs.slice(-25).join('\n'));
  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
