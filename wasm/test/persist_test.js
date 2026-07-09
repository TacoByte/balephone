// Verifies IDBFS persistence: write a file in the persisted dir, sync,
// reload the page, and check the file survived.
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
  const server = await startServer(8779);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext(); // same context = same IndexedDB
  const page = await context.newPage();

  await page.goto('http://127.0.0.1:8779/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000); // boot to menu

  const wrote = await page.evaluate(async () => {
    const M = window.__module;
    if (!M) return 'no module handle';
    M.FS.writeFile('/home/web_user/.alephone/persist_probe.txt', 'marathon lives');
    await new Promise((res, rej) => M.FS.syncfs(false, (e) => e ? rej(e) : res()));
    return 'ok';
  }).catch(e => 'EVAL ERROR: ' + e.message);
  console.log('write:', wrote);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);

  const readBack = await page.evaluate(() => {
    const M = window.__module;
    if (!M) return 'no module handle';
    try {
      return M.FS.readFile('/home/web_user/.alephone/persist_probe.txt', { encoding: 'utf8' });
    } catch (e) { return 'READ ERROR: ' + e.message; }
  }).catch(e => 'EVAL ERROR: ' + e.message);
  console.log('readback:', readBack);
  console.log(readBack === 'marathon lives' ? 'PERSIST OK' : 'PERSIST FAILED');

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
