const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT || 18787);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay startup timed out')), 5000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('relay listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`relay exited during startup (${code})`));
    });
  });
}

function getRooms() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/v1/rooms`, (response) => {
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

function connect(create, code = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => reject(new Error('WELCOME timed out')), 3000);
    ws.once('open', () => {
      const room = Buffer.from(code, 'utf8');
      ws.send(Buffer.concat([Buffer.from([0x01, create ? 1 : 0, room.length]), room]));
    });
    ws.once('message', (data) => {
      clearTimeout(timeout);
      const frame = Buffer.from(data);
      if (frame[0] === 0x87) {
        reject(new Error(`relay error ${frame[1]}`));
        return;
      }
      assert.strictEqual(frame[0], 0x81);
      resolve({
        ws,
        id: frame[1],
        code: frame.subarray(3, 3 + frame[2]).toString('utf8'),
      });
    });
    ws.once('error', reject);
  });
}

async function waitForRooms(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rooms = await getRooms();
    if (predicate(rooms)) return rooms;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('room listing did not reach expected state');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];

  try {
    await waitForServer(child);

    const gatherer = await connect(true);
    clients.push(gatherer.ws);
    assert.match(gatherer.code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.deepStrictEqual(await getRooms(), [], 'new rooms must be unlisted');

    const metadata = {
      name: "Alice's Game",
      host: 'Alice',
      map: 'Thunderdome',
      gameType: 2,
      difficulty: 3,
      scenarioID: 'marathon2',
      scenarioName: 'Marathon 2',
      scenarioVersion: '1.0',
    };
    gatherer.ws.send(Buffer.concat([
      Buffer.from([0x06]),
      Buffer.from(JSON.stringify(metadata), 'utf8'),
    ]));

    let rooms = await waitForRooms((items) => items.length === 1);
    assert.deepStrictEqual(rooms[0], {
      code: gatherer.code,
      members: 1,
      maxPlayers: 8,
      ...metadata,
      updatedAt: rooms[0].updatedAt,
    });
    assert(Number.isFinite(rooms[0].updatedAt));

    const joiner = await connect(false, gatherer.code);
    clients.push(joiner.ws);
    assert.strictEqual(joiner.id, 2);
    rooms = await waitForRooms((items) => items[0] && items[0].members === 2);
    assert.strictEqual(rooms[0].code, gatherer.code);

    gatherer.ws.send(Buffer.from([0x07]));
    await waitForRooms((items) => items.length === 0);

    // Unlisting affects discovery only; the code remains joinable.
    const secondJoiner = await connect(false, gatherer.code);
    clients.push(secondJoiner.ws);
    assert.strictEqual(secondJoiner.id, 3);

    gatherer.ws.send(Buffer.concat([
      Buffer.from([0x06]),
      Buffer.from(JSON.stringify(metadata), 'utf8'),
    ]));
    await waitForRooms((items) => items.length === 1);
    gatherer.ws.close();
    await waitForRooms((items) => items.length === 0);

    console.log('public relay room tests passed');
  } finally {
    for (const ws of clients) {
      try { ws.close(); } catch (_) {}
    }
    child.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
