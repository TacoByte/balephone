#!/usr/bin/env node
/*
 * Aleph One web relay - rooms + message routing, knows nothing about the game.
 *
 * Browser clients connect one WebSocket each. The first member of a room
 * (its creator, the gatherer) is member 1 and acts as the game's hub; the
 * relay just forwards datagram frames and byte-stream frames between members.
 *
 * Frames (binary, big-endian) — must match wasm/config/net_relay.cpp:
 *   client -> relay
 *     0x01 HELLO  [u8 create][u8 roomLen][room utf8]
 *     0x02 DGRAM  [u8 dest][u16 port][payload]
 *     0x03 OPEN   [u32 stream][u8 dest][u16 port]
 *     0x04 DATA   [u32 stream][payload]
 *     0x05 CLOSE  [u32 stream]
 *     0x06 PUBLISH [JSON metadata, creator only]
 *     0x07 UNLIST  []
 *   relay -> client
 *     0x81 WELCOME   [u8 yourId][u8 roomLen][room utf8]
 *     0x82 DGRAM     [u8 src][u16 port][payload]
 *     0x83 OPEN      [u32 stream][u8 src][u16 port]
 *     0x84 DATA      [u32 stream][payload]
 *     0x85 CLOSE     [u32 stream]
 *     0x86 PEER_LEFT [u8 id]
 *     0x87 ERROR     [u8 code]   1=no such room, 2=room full, 3=bad frame
 */

const crypto = require('crypto');
const http = require('http');
const { WebSocket, WebSocketServer } = require('ws');

function integerSetting(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const PORT = integerSetting('PORT', 8787, { max: 65535 });
const MAX_MEMBERS = 8;
const MAX_CONNECTIONS = integerSetting('MAX_CONNECTIONS', 256);
const MAX_CONNECTIONS_PER_IP = integerSetting('MAX_CONNECTIONS_PER_IP', 16);
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE =
  integerSetting('MAX_CONNECTION_ATTEMPTS_PER_MINUTE', 60);
const MAX_HTTP_REQUESTS_PER_MINUTE =
  integerSetting('MAX_HTTP_REQUESTS_PER_MINUTE', 600);
const MAX_ROOMS = integerSetting('MAX_ROOMS', 64);
const MAX_ROOMS_PER_IP = integerSetting('MAX_ROOMS_PER_IP', 4);
const MAX_STREAMS_PER_ROOM = integerSetting('MAX_STREAMS_PER_ROOM', 512);
const MAX_FRAME_BYTES = integerSetting('MAX_FRAME_BYTES', (4 * 1024 * 1024) + 5, {
  min: 64,
  max: 16 * 1024 * 1024,
});
const MAX_DGRAM_BYTES = integerSetting('MAX_DGRAM_BYTES', 1504, {
  min: 4,
  max: MAX_FRAME_BYTES,
});
const MAX_BUFFERED_BYTES = integerSetting('MAX_BUFFERED_BYTES', 16 * 1024 * 1024, {
  min: MAX_FRAME_BYTES,
  max: 64 * 1024 * 1024,
});
const MAX_TOTAL_BUFFERED_BYTES =
  integerSetting('MAX_TOTAL_BUFFERED_BYTES', 64 * 1024 * 1024, {
    min: MAX_BUFFERED_BYTES,
    max: 512 * 1024 * 1024,
  });
const MAX_FRAMES_PER_SECOND = integerSetting('MAX_FRAMES_PER_SECOND', 1000);
const MAX_BYTES_PER_SECOND = integerSetting('MAX_BYTES_PER_SECOND', 8 * 1024 * 1024, {
  min: MAX_FRAME_BYTES,
});
const MAX_TOTAL_FRAMES_PER_SECOND =
  integerSetting('MAX_TOTAL_FRAMES_PER_SECOND', 20000, {
    min: MAX_FRAMES_PER_SECOND,
  });
const MAX_TOTAL_BYTES_PER_SECOND =
  integerSetting('MAX_TOTAL_BYTES_PER_SECOND', 64 * 1024 * 1024, {
    min: MAX_BYTES_PER_SECOND,
  });
const HELLO_TIMEOUT_MS = integerSetting('HELLO_TIMEOUT_MS', 10000, { min: 50 });
const HEARTBEAT_INTERVAL_MS = integerSetting('HEARTBEAT_INTERVAL_MS', 30000, { min: 100 });
const POLICY_CLOSE_GRACE_MS = integerSetting('POLICY_CLOSE_GRACE_MS', 1000, { min: 50 });
const SHUTDOWN_GRACE_MS = integerSetting('SHUTDOWN_GRACE_MS', 5000, { min: 100 });
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.RENDER === 'true';
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}$/;

const rooms = new Map();
const connectionsByIp = new Map();
const connectionAttemptsByIp = new Map();
const httpRequestsByIp = new Map();
let totalTraffic = { startedAt: Date.now(), frames: 0, bytes: 0 };
let shuttingDown = false;

function log(event, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
  }));
}

function clientIp(request) {
  let address = request.socket.remoteAddress || 'unknown';
  const forwarded = request.headers['x-forwarded-for'];
  if (TRUST_PROXY && typeof forwarded === 'string' && forwarded) {
    const hops = forwarded.split(',');
    address = hops[hops.length - 1];
  }
  return address.trim().replace(/^::ffff:/, '').slice(0, 128);
}

function originAllowed(origin) {
  return !origin || ALLOWED_ORIGINS.size === 0 || ALLOWED_ORIGINS.has(origin);
}

function applyHttpHeaders(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  const origin = request.headers.origin;
  if (originAllowed(origin)) {
    response.setHeader(
      'Access-Control-Allow-Origin',
      ALLOWED_ORIGINS.size === 0 ? '*' : (origin || 'null'),
    );
    if (ALLOWED_ORIGINS.size > 0) response.setHeader('Vary', 'Origin');
  }
}

function consumeFixedWindow(store, key, limit, durationMs) {
  const now = Date.now();
  let state = store.get(key);
  if (!state || now - state.startedAt >= durationMs) {
    state = { startedAt: now, count: 0 };
    store.set(key, state);
  }
  state.count++;
  return state.count <= limit;
}

function countRoomsForIp(ip) {
  let count = 0;
  for (const room of rooms.values()) {
    if (room.creatorIp === ip) count++;
  }
  return count;
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function safeSend(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  let totalBuffered = 0;
  for (const client of wss.clients) totalBuffered += client.bufferedAmount;
  if (ws.bufferedAmount + data.length > MAX_BUFFERED_BYTES
      || totalBuffered + data.length > MAX_TOTAL_BUFFERED_BYTES) {
    log('connection_backpressure_limit', { ip: ws.relayIp });
    closeWithDeadline(ws, 1008, 'backpressure limit');
    return false;
  }

  try {
    ws.send(data, { binary: true });
    return true;
  } catch (_) {
    ws.terminate();
    return false;
  }
}

function closeWithDeadline(ws, code, reason) {
  if (ws.closeDeadline) return;
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  else ws.terminate();

  ws.closeDeadline = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, POLICY_CLOSE_GRACE_MS);
  ws.closeDeadline.unref();
  ws.once('close', () => clearTimeout(ws.closeDeadline));
}

function sendError(ws, code) {
  safeSend(ws, Buffer.from([0x87, code]));
  closeWithDeadline(ws, 1008, 'relay protocol error');
}

function sendWelcome(ws, id, room) {
  const roomBuf = Buffer.from(room, 'utf8');
  safeSend(ws, Buffer.concat([Buffer.from([0x81, id, roomBuf.length]), roomBuf]));
}

function cleanString(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function boundedInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(65535, Math.trunc(parsed)));
}

function publicRoom(room) {
  return {
    code: room.code,
    members: room.members.size,
    maxPlayers: MAX_MEMBERS,
    name: room.metadata.name,
    host: room.metadata.host,
    map: room.metadata.map,
    gameType: room.metadata.gameType,
    difficulty: room.metadata.difficulty,
    scenarioID: room.metadata.scenarioID,
    scenarioName: room.metadata.scenarioName,
    scenarioVersion: room.metadata.scenarioVersion,
    updatedAt: room.updatedAt,
  };
}

function publishRoom(room, data) {
  let metadata;
  try {
    metadata = JSON.parse(data.slice(1).toString('utf8'));
  } catch (_) {
    return false;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;

  room.metadata = {
    name: cleanString(metadata.name, 64) || 'Untitled Game',
    host: cleanString(metadata.host, 32),
    map: cleanString(metadata.map, 64) || 'Unspecified Map',
    gameType: boundedInteger(metadata.gameType),
    difficulty: boundedInteger(metadata.difficulty),
    scenarioID: cleanString(metadata.scenarioID, 64),
    scenarioName: cleanString(metadata.scenarioName, 64),
    scenarioVersion: cleanString(metadata.scenarioVersion, 32),
  };
  room.public = true;
  room.updatedAt = Date.now();
  return true;
}

const server = http.createServer({
  maxHeaderSize: 16 * 1024,
  requestTimeout: 5000,
  headersTimeout: 5000,
  keepAliveTimeout: 5000,
}, (req, res) => {
  applyHttpHeaders(req, res);

  const ip = clientIp(req);
  if (!consumeFixedWindow(httpRequestsByIp, ip, MAX_HTTP_REQUESTS_PER_MINUTE, 60000)) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '60',
    });
    res.end(JSON.stringify({ error: 'rate limit exceeded' }));
    return;
  }

  if (!originAllowed(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'origin not allowed' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'bad request' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const publicRooms = Array.from(rooms.values())
      .filter((room) => room.public && room.metadata && room.members.has(1)).length;
    res.writeHead(shuttingDown ? 503 : 200, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({
      status: shuttingDown ? 'draining' : 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      connections: wss.clients.size,
      rooms: rooms.size,
      publicRooms,
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/rooms') {
    const listing = Array.from(rooms.values())
      .filter((room) => room.public && room.metadata && room.members.has(1))
      .map(publicRoom)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ rooms: listing }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BYTES,
  perMessageDeflate: false,
});

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + '\r\n'
    + body,
  );
}

server.on('upgrade', (request, socket, head) => {
  const ip = clientIp(request);
  request.relayIp = ip;

  if (shuttingDown) {
    rejectUpgrade(socket, '503 Service Unavailable', 'relay is restarting');
    return;
  }
  if (!consumeFixedWindow(
    connectionAttemptsByIp,
    ip,
    MAX_CONNECTION_ATTEMPTS_PER_MINUTE,
    60000,
  )) {
    rejectUpgrade(socket, '429 Too Many Requests', 'connection rate exceeded');
    return;
  }
  if (!originAllowed(request.headers.origin)) {
    rejectUpgrade(socket, '403 Forbidden', 'origin not allowed');
    return;
  }
  if (wss.clients.size >= MAX_CONNECTIONS) {
    rejectUpgrade(socket, '503 Service Unavailable', 'relay is full');
    return;
  }
  if ((connectionsByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
    rejectUpgrade(socket, '429 Too Many Requests', 'connection limit exceeded');
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function withinTrafficLimit(ws, bytes) {
  const now = Date.now();
  if (now - ws.traffic.startedAt >= 1000) {
    ws.traffic = { startedAt: now, frames: 0, bytes: 0 };
  }
  if (now - totalTraffic.startedAt >= 1000) {
    totalTraffic = { startedAt: now, frames: 0, bytes: 0 };
  }
  ws.traffic.frames++;
  ws.traffic.bytes += bytes;
  totalTraffic.frames++;
  totalTraffic.bytes += bytes;

  if (ws.traffic.frames <= MAX_FRAMES_PER_SECOND
      && ws.traffic.bytes <= MAX_BYTES_PER_SECOND
      && totalTraffic.frames <= MAX_TOTAL_FRAMES_PER_SECOND
      && totalTraffic.bytes <= MAX_TOTAL_BYTES_PER_SECOND) {
    return true;
  }

  log('connection_traffic_limit', {
    ip: ws.relayIp,
    frames: ws.traffic.frames,
    bytes: ws.traffic.bytes,
    totalFrames: totalTraffic.frames,
    totalBytes: totalTraffic.bytes,
  });
  closeWithDeadline(ws, 1008, 'traffic limit');
  return false;
}

function badFrame(ws, reason) {
  log('bad_frame', { ip: ws.relayIp, reason });
  sendError(ws, 3);
}

wss.on('connection', (ws, request) => {
  let room = null;
  let myId = 0;
  let cleanedUp = false;

  ws.relayIp = request.relayIp;
  ws.isAlive = true;
  ws.traffic = { startedAt: Date.now(), frames: 0, bytes: 0 };
  connectionsByIp.set(ws.relayIp, (connectionsByIp.get(ws.relayIp) || 0) + 1);

  const helloTimeout = setTimeout(() => {
    log('hello_timeout', { ip: ws.relayIp });
    closeWithDeadline(ws, 1008, 'HELLO timeout');
  }, HELLO_TIMEOUT_MS);
  helloTimeout.unref();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (rawData, isBinary) => {
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    if (!isBinary || data.length < 1) {
      badFrame(ws, 'binary frame required');
      return;
    }
    if (!withinTrafficLimit(ws, data.length)) return;

    const type = data[0];

    if (type === 0x01) { // HELLO
      if (room || data.length < 3) {
        badFrame(ws, 'invalid HELLO');
        return;
      }

      const createFlag = data[1];
      const nameLen = data[2];
      if ((createFlag !== 0 && createFlag !== 1) || data.length !== 3 + nameLen) {
        badFrame(ws, 'malformed HELLO');
        return;
      }

      const create = createFlag === 1;
      let code = data.subarray(3).toString('utf8').toUpperCase();
      if (code && !ROOM_CODE_PATTERN.test(code)) {
        badFrame(ws, 'invalid room code');
        return;
      }

      let selectedRoom;
      if (create) {
        if (rooms.size >= MAX_ROOMS || countRoomsForIp(ws.relayIp) >= MAX_ROOMS_PER_IP) {
          sendError(ws, 2);
          return;
        }
        code = code || makeRoomCode();
        if (rooms.has(code)) {
          sendError(ws, 2);
          return;
        }
        selectedRoom = {
          code,
          creatorIp: ws.relayIp,
          members: new Map(),
          streams: new Map(),
          public: false,
          metadata: null,
          updatedAt: Date.now(),
          closed: false,
        };
        rooms.set(code, selectedRoom);
      } else {
        selectedRoom = rooms.get(code);
        if (!selectedRoom || selectedRoom.closed) {
          sendError(ws, 1);
          return;
        }
      }

      if (selectedRoom.members.size >= MAX_MEMBERS) {
        sendError(ws, 2);
        return;
      }

      room = selectedRoom;
      myId = 1;
      while (room.members.has(myId)) myId++;
      room.members.set(myId, ws);
      room.updatedAt = Date.now();
      clearTimeout(helloTimeout);
      sendWelcome(ws, myId, code);
      log('member_joined', { room: code, member: myId, members: room.members.size });
      return;
    }

    if (!room) {
      badFrame(ws, 'HELLO required');
      return;
    }

    switch (type) {
      case 0x02: { // DGRAM [u8 dest][u16 port][payload] -> [u8 src][u16 port][payload]
        if (data.length < 4 || data.length > MAX_DGRAM_BYTES) {
          badFrame(ws, 'invalid DGRAM');
          return;
        }
        const dest = room.members.get(data[1]);
        if (!dest) return;
        const out = Buffer.from(data);
        out[0] = 0x82;
        out[1] = myId;
        safeSend(dest, out);
        break;
      }
      case 0x03: { // OPEN [u32 stream][u8 dest][u16 port]
        if (data.length !== 8) {
          badFrame(ws, 'invalid OPEN');
          return;
        }
        const streamId = data.readUInt32BE(1);
        const destId = data[5];
        const dest = room.members.get(destId);
        if (streamId === 0 || room.streams.has(streamId) || destId === myId) {
          badFrame(ws, 'invalid stream');
          return;
        }
        if (room.streams.size >= MAX_STREAMS_PER_ROOM) {
          log('room_stream_limit', { room: room.code });
          closeWithDeadline(ws, 1008, 'stream limit');
          return;
        }
        if (!dest) {
          // Peer gone: bounce a CLOSE straight back.
          const close = Buffer.alloc(5);
          close[0] = 0x85;
          close.writeUInt32BE(streamId, 1);
          safeSend(ws, close);
          return;
        }
        room.streams.set(streamId, { a: myId, b: destId });
        const out = Buffer.from(data);
        out[0] = 0x83;
        out[5] = myId; // dest sees who opened it
        safeSend(dest, out);
        break;
      }
      case 0x04:   // DATA [u32 stream][payload]
      case 0x05: { // CLOSE [u32 stream]
        if (data.length < 5 || (type === 0x05 && data.length !== 5)) {
          badFrame(ws, type === 0x04 ? 'invalid DATA' : 'invalid CLOSE');
          return;
        }
        const streamId = data.readUInt32BE(1);
        const pair = room.streams.get(streamId);
        if (!pair) return;
        if (pair.a !== myId && pair.b !== myId) {
          badFrame(ws, 'stream ownership violation');
          return;
        }
        const otherId = pair.a === myId ? pair.b : pair.a;
        const other = room.members.get(otherId);
        if (type === 0x05 || !other) room.streams.delete(streamId);
        if (!other) return;
        const out = Buffer.from(data);
        out[0] = type === 0x04 ? 0x84 : 0x85;
        safeSend(other, out);
        break;
      }
      case 0x06: { // PUBLISH [JSON metadata], creator only
        if (myId !== 1 || data.length < 2 || data.length > 4096
            || !publishRoom(room, data)) {
          badFrame(ws, 'invalid PUBLISH');
        }
        break;
      }
      case 0x07: // UNLIST, creator only
        if (myId !== 1 || data.length !== 1) {
          badFrame(ws, 'invalid UNLIST');
          return;
        }
        room.public = false;
        room.metadata = null;
        room.updatedAt = Date.now();
        break;
      default:
        badFrame(ws, 'unknown frame type');
    }
  });

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(helloTimeout);

    const remainingForIp = (connectionsByIp.get(ws.relayIp) || 1) - 1;
    if (remainingForIp > 0) connectionsByIp.set(ws.relayIp, remainingForIp);
    else connectionsByIp.delete(ws.relayIp);

    if (!room || !myId || room.members.get(myId) !== ws) return;
    room.members.delete(myId);
    room.updatedAt = Date.now();

    for (const [streamId, pair] of room.streams) {
      if (pair.a === myId || pair.b === myId) room.streams.delete(streamId);
    }
    log('member_left', {
      room: room.code,
      member: myId,
      members: room.members.size,
    });

    if (room.closed) return;

    const gone = Buffer.from([0x86, myId]);
    if (myId === 1) {
      room.closed = true;
      room.public = false;
      room.metadata = null;
      rooms.delete(room.code);
      for (const member of room.members.values()) {
        safeSend(member, gone);
        closeWithDeadline(member, 1012, 'room creator left');
      }
      log('room_closed', { room: room.code, reason: 'creator left' });
      return;
    }

    for (const member of room.members.values()) safeSend(member, gone);
    if (room.members.size === 0) {
      rooms.delete(room.code);
      log('room_closed', { room: room.code, reason: 'empty' });
    }
  }

  ws.on('close', cleanup);
  ws.on('error', (error) => {
    log('connection_error', {
      ip: ws.relayIp,
      message: cleanString(error && error.message, 160),
    });
  });
});

const heartbeat = setInterval(() => {
  const staleBefore = Date.now() - 120000;
  for (const [ip, state] of connectionAttemptsByIp) {
    if (state.startedAt < staleBefore && !connectionsByIp.has(ip)) {
      connectionAttemptsByIp.delete(ip);
    }
  }
  for (const [ip, state] of httpRequestsByIp) {
    if (state.startedAt < staleBefore) httpRequestsByIp.delete(ip);
  }

  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      log('heartbeat_timeout', { ip: ws.relayIp });
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

server.on('clientError', (_error, socket) => {
  rejectUpgrade(socket, '400 Bad Request', 'bad request');
});

wss.on('error', (error) => {
  log('websocket_server_error', { message: cleanString(error && error.message, 160) });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  log('shutdown_started', { signal });

  let httpClosed = false;
  let websocketsClosed = false;
  let finished = false;
  let forceShutdown;

  function finishIfDrained() {
    if (finished || !httpClosed || !websocketsClosed) return;
    finished = true;
    clearTimeout(forceShutdown);
    log('shutdown_complete');
    process.exit(0);
  }

  server.close(() => {
    httpClosed = true;
    finishIfDrained();
  });
  for (const ws of wss.clients) ws.close(1001, 'relay restarting');

  forceShutdown = setTimeout(() => {
    finished = true;
    for (const ws of wss.clients) ws.terminate();
    log('shutdown_forced');
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
  forceShutdown.unref();

  wss.close(() => {
    websocketsClosed = true;
    finishIfDrained();
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  log('relay listening', {
    port: PORT,
    maxConnections: MAX_CONNECTIONS,
    maxRooms: MAX_ROOMS,
    allowedOrigins: ALLOWED_ORIGINS.size || 'any',
  });
});
