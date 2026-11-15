# Cloudflare diagnostic byte relay

Workers-native implementation of the same browser transport as `web-boost/`:
`wss://proxy.twang.chat/v1/tls-tunnel`, WebSocket subprotocol `signal-tls-v1`,
binary messages carrying raw inner TLS bytes. This is a separate deployment;
the original Docker/Nginx proxy and its native transport are not changed.

The Worker reads a bounded TLS ClientHello solely to select its public SNI from
the exact production Signal allowlist in `data/nginx-relay/nginx.conf`. It opens
TCP port 443 using `cloudflare:sockets` with `secureTransport: "off"`, forwarding
the browser's TLS bytes unchanged. It does not terminate that TLS connection,
validate Signal certificates on the client's behalf, read credentials, or store
messages. The browser's WASM TLS implementation must validate the certificate
and hostname. Cloudflare terminates the outer WSS connection and sees the client
IP, destination hostname, sizes and timings. Serving trusted application code
remains a separate requirement.

## Install, verify, deploy

Requirements: Node.js 22.12+ (CI uses 24), npm, OpenSSL for local TLS tests, and an
authenticated Wrangler with access to the Cloudflare account and `twang.chat`
zone for deployment. Runtime has no npm dependencies, database, bindings, or
Signal credentials. The custom domain in `wrangler.jsonc` is the single endpoint
used by the static Twang client.

```sh
cd cloudflare
npm ci --ignore-scripts
npm test
npm run deploy:check
npm run deploy
```

Only the last command publishes a Worker and custom-domain configuration.
No deployment has been performed from this development environment. Keep account
tokens in your deployment environment, never in source or browser JavaScript.
The checked-in CI only tests and performs the dry run; it has no deploy step.

## Bounds and failure behavior

- Exact path and subprotocol; target query parameters and text frames rejected.
- Fixed Signal hostname allowlist, destination port 443, no arbitrary target API.
- ClientHello parsing across record/message fragments, bounded 64 KiB prefix and
  32 KiB handshake body. Parsing is incremental rather than rescanning fragments.
- 64 KiB binary frame limit and 256 KiB pending input queue. Output reads are
  split into binary frames of at most 64 KiB. TCP writes await stream backpressure.
- 10-second handshake/connect timeout, 120-second idle timeout, 16 sessions per
  isolate. These are diagnostics limits, not a global distributed rate limiter.
- 2 MiB cumulative bytes and 4096 transport chunks per session, counting both
  directions. Workers' server
  WebSocket API has no documented drain callback, so the byte budget bounds the
  possible outgoing accumulation; this is not an attachment-transfer service.
- Client close, invalid input, timeout, upstream read/write/connect error and byte
  limits close both sides. No application logging; Worker observability disabled.

Any web origin may use this public, Signal-only relay. Origin is not
authentication. No cookies, authorization headers, target headers, or TLS keys
are consumed or forwarded. Ordinary HTTPS requests return an error rather than
a health response; no endpoint claims that Signal was reached.

## Verification and hosting limitation

Tests cover parser fragmentation and malformed input, denied destinations,
protocol checks, queue/frame/byte limits, connect timeout and cleanup, a genuine
certificate-validated local TLS round trip (and untrusted-certificate rejection),
plus the actual workerd runtime's WebSocket upgrade, binary-only policy, session
limit and a full TLS echo through its real TCP socket implementation to the local
fixture. The server explicitly selects ArrayBuffer binary delivery before
accepting the WebSocket, including on current compatibility dates that default
to Blob delivery.
Local TLS tests inject an alternate TCP connector to a local fixture; production
has no fixture address or bypass. They do not establish live Signal connectivity.

**Cloudflare blocks outbound TCP to Cloudflare IP ranges, localhost and private
addresses.** If a Signal service resolves into a blocked range, this deployment
cannot reach it using raw TCP. Browser TLS cannot be replaced with Worker `fetch`
without changing the trust architecture. Check actual deployed TLS diagnostics
before claiming interoperability. If blocked, the Docker/Nginx `web-boost`
deployment on a compatible network remains the same protocol alternative.
The Cloudflare implementation only accepts WSS; it cannot receive a stock native
Signal proxy connection as public raw TLS/TCP.

References:

- https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- https://developers.cloudflare.com/workers/runtime-apis/websockets/
