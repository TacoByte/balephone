const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let nextPort = Number(process.env.TEST_PORT || 18800);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForEvent(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${event} timed out`));
    }, timeoutMs);
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timeout);
      emitter.off(event, onEvent);
      if (event !== 'error') emitter.off('error', onError);
    }
    emitter.once(event, onEvent);
    if (event !== 'error') emitter.once('error', onError);
  });
}

async function startRelay(settings = {}) {
  const port = nextPort++;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      SHUTDOWN_GRACE_MS: '500',
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 5000;
  while (!output.includes('"event":"relay listening"')) {
    if (child.exitCode !== null) {
      throw new Error(`relay exited during startup (${child.exitCode})\n${output}`);
    }
    if (Date.now() >= deadline) {
      child.kill('SIGKILL');
      await waitForEvent(child, 'exit', 1000).catch(() => {});
      throw new Error(`relay startup timed out\n${output}`);
    }
    await delay(10);
  }

  return {
    child,
    output: () => output,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
}

async function stopRelay(relay) {
  if (!relay || relay.child.exitCode !== null) return;
  const exited = waitForEvent(relay.child, 'exit', 3000);
  relay.child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.strictEqual(signal, null, relay.output());
  assert.strictEqual(code, 0, relay.output());
}

function request(relay, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port: relay.port,
      path: pathname,
      headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body,
      }));
      response.once('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP request timed out')));
    req.once('error', reject);
  });
}

function openSocket(relay, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay.wsUrl, options);
    const timeout = setTimeout(() => {
      // Aborting a CONNECTING ws emits an error; keep a listener through it.
      ws.once('error', () => {});
      ws.terminate();
      cleanup();
      reject(new Error('WebSocket open timed out'));
    }, 3000);
    ws.once('open', () => {
      cleanup();
      resolve(ws);
    });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      response.resume();
      const error = new Error(`WebSocket upgrade rejected with ${response.statusCode}`);
      error.statusCode = response.statusCode;
      reject(error);
    });
    ws.once('error', onError);

    function onError(error) {
      cleanup();
      reject(error);
    }
    function cleanup() {
      clearTimeout(timeout);
      ws.off('error', onError);
    }
  });
}

function rejectedUpgrade(relay, options) {
  return openSocket(relay, options).then(
    (ws) => {
      ws.close();
      throw new Error('WebSocket upgrade unexpectedly succeeded');
    },
    (error) => error.statusCode,
  );
}

function nextFrame(ws, timeoutMs = 3000) {
  return waitForEvent(ws, 'message', timeoutMs)
    .then(([data]) => Buffer.from(data));
}

function nextClose(ws, timeoutMs = 3000) {
  return waitForEvent(ws, 'close', timeoutMs)
    .then(([code, reason]) => ({ code, reason: reason.toString('utf8') }));
}

function helloFrame(create, code = '') {
  const room = Buffer.from(code, 'utf8');
  return Buffer.concat([Buffer.from([0x01, create ? 1 : 0, room.length]), room]);
}

async function connect(relay, create, code = '') {
  const ws = await openSocket(relay);
  const response = nextFrame(ws);
  ws.send(helloFrame(create, code));
  const frame = await response;
  assert.strictEqual(frame[0], 0x81, `expected WELCOME, got ${frame[0]}`);
  return {
    ws,
    id: frame[1],
    code: frame.subarray(3, 3 + frame[2]).toString('utf8'),
  };
}

async function waitForHealth(relay, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await request(relay, '/healthz');
    const health = JSON.parse(response.body);
    if (predicate(health)) return health;
    await delay(25);
  }
  throw new Error('health state did not reach expected value');
}

async function testProtocolAndLifecycle() {
  const relay = await startRelay({
    ALLOWED_ORIGINS: 'https://game.example',
    HELLO_TIMEOUT_MS: '100',
    MAX_FRAME_BYTES: '1024',
  });

  try {
    const healthResponse = await request(relay, '/healthz');
    assert.strictEqual(healthResponse.status, 200);
    assert.deepStrictEqual(
      Object.keys(JSON.parse(healthResponse.body)).sort(),
      ['connections', 'publicRooms', 'rooms', 'status', 'uptimeSeconds'].sort(),
    );

    const deniedHttp = await request(relay, '/v1/rooms', {
      Origin: 'https://evil.example',
    });
    assert.strictEqual(deniedHttp.status, 403);
    assert.strictEqual(
      await rejectedUpgrade(relay, { origin: 'https://evil.example' }),
      403,
    );

    const silent = await openSocket(relay);
    const silentClose = nextClose(silent);
    assert.deepStrictEqual(await silentClose, { code: 1008, reason: 'HELLO timeout' });

    const malformed = await openSocket(relay);
    const malformedReply = nextFrame(malformed);
    const malformedClose = nextClose(malformed);
    malformed.send(Buffer.from([0x01, 0x00, 0x04, 0x41]));
    assert.deepStrictEqual(await malformedReply, Buffer.from([0x87, 0x03]));
    assert.strictEqual((await malformedClose).code, 1008);

    const oversized = await openSocket(relay);
    const oversizedClose = nextClose(oversized);
    oversized.send(Buffer.alloc(1025, 0x04));
    assert.strictEqual((await oversizedClose).code, 1009);

    const gatherer = await connect(relay, true);
    const joiner = await connect(relay, false, gatherer.code);
    const attacker = await connect(relay, false, gatherer.code);
    assert.strictEqual(gatherer.id, 1);
    assert.strictEqual(joiner.id, 2);
    assert.strictEqual(attacker.id, 3);

    const streamId = (joiner.id << 20) | 1;
    const open = Buffer.alloc(8);
    open[0] = 0x03;
    open.writeUInt32BE(streamId, 1);
    open[5] = gatherer.id;
    open.writeUInt16BE(4226, 6);
    const incomingOpen = nextFrame(gatherer.ws);
    joiner.ws.send(open);
    assert.strictEqual((await incomingOpen)[0], 0x83);

    let injected = false;
    const trackInjection = (data) => {
      if (Buffer.from(data)[0] === 0x84) injected = true;
    };
    gatherer.ws.on('message', trackInjection);
    const attackerReply = nextFrame(attacker.ws);
    const attackerClose = nextClose(attacker.ws);
    const forgedData = Buffer.alloc(6);
    forgedData[0] = 0x04;
    forgedData.writeUInt32BE(streamId, 1);
    forgedData[5] = 0xaa;
    attacker.ws.send(forgedData);
    assert.deepStrictEqual(await attackerReply, Buffer.from([0x87, 0x03]));
    assert.strictEqual((await attackerClose).code, 1008);
    await delay(50);
    gatherer.ws.off('message', trackInjection);
    assert.strictEqual(injected, false, 'unrelated member injected stream data');

    const legitimateData = Buffer.from(forgedData);
    legitimateData[5] = 0xbb;
    const incomingData = nextFrame(gatherer.ws);
    joiner.ws.send(legitimateData);
    const relayed = await incomingData;
    assert.strictEqual(relayed[0], 0x84);
    assert.strictEqual(relayed[5], 0xbb);

    const joinerClose = nextClose(joiner.ws);
    gatherer.ws.close();
    assert.strictEqual((await joinerClose).code, 1012);
    await waitForHealth(relay, (health) => health.rooms === 0);
  } finally {
    await stopRelay(relay);
  }
}

async function testRoomAndConnectionCaps() {
  const roomRelay = await startRelay({
    MAX_ROOMS: '1',
    MAX_ROOMS_PER_IP: '1',
  });
  try {
    const first = await connect(roomRelay, true);
    const second = await openSocket(roomRelay);
    const reply = nextFrame(second);
    const secondClose = nextClose(second);
    second.send(helloFrame(true));
    assert.deepStrictEqual(await reply, Buffer.from([0x87, 0x02]));
    await secondClose;

    const members = [first];
    for (let i = 0; i < 7; i++) {
      members.push(await connect(roomRelay, false, first.code));
    }
    assert.strictEqual(members[7].id, 8);

    const overflow = await openSocket(roomRelay);
    const overflowReply = nextFrame(overflow);
    const overflowClose = nextClose(overflow);
    overflow.send(helloFrame(false, first.code));
    assert.deepStrictEqual(await overflowReply, Buffer.from([0x87, 0x02]));
    await overflowClose;

    first.ws.close();
  } finally {
    await stopRelay(roomRelay);
  }

  const connectionRelay = await startRelay({
    MAX_CONNECTIONS: '2',
    MAX_CONNECTIONS_PER_IP: '1',
  });
  try {
    const first = await openSocket(connectionRelay);
    assert.strictEqual(await rejectedUpgrade(connectionRelay), 429);
    first.close();
  } finally {
    await stopRelay(connectionRelay);
  }
}

async function testRejectedRequestLimits() {
  const relay = await startRelay({
    ALLOWED_ORIGINS: 'https://game.example',
    MAX_CONNECTION_ATTEMPTS_PER_MINUTE: '1',
    MAX_HTTP_REQUESTS_PER_MINUTE: '1',
  });
  try {
    const headers = { Origin: 'https://evil.example' };
    assert.strictEqual((await request(relay, '/v1/rooms', headers)).status, 403);
    assert.strictEqual((await request(relay, '/v1/rooms', headers)).status, 429);

    assert.strictEqual(await rejectedUpgrade(relay, { origin: headers.Origin }), 403);
    assert.strictEqual(await rejectedUpgrade(relay, { origin: headers.Origin }), 429);
  } finally {
    await stopRelay(relay);
  }
}

async function testTrafficLimit() {
  const relay = await startRelay({
    MAX_FRAMES_PER_SECOND: '3',
  });
  try {
    const gatherer = await connect(relay, true);
    const closed = nextClose(gatherer.ws);
    const datagram = Buffer.from([0x02, 0xff, 0x10, 0x82]);
    for (let i = 0; i < 10; i++) gatherer.ws.send(datagram);
    assert.deepStrictEqual(await closed, { code: 1008, reason: 'traffic limit' });
  } finally {
    await stopRelay(relay);
  }
}

(async () => {
  await testProtocolAndLifecycle();
  await testRoomAndConnectionCaps();
  await testRejectedRequestLimits();
  await testTrafficLimit();
  console.log('relay hardening tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
