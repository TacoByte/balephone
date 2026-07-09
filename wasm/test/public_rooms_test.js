const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const BUILD_DIR = path.resolve(__dirname, '../build');
const RELAY_DIR = path.resolve(__dirname, '../relay');
const WEB_PORT = 8792;
const RELAY_PORT = 18788;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

function startWebServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const requested = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const file = path.join(BUILD_DIR, requested);
      fs.readFile(file, (error, data) => {
        if (error) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startRelay() {
  const relay = spawn(process.execPath, [path.join(RELAY_DIR, 'server.js')], {
    env: { ...process.env, PORT: String(RELAY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay startup timed out')), 5000);
    relay.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('relay listening')) {
        clearTimeout(timeout);
        resolve(relay);
      }
    });
    relay.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`relay exited during startup (${code})`));
    });
  });
}

function getRooms() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${RELAY_PORT}/v1/rooms`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          assert.strictEqual(response.statusCode, 200);
          resolve(JSON.parse(body).rooms);
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function waitForRooms(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rooms = await getRooms();
    if (predicate(rooms)) return rooms;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('public room list did not reach expected state');
}

async function clickCanvas(page, fx, fy, wait = 1200) {
  const box = await (await page.$('canvas')).boundingBox();
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  await page.waitForTimeout(wait);
}

function gameUrl(extra = '') {
  const query = new URLSearchParams({
    scenario: 'marathon2',
    relay: `ws://127.0.0.1:${RELAY_PORT}`,
    relay_http: `http://127.0.0.1:${RELAY_PORT}`,
  });
  if (extra) query.set('join', extra);
  return `http://127.0.0.1:${WEB_PORT}/index.html?${query}`;
}

(async () => {
  let relay;
  let web;
  let browser;

  try {
    [relay, web] = await Promise.all([startRelay(), startWebServer(WEB_PORT)]);
    browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });

    const contextA = await browser.newContext({ viewport: { width: 1440, height: 810 } });
    const pageA = await contextA.newPage();
    await pageA.goto(gameUrl(), { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(14000);

    await pageA.evaluate(async () => {
      const M = window.__module;
      const prefsPath = '/home/web_user/.alephone/Marathon 2 Preferences';
      let text = M.FS.readFile(prefsPath, { encoding: 'utf8' });
      text = text.replace(/name="[^"]*"/, 'name="Gatherer"');
      text = text.replace(/autogather="[^"]*"/, 'autogather="true"');
      text = text.replace(
        /advertise_on_metaserver="[^"]*"/,
        'advertise_on_metaserver="true"',
      );
      M.FS.writeFile(prefsPath, text);
      await new Promise((resolve, reject) => {
        M.FS.syncfs(false, (error) => error ? reject(error) : resolve());
      });
    });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(14000);

    await clickCanvas(pageA, 0.185, 0.575); // Gather Network Game
    await pageA.screenshot({ path: 'public_setup.png' });
    await clickCanvas(pageA, 0.44, 0.82); // setup: OK

    await pageA.waitForFunction(
      () => window.__module && /^[A-HJ-NP-Z2-9]{4}$/.test(window.__module.__a1RoomCode || ''),
      null,
      { timeout: 5000 },
    );
    const roomCode = await pageA.evaluate(() => window.__module.__a1RoomCode);
    const listed = await waitForRooms((rooms) => rooms.some((room) => room.code === roomCode));
    const room = listed.find((item) => item.code === roomCode);
    assert.strictEqual(room.host, 'Gatherer');
    assert.strictEqual(room.name, "Gatherer's Game");
    assert.strictEqual(room.members, 1);
    assert(room.map, 'public room must include its map name');
    assert(room.scenarioID, 'public room must include its scenario ID');
    await pageA.screenshot({ path: 'public_gather.png' });

    const contextB = await browser.newContext({ viewport: { width: 1440, height: 810 } });
    const pageB = await contextB.newPage();
    const runtimeErrors = [];
    pageB.on('pageerror', (error) => {
      if (!error.message.includes('not valid for pointer lock')) {
        runtimeErrors.push(error.message);
      }
    });
    await pageB.goto(gameUrl('ZZZZ'), { waitUntil: 'domcontentloaded' });
    await pageB.waitForTimeout(16000);
    await pageB.screenshot({ path: 'public_join_list.png' });

    await clickCanvas(pageB, 0.5, 0.34, 500); // first public-room row
    await pageB.screenshot({ path: 'public_join_selected.png' });
    await clickCanvas(pageB, 0.5, 0.613); // JOIN
    await pageB.waitForFunction(
      (expected) => window.__module && window.__module.__a1RoomCode === expected,
      roomCode,
      { timeout: 8000 },
    );

    await waitForRooms((rooms) => {
      const match = rooms.find((item) => item.code === roomCode);
      return match && match.members === 2;
    });
    await pageA.screenshot({ path: 'public_gather_joiner.png' });
    assert.deepStrictEqual(runtimeErrors, []);

    await clickCanvas(pageA, 0.44, 0.618); // gather dialog: PLAY
    await waitForRooms((rooms) => !rooms.some((item) => item.code === roomCode));

    console.log(`public room UI test passed (${roomCode})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (web) web.close();
    if (relay) relay.kill();
  }
})().catch((error) => {
  console.error('TEST ERROR:', error);
  process.exit(1);
});
