// Measures canvas size at menu and in-game, for default prefs and for an
// explicit windowed resolution written into the persisted prefs file.
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

async function measure(page, label) {
  const m = await page.evaluate(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    return {
      attr: `${c.width}x${c.height}`,
      css: `${Math.round(r.width)}x${Math.round(r.height)}`,
      styleWH: `${c.style.width}|${c.style.height}`,
    };
  });
  console.log(`${label}: backing=${m.attr} css=${m.css} style=${m.styleWH}`);
}

async function bootAndStartGame(page) {
  await page.goto('http://127.0.0.1:8782/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  await measure(page, 'menu');
  const box = await (await page.$('canvas')).boundingBox();
  // BEGIN NEW GAME sits at fraction (0.325, 0.403) of the canvas.
  await page.mouse.click(box.x + 0.325 * box.width, box.y + 0.403 * box.height);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space'); // skip chapter screen
  await page.waitForTimeout(6000);
  await measure(page, 'in-game');
}

(async () => {
  const server = await startServer(8782);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 2560, height: 1440 },
  });
  const page = await context.newPage();

  console.log('screen:', await page.evaluate(() => `${screen.width}x${screen.height}`));
  console.log('=== pass 1: default prefs (auto resolution) ===');
  await bootAndStartGame(page);
  await page.screenshot({ path: 'res_pass1.png' });

  console.log('=== pass 2: explicit 1280x720 windowed in prefs ===');
  const ok = await page.evaluate(async () => {
    const M = window.__module;
    const prefsPath = '/home/web_user/.alephone/Marathon 2 Preferences';
    let txt;
    try { txt = M.FS.readFile(prefsPath, { encoding: 'utf8' }); }
    catch (e) { return 'no prefs file: ' + e.message; }
    txt = txt
      .replace(/scmode_width="\d+"/, 'scmode_width="1280"')
      .replace(/scmode_height="\d+"/, 'scmode_height="720"')
      .replace(/scmode_auto_resolution="true"/, 'scmode_auto_resolution="false"');
    M.FS.writeFile(prefsPath, txt);
    await new Promise((res, rej) => M.FS.syncfs(false, (e) => e ? rej(e) : res()));
    return 'prefs updated';
  }).catch(e => 'EVAL ERR ' + e.message);
  console.log(ok);

  await bootAndStartGame(page);
  await page.screenshot({ path: 'res_pass2.png' });

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
