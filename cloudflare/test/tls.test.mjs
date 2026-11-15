import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex, Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeWebSocket } from '../relay.mjs';
import { TestWebSocket } from './helpers.mjs';
import { Miniflare } from 'miniflare';

test('Worker bridge and actual workerd carry validated TLS; untrusted certificate is rejected', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'signal-worker-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-days', '1', '-subj', '/CN=chat.signal.org', '-addext', 'subjectAltName=DNS:chat.signal.org'], { stdio: 'ignore' });
  const certificate = readFileSync(join(directory, 'cert.pem'));
  const clients = new Set();
  const endpoint = tls.createServer({ key: readFileSync(join(directory, 'key.pem')), cert: certificate }, socket => socket.pipe(socket));
  endpoint.on('connection', socket => { clients.add(socket); socket.on('close', () => clients.delete(socket)); });
  endpoint.on('tlsClientError', () => {});
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of clients) socket.destroy(); await new Promise(resolve => endpoint.close(resolve)); });

  async function client(ca) {
    const websocket = new TestWebSocket();
    const stream = new Duplex({ read() {}, write(data, _encoding, done) { websocket.message(new Uint8Array(data)); done(); } });
    websocket.onSend = bytes => stream.push(Buffer.from(bytes));
    websocket.onClose = () => stream.destroy();
    const bridge = bridgeWebSocket(websocket, (address, options) => {
      assert.deepEqual(address, { hostname: 'chat.signal.org', port: 443 });
      assert.equal(options.secureTransport, 'off');
      // Test dependency injection only. Production cannot select this address.
      const socket = net.connect(endpoint.address().port, '127.0.0.1');
      return { readable: Readable.toWeb(socket), writable: Writable.toWeb(socket),
        opened: once(socket, 'connect'), closed: once(socket, 'close'), close() { socket.destroy(); } };
    });
    const secured = tls.connect({ socket: stream, servername: 'chat.signal.org', ...(ca ? { ca } : {}) });
    secured.on('error', () => {});
    t.after(() => { secured.destroy(); bridge.close(); });
    return { secured, bridge };
  }
  const valid = await client(certificate);
  await once(valid.secured, 'secureConnect');
  assert.equal(valid.secured.authorized, true);
  const echoed = once(valid.secured, 'data');
  valid.secured.write('private inner TLS payload');
  assert.equal((await echoed)[0].toString(), 'private inner TLS payload');
  valid.secured.destroy(); valid.bridge.close();
  const invalid = await client();
  const error = await new Promise(resolve => invalid.secured.once('error', resolve));
  assert.match(error.message, /self.signed certificate/i);
  invalid.bridge.close();

  // This extra entry module exists only in the local test. It replaces the
  // outbound connector with a local TLS fixture while running the unmodified
  // production bridge and ClientHello parser inside actual workerd.
  const fixtureModule = `
    import { connect } from 'cloudflare:sockets';
    import { bridgeWebSocket } from './relay.mjs';
    export default { fetch() {
      const [client, server] = Object.values(new WebSocketPair());
      server.binaryType = 'arraybuffer';
      server.accept();
      bridgeWebSocket(server, (address, options) => {
        if (address.hostname !== 'chat.signal.org' || address.port !== 443 ||
            options.secureTransport !== 'off') throw new Error('Unexpected target');
        return connect({ hostname: '127.0.0.1', port: ${endpoint.address().port} }, options);
      });
      return new Response(null, { status: 101, webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': 'signal-tls-v1' } });
    } };`;
  const root = new URL('../', import.meta.url);
  const modules = { 'fixture-worker.mjs': { type: 'esm', contents: fixtureModule } };
  for (const path of ['relay.mjs', 'client-hello.mjs']) {
    modules[path] = { type: 'esm', contents: readFileSync(new URL(path, root), 'utf8') };
  }
  const runtime = new Miniflare({ workers: [{ config: { name: 'signal-webboost-tls-fixture',
    compatibilityDate: '2026-11-14', manifest: { mainModule: 'fixture-worker.mjs',
      modulesRoot: root.pathname, modules } } }] });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
  });
  assert.equal(response.status, 101);
  const runtimeSocket = response.webSocket;
  runtimeSocket.binaryType = 'arraybuffer';
  runtimeSocket.accept();
  const runtimeStream = new Duplex({ read() {}, write(bytes, _encoding, done) { runtimeSocket.send(bytes); done(); } });
  runtimeSocket.addEventListener('message', event => runtimeStream.push(Buffer.from(event.data)));
  runtimeSocket.addEventListener('close', event => runtimeStream.destroy(new Error(`Fixture tunnel closed: ${event.code} ${event.reason}`)));
  const runtimeTls = tls.connect({ socket: runtimeStream, servername: 'chat.signal.org', ca: certificate });
  runtimeTls.on('error', () => {});
  t.after(() => { runtimeTls.destroy(); try { runtimeSocket.close(1000); } catch { /* Already closed. */ } });
  await once(runtimeTls, 'secureConnect');
  assert.equal(runtimeTls.authorized, true);
  const runtimeEcho = once(runtimeTls, 'data');
  runtimeTls.write('actual workerd keeps Signal TLS opaque');
  assert.equal((await runtimeEcho)[0].toString(), 'actual workerd keeps Signal TLS opaque');
  runtimeTls.destroy(); runtimeSocket.close(1000);
});
