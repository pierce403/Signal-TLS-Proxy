import { ClientHelloRouter } from './client-hello.mjs';

export const TUNNEL_PATH = '/v1/tls-tunnel';
export const SUBPROTOCOL = 'signal-tls-v1';
export const LIMITS = Object.freeze({ maxMessage: 65536, maxQueued: 262144,
  maxSessionBytes: 2 * 1024 * 1024, maxChunks: 4096, handshakeMs: 10000, idleMs: 120000 });

export function requestStatus(request) {
  const url = new URL(request.url);
  if (url.pathname !== TUNNEL_PATH || url.search || request.method !== 'GET') return 404;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return 426;
  if (!(request.headers.get('Sec-WebSocket-Protocol') || '').split(',')
    .map(value => value.trim()).includes(SUBPROTOCOL)) return 400;
  return 101;
}

// Socket is a Workers WebSocket; connect is cloudflare:sockets.connect. Dependency
// injection lets local tests verify routing and real TLS without a cloud account.
export function bridgeWebSocket(websocket, connect, { limits = LIMITS, onClose = () => {} } = {}) {
  const router = new ClientHelloRouter();
  let socket, writer, reader, closed = false, processing = false;
  let queue = [], queued = 0, total = 0, chunks = 0, idle;
  let endSignal;
  const ended = new Promise(resolve => { endSignal = resolve; });
  const endRead = ended.then(() => ({ done: true }));
  function close(code = 1011, reason = 'Tunnel closed') {
    if (closed) return;
    closed = true;
    clearTimeout(handshake); clearTimeout(idle);
    queue = []; queued = 0;
    endSignal();
    try { websocket.close(code, reason); } catch { /* Already closed. */ }
    try { Promise.resolve(socket?.close()).catch(() => {}); } catch { /* Already closed. */ }
    onClose();
  }
  const handshake = setTimeout(() => close(1008, 'Handshake timeout'), limits.handshakeMs);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => close(1000, 'Idle timeout'), limits.idleMs); };
  const budget = length => {
    total += length;
    chunks++;
    if (total > limits.maxSessionBytes || chunks > limits.maxChunks) {
      close(1009, 'Diagnostic byte or chunk limit'); return false;
    }
    return true;
  };
  async function upstreamRead() {
    try {
      reader = socket.readable.getReader();
      while (!closed) {
        const result = await Promise.race([reader.read(), endRead]);
        if (closed) return;
        if (result.done) { close(1000, 'Upstream closed'); return; }
        if (!budget(result.value.byteLength)) return;
        touch();
        for (let offset = 0; offset < result.value.byteLength; offset += limits.maxMessage) {
          websocket.send(result.value.subarray(offset, offset + limits.maxMessage));
        }
      }
    } catch { close(1011, 'Upstream read failed'); }
  }
  async function pump() {
    if (processing || closed) return;
    processing = true;
    try {
      while (queue.length && !closed) {
        const chunk = queue.shift();
        if (!socket) {
          const route = router.push(chunk);
          if (route) {
            socket = connect({ hostname: route.hostname, port: 443 },
              { secureTransport: 'off', allowHalfOpen: false });
            socket.closed.catch(() => close(1011, 'Upstream connection failed'));
            await Promise.race([socket.opened, ended]);
            if (closed) return;
            writer = socket.writable.getWriter();
            await Promise.race([writer.write(route.bytes), ended]);
            if (closed) return;
            router.bytes = new Uint8Array(0);
            clearTimeout(handshake);
            void upstreamRead();
          }
        } else {
          await Promise.race([writer.write(chunk), ended]);
        }
        if (!closed) queued -= chunk.byteLength;
      }
    } catch { close(1008, 'Invalid handshake or upstream failure'); }
    finally { processing = false; }
  }
  websocket.addEventListener('message', event => {
    if (closed) return;
    let chunk;
    if (event.data instanceof ArrayBuffer) chunk = new Uint8Array(event.data);
    else if (ArrayBuffer.isView(event.data)) chunk = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    else { close(1003, 'Binary frames required'); return; }
    if (chunk.length > limits.maxMessage || queued + chunk.length > limits.maxQueued) {
      close(1009, 'Message or queue limit'); return;
    }
    if (!budget(chunk.length)) return;
    queued += chunk.length; queue.push(chunk);
    touch();
    void pump();
  });
  websocket.addEventListener('close', () => close(1000, 'Client closed'));
  websocket.addEventListener('error', () => close(1011, 'WebSocket failed'));
  return { close, get closed() { return closed; } };
}
