// Lists the persisted dir and dumps graphics prefs after boot.
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
  const server = await startServer(8783);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8783/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);

  const out = await page.evaluate(() => {
    const M = window.__module;
    const walk = (dir, depth) => {
      let lines = [];
      for (const name of M.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const p = dir + '/' + name;
        const isDir = M.FS.isDir(M.FS.stat(p).mode);
        lines.push('  '.repeat(depth) + name + (isDir ? '/' : ''));
        if (isDir && depth < 3) lines = lines.concat(walk(p, depth + 1));
      }
      return lines;
    };
    let tree;
    try { tree = walk('/home/web_user/.alephone', 0).join('\n'); }
    catch (e) { tree = 'ERR ' + e.message; }
    return tree;
  });
  console.log(out);

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
