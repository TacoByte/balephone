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
const REMOTE = Boolean(process.env.GAME_ORIGIN);
const GAME_ORIGIN = (process.env.GAME_ORIGIN || `http://127.0.0.1:${WEB_PORT}`)
  .replace(/\/+$/, '');
const RELAY_WS_URL = process.env.RELAY_WS_URL || `ws://127.0.0.1:${RELAY_PORT}`;
const RELAY_HTTP_URL = (process.env.RELAY_HTTP_URL || `http://127.0.0.1:${RELAY_PORT}`)
  .replace(/\/+$/, '');
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

async function getRooms() {
  const response = await fetch(`${RELAY_HTTP_URL}/v1/rooms`, {
    headers: { Origin: GAME_ORIGIN },
    cache: 'no-store',
  });
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  return body.rooms;
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
    relay: RELAY_WS_URL,
    relay_http: RELAY_HTTP_URL,
  });
  if (extra) query.set('join', extra);
  return `${GAME_ORIGIN}/index.html?${query}`;
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const M = window.__module;
      if (!M || !M.FS) return false;
      try {
        return M.FS.analyzePath(
          '/home/web_user/.alephone/Marathon 2 Preferences',
        ).exists;
      } catch (_) {
        return false;
      }
    },
    null,
    { timeout: REMOTE ? 90000 : 30000 },
  );
  // Preferences are created before the engine finishes drawing and accepting
  // input on its main menu, especially when scenario assets come from a CDN.
  await page.waitForTimeout(8000);
}

(async () => {
  let relay;
  let web;
  let browser;

  try {
    if (REMOTE) {
      console.log(`testing ${GAME_ORIGIN} with relay ${RELAY_HTTP_URL}`);
    } else {
      [relay, web] = await Promise.all([startRelay(), startWebServer(WEB_PORT)]);
    }
    browser = await chromium.launch({
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });

    const contextA = await browser.newContext({ viewport: { width: 1440, height: 810 } });
    const pageA = await contextA.newPage();
    await boot(pageA, gameUrl());

    const advertisesByDefault = await pageA.evaluate(() => {
      const M = window.__module;
      const prefsPath = '/home/web_user/.alephone/Marathon 2 Preferences';
      const text = M.FS.readFile(prefsPath, { encoding: 'utf8' });
      return /advertise_on_metaserver="true"/.test(text);
    });
    assert(advertisesByDefault, 'browser rooms must advertise publicly by default');

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
    await boot(pageA, gameUrl());

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

    // Browser room codes must not leak from an earlier session into the
    // ordinary join dialog.
    await boot(pageB, gameUrl());
    const seededStaleCode = await pageB.evaluate(async () => {
      const M = window.__module;
      const prefsPath = '/home/web_user/.alephone/Marathon 2 Preferences';
      let text = M.FS.readFile(prefsPath, { encoding: 'utf8' });
      const updated = text.replace(/join_address="[^"]*"/, 'join_address="ABCD"');
      if (updated === text) return false;
      M.FS.writeFile(prefsPath, updated);
      await new Promise((resolve, reject) => {
        M.FS.syncfs(false, (error) => error ? reject(error) : resolve());
      });
      return true;
    });
    assert(seededStaleCode, 'test could not seed a stale room code');
    await boot(pageB, gameUrl());
    await clickCanvas(pageB, 0.209, 0.662); // Join Network Game
    await pageB.screenshot({ path: 'public_join_empty.png' });
    await clickCanvas(pageB, 0.5, 0.613, 500); // disabled JOIN
    assert.strictEqual(
      await pageB.evaluate(() => window.__module && window.__module.__a1RoomCode || ''),
      '',
      'empty join dialog unexpectedly attempted a relay connection',
    );

    // A share link should prefill the room code and visibly select the
    // matching public room without requiring a list click.
    await boot(pageB, gameUrl(roomCode));
    await pageB.screenshot({ path: 'public_join_list.png' });

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
