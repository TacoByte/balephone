// Share-link flow test: the gatherer's dialog shows a join URL with a COPY
// button; opening that URL in another browser prefills the room code in the
// join dialog. Requires the relay server running (wasm/relay, port 8787).
//
// Usage: node sharelink_test.js [copy_fx,copy_fy]
//   copy_fx,copy_fy: canvas-fraction position of the COPY button (default
//   from the standard layout; pass explicitly after layout changes).
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BUILD_DIR = path.resolve(__dirname, '../build');
const PORT = 8791;
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

async function clickCanvas(page, fx, fy) {
  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  await page.waitForTimeout(1500);
}

(async () => {
  // Mouse input maps to the dialog's 640x480 virtual space stretched over
  // the whole canvas; the COPY button sits at ~(459,124) of 640x480.
  const [copyFx, copyFy] = (process.argv[2] || '0.717,0.258').split(',').map(Number);
  const server = await startServer(PORT);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });

  // --- A: gather a game, check the share row, copy the link ---------------
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  await ctxA.grantPermissions(['clipboard-read', 'clipboard-write'],
                              { origin: `http://127.0.0.1:${PORT}` });
  const pageA = await ctxA.newPage();
  await pageA.goto(`http://127.0.0.1:${PORT}/index.html?scenario=marathon2`,
                   { waitUntil: 'domcontentloaded' });
  await pageA.waitForTimeout(14000);

  await clickCanvas(pageA, 0.185, 0.575); // Gather Network Game
  await clickCanvas(pageA, 0.44, 0.82);   // setup dialog: OK
  await pageA.waitForTimeout(3000);

  const room = await pageA.evaluate(() => window.__module && window.__module.__a1RoomCode || '');
  console.log(`room code: "${room}"`);
  await pageA.screenshot({ path: 'share_gather.png' });

  await clickCanvas(pageA, copyFx, copyFy); // COPY button
  await pageA.screenshot({ path: 'share_after_copy.png' });
  const copied = await pageA.evaluate(() => window.__module && window.__module.__a1LastCopy || '');
  const clipboard = await pageA.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e.message);
  const expected = `http://127.0.0.1:${PORT}/?scenario=marathon2&join=${room}`;
  console.log(`copied: "${copied}"  clipboard: "${clipboard}"`);
  console.log(copied === expected ? 'COPY OK' : `COPY MISMATCH (expected "${expected}")`);

  // --- B: open the share link; the join dialog opens itself, prefilled ----
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(`http://127.0.0.1:${PORT}/?scenario=marathon2&join=${room}`,
                   { waitUntil: 'domcontentloaded' });
  await pageB.waitForTimeout(16000);

  await pageB.screenshot({ path: 'share_join_prefilled.png' });
  await clickCanvas(pageB, 0.5, 0.333);   // JOIN
  await pageB.waitForTimeout(4000);
  await pageB.screenshot({ path: 'share_join_waiting.png' });

  // A should now list the joiner in the gather dialog.
  await pageA.screenshot({ path: 'share_gather_joiner.png' });

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
