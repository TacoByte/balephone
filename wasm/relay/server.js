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

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const MAX_MEMBERS = 8;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const rooms = new Map(); // code -> { members, streams, public, metadata, updatedAt }

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sendError(ws, code) {
  ws.send(Buffer.from([0x87, code]));
  ws.close();
}

function sendWelcome(ws, id, room) {
  const roomBuf = Buffer.from(room, 'utf8');
  ws.send(Buffer.concat([Buffer.from([0x81, id, roomBuf.length]), roomBuf]));
}

function cleanString(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength);
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
    return;
  }

  room.metadata = {
    name: cleanString(metadata.name, 64) || 'Untitled Game',
    host: cleanString(metadata.host, 32),
    map: cleanString(metadata.map, 64) || 'Unspecified Map',
    gameType: Math.max(0, Math.min(65535, Number(metadata.gameType) || 0)),
    difficulty: Math.max(0, Math.min(65535, Number(metadata.difficulty) || 0)),
    scenarioID: cleanString(metadata.scenarioID, 64),
    scenarioName: cleanString(metadata.scenarioName, 64),
    scenarioVersion: cleanString(metadata.scenarioVersion, 32),
  };
  room.public = true;
  room.updatedAt = Date.now();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;   // { code, members, streams }
  let myId = 0;

  ws.on('message', (data, isBinary) => {
    if (!isBinary || data.length < 1) return;

    const type = data[0];

    if (type === 0x01) { // HELLO
      if (room) return;
      const create = data[1] === 1;
      const nameLen = data[2];
      let code = data.slice(3, 3 + nameLen).toString('utf8').toUpperCase();

      if (create) {
        code = code || makeRoomCode();
        if (rooms.has(code)) { sendError(ws, 2); return; }
        rooms.set(code, {
          code,
          members: new Map(),
          streams: new Map(),
          public: false,
          metadata: null,
          updatedAt: Date.now(),
        });
      } else if (!rooms.has(code)) {
        sendError(ws, 1);
        return;
      }

      room = rooms.get(code);
      if (room.members.size >= MAX_MEMBERS) { sendError(ws, 2); return; }

      myId = 1;
      while (room.members.has(myId)) myId++;
      room.members.set(myId, ws);
      sendWelcome(ws, myId, code);
      console.log(`[${code}] member ${myId} joined (${room.members.size} in room)`);
      return;
    }

    if (!room) return;

    switch (type) {
      case 0x02: { // DGRAM [u8 dest][u16 port][payload] -> [u8 src][u16 port][payload]
        if (data.length < 4) return;
        const dest = room.members.get(data[1]);
        if (!dest) return;
        const out = Buffer.from(data);
        out[0] = 0x82;
        out[1] = myId;
        dest.send(out);
        break;
      }
      case 0x03: { // OPEN [u32 stream][u8 dest][u16 port]
        if (data.length < 8) return;
        const streamId = data.readUInt32BE(1);
        const destId = data[5];
        const dest = room.members.get(destId);
        if (!dest) {
          // Peer gone: bounce a CLOSE straight back.
          const close = Buffer.alloc(5);
          close[0] = 0x85;
          close.writeUInt32BE(streamId, 1);
          ws.send(close);
          return;
        }
        room.streams.set(streamId, { a: myId, b: destId });
        const out = Buffer.from(data);
        out[0] = 0x83;
        out[5] = myId; // dest sees who opened it
        dest.send(out);
        break;
      }
      case 0x04:   // DATA [u32 stream][payload]
      case 0x05: { // CLOSE [u32 stream]
        if (data.length < 5) return;
        const streamId = data.readUInt32BE(1);
        const pair = room.streams.get(streamId);
        if (!pair) return;
        const otherId = pair.a === myId ? pair.b : pair.a;
        const other = room.members.get(otherId);
        if (type === 0x05) room.streams.delete(streamId);
        if (!other) return;
        const out = Buffer.from(data);
        out[0] = type === 0x04 ? 0x84 : 0x85;
        other.send(out);
        break;
      }
      case 0x06: { // PUBLISH [JSON metadata], creator only
        if (myId !== 1 || data.length > 4096) return;
        publishRoom(room, data);
        break;
      }
      case 0x07: // UNLIST, creator only
        if (myId !== 1) return;
        room.public = false;
        room.metadata = null;
        room.updatedAt = Date.now();
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.members.delete(myId);
    console.log(`[${room.code}] member ${myId} left (${room.members.size} in room)`);
    if (myId === 1) {
      room.public = false;
      room.metadata = null;
    }

    // Close this member's streams and notify everyone else.
    for (const [streamId, pair] of room.streams) {
      if (pair.a === myId || pair.b === myId) room.streams.delete(streamId);
    }
    const gone = Buffer.from([0x86, myId]);
    for (const member of room.members.values()) member.send(gone);

    if (room.members.size === 0) {
      rooms.delete(room.code);
      console.log(`[${room.code}] room closed`);
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Aleph One relay listening on :${PORT}`);
});
