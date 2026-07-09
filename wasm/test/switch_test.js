// Drives the in-game preferences UI to switch renderer and verifies the page
// reloads into a working screen instead of blacking out.
// Steps are given as "c:fx,fy" canvas-fraction clicks, "k:Key" key presses,
// "w:ms" waits, "s:name" screenshots — so coordinates can be iterated quickly.
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
  const steps = process.argv.slice(2);
  const server = await startServer(8786);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 2560, height: 1440 },
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  let reloads = 0;
  page.on('load', () => { reloads++; });

  await page.goto('http://127.0.0.1:8786/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  reloads = 0;

  for (const step of steps) {
    const [op, arg] = [step.slice(0, 1), step.slice(2)];
    if (op === 'c') {
      const [fx, fy] = arg.split(',').map(Number);
      const box = await (await page.$('canvas')).boundingBox();
      await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
      await page.waitForTimeout(1500);
    } else if (op === 'k') {
      await page.keyboard.press(arg);
      await page.waitForTimeout(800);
    } else if (op === 'w') {
      await page.waitForTimeout(Number(arg));
    } else if (op === 's') {
      await page.screenshot({ path: `switch_${arg}.png`, timeout: 8000 })
        .catch(() => console.log(`SCREENSHOT TIMEOUT at ${arg}`));
    }
  }

  console.log('page reloads during steps:', reloads);
  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
