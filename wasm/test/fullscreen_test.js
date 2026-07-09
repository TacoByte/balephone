// Verifies clicking the canvas no longer triggers a fullscreen request.
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
      const file = path.join(BUILD_DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
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
  const server = await startServer(8781);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  let fullscreenRequested = false;
  await page.exposeFunction('__fsRequested', () => { fullscreenRequested = true; });
  await page.addInitScript(() => {
    const orig = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (...a) {
      window.__fsRequested();
      return orig.apply(this, a);
    };
  });

  await page.goto('http://127.0.0.1:8781/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000); // boot to menu

  // Click a neutral spot (the logo area), then a couple more times.
  await page.mouse.click(640, 150);
  await page.waitForTimeout(1000);
  await page.mouse.click(640, 150);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'fs_after_click.png' });

  const fsElement = await page.evaluate(() => document.fullscreenElement !== null);
  console.log('fullscreen requested:', fullscreenRequested);
  console.log('fullscreenElement active:', fsElement);
  console.log(!fullscreenRequested && !fsElement ? 'FULLSCREEN FIX OK' : 'STILL GOING FULLSCREEN');

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
