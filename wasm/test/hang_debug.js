// Waits for the hang, then pauses via CDP Debugger to capture the stack.
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
  const server = await startServer(8777);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const session = await page.context().newCDPSession(page);

  page.on('console', (m) => { if (m.type() !== 'warning') console.log('[console]', m.text()); });

  await page.goto('http://127.0.0.1:8777/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' });

  // Wait until page stops answering cheap evaluations.
  const start = Date.now();
  let hung = false;
  while (Date.now() - start < 120000) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      await Promise.race([
        page.evaluate('1+1'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('eval-timeout')), 4000)),
      ]);
      console.log(`t=${Math.round((Date.now()-start)/1000)}s responsive`);
    } catch {
      hung = true;
      console.log(`t=${Math.round((Date.now()-start)/1000)}s HUNG - pausing debugger`);
      break;
    }
  }

  if (hung) {
    await session.send('Debugger.enable');
    const paused = new Promise((resolve) => session.once('Debugger.paused', resolve));
    await session.send('Debugger.pause');
    const evt = await Promise.race([
      paused,
      new Promise((_, rej) => setTimeout(() => rej(new Error('pause-timeout')), 15000)),
    ]).catch(e => null);
    if (evt) {
      console.log('--- top 25 frames ---');
      for (const f of evt.callFrames.slice(0, 25)) {
        console.log(`${f.functionName || '(anon)'}  @ ${f.url.split('/').pop()}:${f.location.lineNumber}`);
      }
    } else {
      console.log('Debugger.pause did not trigger (wasm busy loop without JS re-entry)');
    }
  }

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
