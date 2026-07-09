/*
 *  net_relay.cpp - WebSocket relay transport for the browser build.
 *
 *  Implements the NetworkInterface API (see NetworkInterfaceWasm.h) on top of
 *  a single WebSocket to a relay server. The relay is game-agnostic: it rooms
 *  clients together, routes datagram frames ("UDP") and byte streams ("TCP")
 *  between members, and assigns member ids (1 = room creator = gatherer).
 *
 *  Wire protocol (binary WS frames, big-endian):
 *    client -> relay
 *      0x01 HELLO  [u8 create][u8 roomLen][room utf8]
 *      0x02 DGRAM  [u8 dest][u16 port][payload]
 *      0x03 OPEN   [u32 stream][u8 dest][u16 port]
 *      0x04 DATA   [u32 stream][payload]
 *      0x05 CLOSE  [u32 stream]
 *    relay -> client
 *      0x81 WELCOME   [u8 yourId][u8 roomLen][room utf8]
 *      0x82 DGRAM     [u8 src][u16 port][payload]
 *      0x83 OPEN      [u32 stream][u8 src][u16 port]
 *      0x84 DATA      [u32 stream][payload]
 *      0x85 CLOSE     [u32 stream]
 *      0x86 PEER_LEFT [u8 id]
 *      0x87 ERROR     [u8 code]
 */

#ifdef __EMSCRIPTEN__

#include <emscripten.h>

#include "NetworkInterfaceWasm.h"

#include <cstdio>
#include <cstring>
#include <string>

// ---------------------------------------------------------------------------
// JS side: WebSocket + queues. All state lives on globalThis.__a1net so it
// survives across calls; wasm only ever polls.
// ---------------------------------------------------------------------------

EM_JS(void, js_net_reset, (), {
  var st = globalThis.__a1net;
  if (st && st.ws) {
    try { st.ws.onclose = null; st.ws.close(); } catch (e) {}
  }
  globalThis.__a1net = {
    ws: null,
    status: 0,       // 0 idle/connecting, 2 ready, -1 failed
    myId: 0,
    room: '',
    isCreator: false,
    dgrams: {},      // port -> [{src, port, data}]
    streams: {},     // id -> {open, chunks[], pos, peer, port}
    pending: {},     // listen port -> [stream ids]
    nextSeq: 1,
  };
});

EM_JS(void, js_net_connect, (const char* roomPtr, int roomLen, int create), {
  var room = roomLen ? UTF8ToString(roomPtr, roomLen) : '';
  js_net_reset();
  var st = globalThis.__a1net;
  st.isCreator = !!create;

  var url = Module['relayUrl'];
  if (!url) {
    var proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss://' : 'ws://';
    var host = (typeof location !== 'undefined') ? location.hostname : 'localhost';
    url = proto + host + ':8787';
  }

  var ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    st.status = -1;
    return;
  }
  ws.binaryType = 'arraybuffer';
  st.ws = ws;

  ws.onopen = function() {
    var enc = new TextEncoder().encode(room);
    var buf = new Uint8Array(3 + enc.length);
    buf[0] = 0x01;
    buf[1] = create ? 1 : 0;
    buf[2] = enc.length;
    buf.set(enc, 3);
    ws.send(buf);
  };

  ws.onmessage = function(ev) {
    var u8 = new Uint8Array(ev.data);
    var dv = new DataView(ev.data);
    switch (u8[0]) {
      case 0x81: { // WELCOME
        st.myId = u8[1];
        var rl = u8[2];
        st.room = new TextDecoder().decode(u8.slice(3, 3 + rl));
        st.status = 2;
        Module['__a1RoomCode'] = st.room; // console/testing access
        break;
      }
      case 0x82: { // DGRAM
        var src = u8[1], port = dv.getUint16(2);
        var q = st.dgrams[port] || (st.dgrams[port] = []);
        if (q.length < 256) q.push({ src: src, port: port, data: u8.slice(4) });
        break;
      }
      case 0x83: { // OPEN (incoming stream)
        var id = dv.getUint32(1), from = u8[5], port = dv.getUint16(6);
        st.streams[id] = { open: true, chunks: [], pos: 0, peer: from, port: port };
        var pq = st.pending[port] || (st.pending[port] = []);
        pq.push(id);
        break;
      }
      case 0x84: { // DATA
        var id = dv.getUint32(1);
        var s = st.streams[id];
        if (s) s.chunks.push(u8.slice(5));
        break;
      }
      case 0x85: { // CLOSE
        var s = st.streams[dv.getUint32(1)];
        if (s) s.open = false;
        break;
      }
      case 0x86: { // PEER_LEFT
        var gone = u8[1];
        for (var k in st.streams) {
          if (st.streams[k].peer === gone) st.streams[k].open = false;
        }
        break;
      }
      case 0x87: // ERROR (no such room, room full, ...)
        st.status = -1;
        try { ws.close(); } catch (e) {}
        break;
    }
  };

  ws.onclose = function() {
    if (st.status !== -1) st.status = (st.status === 2) ? -2 : -1;
    for (var k in st.streams) st.streams[k].open = false;
  };
  ws.onerror = function() {};
});

EM_JS(int, js_net_status, (), {
  var st = globalThis.__a1net;
  return st ? st.status : 0;
});

// Shareable join link for the current room: the page's own URL (scenario,
// relay overrides etc. preserved) plus ?join=CODE. Empty if not connected.
EM_JS(void, js_net_share_url, (char* buf, int maxLen), {
  var st = globalThis.__a1net;
  if (!st || st.status !== 2 || typeof location === 'undefined') {
    stringToUTF8('', buf, maxLen);
    return;
  }
  var u = new URL(location.href);
  if (u.pathname.endsWith('/index.html'))
    u.pathname = u.pathname.slice(0, -('index.html'.length));
  u.searchParams.set('join', st.room);
  stringToUTF8(u.toString(), buf, maxLen);
});

EM_JS(void, js_copy_clipboard, (const char* ptr), {
  var text = UTF8ToString(ptr);
  Module['__a1LastCopy'] = text; // testing access
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
});

EM_JS(int, js_net_my_id, (), {
  var st = globalThis.__a1net;
  return st ? st.myId : 0;
});

// Is the current connection usable for this room/role? 1 yes, 0 no.
EM_JS(int, js_net_matches, (const char* roomPtr, int roomLen, int wantCreator), {
  var st = globalThis.__a1net;
  if (!st || st.status !== 2) return 0;
  if (wantCreator) return st.isCreator ? 1 : 0;
  var room = UTF8ToString(roomPtr, roomLen);
  return st.room.toUpperCase() === room.toUpperCase() ? 1 : 0;
});

EM_JS(void, js_net_send_dgram, (int dest, int port, const uint8_t* ptr, int len), {
  var st = globalThis.__a1net;
  if (!st || st.status !== 2) return;
  var buf = new Uint8Array(4 + len);
  var dv = new DataView(buf.buffer);
  buf[0] = 0x02;
  buf[1] = dest;
  dv.setUint16(2, port);
  buf.set(HEAPU8.subarray(ptr, ptr + len), 4);
  st.ws.send(buf);
});

// meta: two i32s (src member, src port). Returns payload length, 0 if empty.
EM_JS(int, js_net_recv_dgram, (int port, uint8_t* buf, int maxLen, int* meta), {
  var st = globalThis.__a1net;
  if (!st) return 0;
  var q = st.dgrams[port];
  if (!q || !q.length) return 0;
  var m = q.shift();
  var n = Math.min(m.data.length, maxLen);
  HEAPU8.set(m.data.subarray(0, n), buf);
  HEAP32[meta >> 2] = m.src;
  HEAP32[(meta >> 2) + 1] = m.port;
  return n;
});

EM_JS(int, js_net_open_stream, (int dest, int port), {
  var st = globalThis.__a1net;
  if (!st || st.status !== 2) return 0;
  var id = (st.myId << 20) | (st.nextSeq++);
  st.streams[id] = { open: true, chunks: [], pos: 0, peer: dest, port: port };
  var buf = new Uint8Array(8);
  var dv = new DataView(buf.buffer);
  buf[0] = 0x03;
  dv.setUint32(1, id);
  buf[5] = dest;
  dv.setUint16(6, port);
  st.ws.send(buf);
  return id;
});

EM_JS(int, js_net_stream_send, (int id, const uint8_t* ptr, int len), {
  var st = globalThis.__a1net;
  var s = st && st.streams[id];
  if (!s || !s.open || st.status !== 2) return -1;
  var buf = new Uint8Array(5 + len);
  var dv = new DataView(buf.buffer);
  buf[0] = 0x04;
  dv.setUint32(1, id);
  buf.set(HEAPU8.subarray(ptr, ptr + len), 5);
  st.ws.send(buf);
  return len;
});

// Returns bytes copied; 0 if no data available; -1 if closed and drained.
EM_JS(int, js_net_stream_recv, (int id, uint8_t* buf, int maxLen), {
  var st = globalThis.__a1net;
  var s = st && st.streams[id];
  if (!s) return -1;
  var copied = 0;
  while (copied < maxLen && s.chunks.length) {
    var chunk = s.chunks[0];
    var avail = chunk.length - s.pos;
    var n = Math.min(avail, maxLen - copied);
    HEAPU8.set(chunk.subarray(s.pos, s.pos + n), buf + copied);
    copied += n;
    s.pos += n;
    if (s.pos >= chunk.length) { s.chunks.shift(); s.pos = 0; }
  }
  if (copied > 0) return copied;
  return s.open ? 0 : -1;
});

EM_JS(void, js_net_stream_close, (int id), {
  var st = globalThis.__a1net;
  if (!st) return;
  var s = st.streams[id];
  if (!s) return;
  if (s.open && st.status === 2) {
    var buf = new Uint8Array(5);
    new DataView(buf.buffer).setUint32(1, id);
    buf[0] = 0x05;
    st.ws.send(buf);
  }
  delete st.streams[id];
});

EM_JS(int, js_net_accept, (int port), {
  var st = globalThis.__a1net;
  if (!st) return 0;
  var q = st.pending[port];
  if (!q || !q.length) return 0;
  return q.shift();
});

EM_JS(int, js_net_stream_peer, (int id), {
  var st = globalThis.__a1net;
  var s = st && st.streams[id];
  return s ? s.peer : 0;
});

// ---------------------------------------------------------------------------
// Relay session management
// ---------------------------------------------------------------------------

// Connect (or reconnect) so that we are in the given room. Empty room +
// create=true asks the relay to make a fresh room. Blocks (ASYNCIFY) until
// welcomed or failed.
static bool relay_ensure(const std::string& room, bool create)
{
	if (js_net_matches(room.c_str(), (int)room.size(), create ? 1 : 0))
		return true;

	js_net_connect(room.c_str(), (int)room.size(), create ? 1 : 0);

	for (int waited = 0; waited < 15000; waited += 50)
	{
		int s = js_net_status();
		if (s == 2) return true;
		if (s < 0) return false;
		emscripten_sleep(50);
	}
	return false;
}

// ---------------------------------------------------------------------------
// IPaddress
// ---------------------------------------------------------------------------

IPaddress::IPaddress(const std::string& host, uint16_t port)
{
	set_address(host);
	set_port(port);
}

IPaddress::IPaddress(const uint8_t ip[4], uint16_t port)
{
	set_address(ip);
	set_port(port);
}

std::string IPaddress::address() const
{
	char buf[16];
	snprintf(buf, sizeof(buf), "%u.%u.%u.%u", _ip[0], _ip[1], _ip[2], _ip[3]);
	return buf;
}

void IPaddress::set_address(const std::string& host)
{
	unsigned a, b, c, d;
	if (sscanf(host.c_str(), "%u.%u.%u.%u", &a, &b, &c, &d) == 4)
	{
		_ip = { (uint8_t)a, (uint8_t)b, (uint8_t)c, (uint8_t)d };
	}
	else
	{
		_ip = { 0, 0, 0, 0 };
	}
}

void IPaddress::set_address(const uint8_t ip[4])
{
	_ip = { ip[0], ip[1], ip[2], ip[3] };
}

IPaddress IPaddress::from_member(int member, uint16_t port)
{
	const uint8_t ip[4] = { 10, 0, 0, (uint8_t)member };
	return IPaddress(ip, port);
}

// ---------------------------------------------------------------------------
// UDPsocket
// ---------------------------------------------------------------------------

UDPsocket::UDPsocket(uint16_t port) : _port(port) {}
UDPsocket::~UDPsocket() {}

int64_t UDPsocket::send(const UDPpacket& packet)
{
	const int member = packet.address.member();
	if (member <= 0 || js_net_status() != 2)
		return -1;
	js_net_send_dgram(member, packet.address.port(), packet.buffer.data(), packet.data_size);
	return packet.data_size;
}

int64_t UDPsocket::broadcast_send(const UDPpacket& packet)
{
	// No LAN broadcast on the web; discard (see broadcast() in the header).
	return packet.data_size;
}

int64_t UDPsocket::receive(UDPpacket& packet)
{
	int meta[2] = { 0, 0 };
	int n = js_net_recv_dgram(_port, packet.buffer.data(), (int)packet.buffer.size(), meta);
	if (n <= 0)
		return -1;
	packet.data_size = n;
	packet.address = IPaddress::from_member(meta[0], (uint16_t)meta[1]);
	return n;
}

int64_t UDPsocket::check_receive() const
{
	// Only used as a "anything waiting?" hint.
	int meta[2];
	(void)meta;
	return 0;
}

void UDPsocket::register_receive_async(UDPpacket& packet)
{
	_async_packet = &packet;
}

int64_t UDPsocket::receive_async(int timeout_ms)
{
	// Only used by the desktop receive thread; the wasm build polls receive()
	// from the main-loop pump instead. Sleep so a stray caller can't spin.
	emscripten_sleep(timeout_ms);
	return 0;
}

// ---------------------------------------------------------------------------
// TCPsocket / TCPlistener
// ---------------------------------------------------------------------------

TCPsocket::~TCPsocket()
{
	js_net_stream_close(_stream);
}

int64_t TCPsocket::send(uint8_t* buffer, size_t size)
{
	return js_net_stream_send(_stream, buffer, (int)size);
}

int64_t TCPsocket::receive(uint8_t* buffer, size_t size)
{
	int n = js_net_stream_recv(_stream, buffer, (int)size);
	return n; // >0 data, 0 would-block, -1 closed
}

IPaddress TCPsocket::remote_address() const
{
	return IPaddress::from_member(js_net_stream_peer(_stream), 4226);
}

TCPlistener::TCPlistener(uint16_t port) : _port(port) {}
TCPlistener::~TCPlistener() {}

std::unique_ptr<TCPsocket> TCPlistener::accept_connection()
{
	int id = js_net_accept(_port);
	if (!id)
		return nullptr;
	return std::unique_ptr<TCPsocket>(new TCPsocket(id));
}

// ---------------------------------------------------------------------------
// NetworkInterface
// ---------------------------------------------------------------------------

std::unique_ptr<UDPsocket> NetworkInterface::udp_open_socket(uint16_t port)
{
	// The relay connection is established lazily by whoever knows the room:
	// the gatherer when opening the TCP listener, the joiner in
	// resolve_address. Datagrams flow once that's happened.
	return std::unique_ptr<UDPsocket>(new UDPsocket(port));
}

std::unique_ptr<TCPlistener> NetworkInterface::tcp_open_listener(uint16_t port)
{
	// Gathering: create a room (we become member 1, the hub).
	if (!relay_ensure("", true))
		return nullptr;
	return std::unique_ptr<TCPlistener>(new TCPlistener(port));
}

std::unique_ptr<TCPsocket> NetworkInterface::tcp_connect_socket(const IPaddress& address)
{
	const int member = address.member();
	if (member <= 0 || js_net_status() != 2)
		return nullptr;
	int id = js_net_open_stream(member, address.port());
	if (!id)
		return nullptr;
	return std::unique_ptr<TCPsocket>(new TCPsocket(id));
}

std::optional<IPaddress> NetworkInterface::resolve_address(const std::string& host, uint16_t port)
{
	unsigned a, b, c, d;
	if (sscanf(host.c_str(), "%u.%u.%u.%u", &a, &b, &c, &d) == 4)
		return IPaddress(host, port);

	// Anything else is a relay room code: join the room; the gatherer is
	// always member 1.
	if (host.empty() || !relay_ensure(host, false))
		return std::nullopt;

	return IPaddress::from_member(1, port);
}

// ---------------------------------------------------------------------------
// Main-loop network pump
// ---------------------------------------------------------------------------

extern void mytm_pump();        // mytm_wasm.cpp: run due hub/spoke tick tasks
extern void NetDDPPumpWasm();   // network_udp.cpp: drain datagrams to handler

// Shareable join link for the current room ("" when not connected); the
// gather dialog displays it with a copy button.
extern "C" void wasm_relay_share_url(char* buf, int maxlen)
{
	js_net_share_url(buf, maxlen);
}

extern "C" void wasm_copy_to_clipboard(const char* text)
{
	js_copy_clipboard(text);
}

extern "C" void wasm_net_idle(void)
{
	static bool in_pump = false;
	if (in_pump)
		return; // no reentrant pumping (a tick handler is on the stack)
	in_pump = true;
	NetDDPPumpWasm();
	mytm_pump();
	in_pump = false;
}

#endif // __EMSCRIPTEN__
