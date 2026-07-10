# Aleph One web relay

This service provides the persistent WebSocket transport and public-room
directory used by the browser build. Room and connection state live in this
process.

## Local development

```sh
npm ci
npm test
npm start
```

The service listens on `PORT` (default `8787`):

- `GET /healthz` reports readiness and bounded service counts.
- `GET /v1/rooms` returns the current public-room directory.
- WebSocket connections use the binary protocol documented in `server.js`.

## Production safeguards

The relay rejects malformed protocol frames and invalid room codes. It also
enforces:

- WebSocket payload and datagram limits
- Global, per-IP, per-room, and per-connection caps
- Connection-attempt, HTTP-request, frame, and byte-rate limits
- A HELLO deadline and WebSocket ping/pong liveness checks
- Stream ownership checks and a per-room stream limit
- Slow-receiver backpressure limits
- Graceful `SIGTERM`/`SIGINT` draining
- Optional HTTP and WebSocket origin allowlisting

Defaults are intentionally conservative for a small public v1. They can be
overridden with environment variables matching the constant names in
`server.js`, such as `MAX_CONNECTIONS`, `MAX_ROOMS`, and
`MAX_BYTES_PER_SECOND`.

Set `ALLOWED_ORIGINS` to a comma-separated list of exact browser origins:

```text
ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

Requests without a browser `Origin` header remain allowed for health checks
and operational clients. Origin checks are a browser boundary, not user
authentication.

## Render deployment

Use a Render Web Service with:

- Root directory: `wasm/relay`
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`
- Instance count: exactly `1`
- Instance type: paid (free services sleep and are unsuitable for live matches)
- Environment: `ALLOWED_ORIGINS` set to the deployed game's origin

Render terminates TLS, so clients connect with `wss://`. The service trusts
Render's forwarded client IP automatically when Render sets `RENDER=true`.
Configure the browser build with these public endpoints, without an internal
port:

```text
relayUrl=wss://your-relay.onrender.com
relayHttpUrl=https://your-relay.onrender.com
```

Do not scale this service above one instance. Rooms are held in process memory,
so clients connected to different instances would not see the same room. A
future multi-instance deployment requires shared room state and connection
routing rather than only changing the instance count.

Deploys and Render maintenance replace the running instance and therefore end
active matches. Keep automatic deploys disabled while matches may be running,
and treat the relay's `1001` restart close as a recoverable disconnect in the
browser UI. Seamless match resumption would require persisted session state and
is outside this relay's current protocol.
