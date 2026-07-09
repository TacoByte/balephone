// Two-browser multiplayer test: gatherer + joiner over the WebSocket relay.
// Steps are CLI args applied to page A (a:...) or B (b:...):
//   c:fx,fy  click at canvas fraction     k:Key   press key
//   t:text   type text                    w:ms    wait
//   s:name   screenshot                   r:      read room code from DOM
// Example: node netgame_test.js "a:c:0.265,0.575" "a:s:1_setup"
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

let roomCode = ''; // captured by r: step, substituted for "%ROOM%" in t: steps

async function applyStep(page, who, step, logs) {
  const [op, ...rest] = step.split(':');
  const arg = rest.join(':');
  if (op === 'c') {
    const [fx, fy] = arg.split(',').map(Number);
    const box = await (await page.$('canvas')).boundingBox();
    await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
    await page.waitForTimeout(1200);
  } else if (op === 'k') {
    await page.keyboard.press(arg);
    await page.waitForTimeout(500);
  } else if (op === 't') {
    const text = arg.replace('%ROOM%', roomCode);
    await page.keyboard.type(text, { delay: 60 });
    await page.waitForTimeout(400);
  } else if (op === 'w') {
    await page.waitForTimeout(Number(arg));
  } else if (op === 's') {
    await page.screenshot({ path: `net_${who}_${arg}.png`, timeout: 8000 })
      .catch(() => console.log(`SCREENSHOT TIMEOUT ${who}:${arg}`));
  } else if (op === 'r') {
    roomCode = await page.evaluate(() => window.__module && window.__module.__a1RoomCode || '');
    console.log(`room code from ${who}: "${roomCode}"`);
  }
}

(async () => {
  const steps = process.argv.slice(2);
  const server = await startServer(8790);
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });

  const pages = {};
  const logs = { a: [], b: [] };
  for (const who of ['a', 'b']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 810 },
    });
    const page = await context.newPage();
    page.on('console', (m) => logs[who].push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs[who].push(`[pageerror] ${e.message}`));
    page.on('crash', () => logs[who].push('[CRASH]'));
    pages[who] = page;
  }

  // Boot both in parallel.
  await Promise.all([
    pages.a.goto('http://127.0.0.1:8790/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' }),
    pages.b.goto('http://127.0.0.1:8790/index.html?scenario=marathon2', { waitUntil: 'domcontentloaded' }),
  ]);
  await pages.a.waitForTimeout(14000);

  // Gatherer (A): autogather so joiners are added without clicks; both: names.
  for (const [who, name, extra] of [['a', 'Gatherer', 'autogather="true"'], ['b', 'Joiner', '']]) {
    const res = await pages[who].evaluate(async ({ name, extra }) => {
      const M = window.__module;
      const p = '/home/web_user/.alephone/Marathon 2 Preferences';
      let txt = M.FS.readFile(p, { encoding: 'utf8' });
      txt = txt.replace(/name="[^"]*"/, `name="${name}"`);
      if (extra) txt = txt.replace(/autogather="false"/, extra);
      M.FS.writeFile(p, txt);
      await new Promise((res, rej) => M.FS.syncfs(false, (e) => e ? rej(e) : res()));
      return 'ok';
    }, { name, extra }).catch(e => 'ERR ' + e.message);
    if (res !== 'ok') console.log(`prefs ${who}: ${res}`);
  }

  await Promise.all([
    pages.a.reload({ waitUntil: 'domcontentloaded' }),
    pages.b.reload({ waitUntil: 'domcontentloaded' }),
  ]);
  await pages.a.waitForTimeout(14000);

  for (const step of steps) {
    const who = step[0];
    if (who === 'p') { // p: = run steps for a and b in parallel, separated by |
      const [sa, sb] = step.slice(2).split('|');
      await Promise.all([
        sa ? applyStep(pages.a, 'a', sa, logs) : null,
        sb ? applyStep(pages.b, 'b', sb, logs) : null,
      ]);
    } else {
      await applyStep(pages[who], who, step.slice(2), logs);
    }
  }

  fs.writeFileSync('net_a.log', logs.a.join('\n'));
  fs.writeFileSync('net_b.log', logs.b.join('\n'));

  await browser.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
