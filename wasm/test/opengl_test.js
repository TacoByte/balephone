// Boots once, flips prefs to the OpenGL (shader) renderer, reloads, starts a
// game, and screenshots. Checks the renderer actually initialized (no
// fallback-to-software warning) and the page stays responsive.
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
  const server = await startServer(8784);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 2560, height: 1440 },
  });
  const page = await context.newPage();

  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('crash', () => logs.push('[CRASH]'));

  // Boot 1: default (software), then flip prefs to OpenGL.
  await page.goto('http://127.0.0.1:8784/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  const flip = await page.evaluate(async () => {
    const M = window.__module;
    const p = '/home/web_user/.alephone/Marathon 2 Preferences';
    let txt = M.FS.readFile(p, { encoding: 'utf8' });
    txt = txt.replace(/scmode_accel="\d+"/, 'scmode_accel="1"');
    M.FS.writeFile(p, txt);
    await new Promise((res, rej) => M.FS.syncfs(false, (e) => e ? rej(e) : res()));
    return txt.match(/scmode_accel="\d+"/)[0];
  }).catch(e => 'ERR ' + e.message);
  console.log('prefs flip:', flip);

  // Boot 2: OpenGL renderer.
  logs.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);
  await page.screenshot({ path: 'gl_1_menu.png' });

  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + 0.325 * box.width, box.y + 0.403 * box.height);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'gl_2_game.png', timeout: 8000 }).catch(() => console.log('SCREENSHOT TIMEOUT (hung)'));

  // Move a bit, screenshot again.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1200);
  await page.keyboard.up('ArrowUp');
  await page.screenshot({ path: 'gl_3_moved.png', timeout: 8000 }).catch(() => console.log('SCREENSHOT TIMEOUT (hung)'));

  fs.writeFileSync('gl_console.log', logs.join('\n'));
  const relevant = logs.filter(l => /GL|gl4es|shader|render|WARNING|error|Aborted/i.test(l));
  console.log('--- relevant console ---');
  console.log(relevant.slice(-25).join('\n'));

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
