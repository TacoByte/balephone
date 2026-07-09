// Interactive test: click Begin New Game, advance chapter screen, move player.
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
  const server = await startServer(8778);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('crash', () => console.log('[CRASH]'));

  await page.goto('http://127.0.0.1:8778/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(15000); // load + menu
  await page.screenshot({ path: 'play_1_menu.png' });

  const canvas = await page.$('canvas');
  const box = await canvas.boundingBox();
  console.log('canvas box:', JSON.stringify(box));

  // "BEGIN NEW GAME" button sits ~ (333, 258) in 1024x640 canvas space.
  const cx = box.x + (333 / 1024) * box.width;
  const cy = box.y + (258 / 640) * box.height;
  await page.mouse.click(cx, cy);
  console.log('clicked begin new game at', Math.round(cx), Math.round(cy));

  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'play_2_after_click.png' });

  // Dismiss chapter screen (any key) and wait for level load.
  await page.keyboard.press('Space');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'play_3_level.png' });

  // Move forward + turn (classic defaults: arrow keys).
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'play_4_moved.png' });

  console.log('DONE');
  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
