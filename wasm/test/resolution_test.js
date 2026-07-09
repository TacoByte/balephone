// Verifies that automatic resolution follows the browser viewport (including
// live resizes), while an explicit resolution retains its fixed aspect ratio.
const assert = require('assert');
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
  return m;
}

async function boot(page) {
  await page.goto('http://127.0.0.1:8782/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
}

async function startGame(page) {
  await measure(page, 'menu');
  const box = await (await page.$('canvas')).boundingBox();
  // BEGIN NEW GAME sits at fraction (0.325, 0.403) of the canvas.
  await page.mouse.click(box.x + 0.325 * box.width, box.y + 0.403 * box.height);
  await page.waitForTimeout(4000);
  await page.keyboard.press('Space'); // skip chapter screen
  await page.waitForTimeout(6000);
}

async function updatePrefs(page, replacements, enableEnhancedHud = false) {
  return page.evaluate(async ({ replacements, enableEnhancedHud }) => {
    const M = window.__module;
    const prefsPath = '/home/web_user/.alephone/Marathon 2 Preferences';
    let txt = M.FS.readFile(prefsPath, { encoding: 'utf8' });
    if (enableEnhancedHud) {
      txt = txt.replace(/^.*<disable_plugin[^>]*Enhanced HUD[^>]*>.*\n/m, '');
    }
    for (const [name, value] of Object.entries(replacements)) {
      txt = txt.replace(new RegExp(`${name}="[^"]*"`), `${name}="${value}"`);
    }
    M.FS.writeFile(prefsPath, txt);
    await new Promise((resolve, reject) => {
      M.FS.syncfs(false, (error) => error ? reject(error) : resolve());
    });
  }, { replacements, enableEnhancedHud });
}

(async () => {
  const server = await startServer(8782);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 2560, height: 1440 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    if (!error.message.includes('not valid for pointer lock')) {
      errors.push(`pageerror: ${error.message}`);
    }
  });

  console.log('screen:', await page.evaluate(() => `${screen.width}x${screen.height}`));
  console.log('=== pass 1: automatic resolution + Enhanced HUD ===');
  await boot(page);
  await updatePrefs(page, {
    scmode_auto_resolution: 'true',
    scmode_width: '640',
    scmode_height: '480',
  }, true);
  await boot(page);
  await startGame(page);

  const automatic = await measure(page, 'automatic in-game');
  assert.strictEqual(automatic.attr, '1920x1080');
  assert.strictEqual(automatic.css, '1920x1080');
  const initialShot = await page.screenshot({ path: 'res_auto_initial.png' });
  assert(initialShot.length > 100000, 'initial gameplay screenshot is unexpectedly blank');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1000);
  const resized = await measure(page, 'automatic after resize');
  assert.strictEqual(resized.attr, '1440x900');
  assert.strictEqual(resized.css, '1440x900');
  const resizedShot = await page.screenshot({ path: 'res_auto_resized.png' });
  assert(resizedShot.length > 100000, 'resized gameplay screenshot is unexpectedly blank');
  assert.deepStrictEqual(errors, [], `runtime errors after resize:\n${errors.join('\n')}`);

  console.log('=== pass 2: explicit 1280x720 windowed in prefs ===');
  await updatePrefs(page, {
    scmode_auto_resolution: 'false',
    scmode_width: '1280',
    scmode_height: '720',
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await boot(page);
  await startGame(page);
  const explicit = await measure(page, 'explicit in-game');
  assert.strictEqual(explicit.attr, '1280x720');
  assert.strictEqual(explicit.css, '1920x1080');

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
