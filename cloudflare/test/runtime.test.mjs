import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

test('workerd executes upgrade, protocol negotiation and binary-only policy', { timeout: 10000 }, async t => {
  const root = new URL('../', import.meta.url);
  const modules = Object.fromEntries(await Promise.all(['worker.mjs', 'relay.mjs', 'client-hello.mjs'].map(async path =>
    [path, { type: 'esm', contents: await readFile(new URL(path, root), 'utf8') }])));
  const runtime = new Miniflare({ workers: [{ config: { name: 'signal-webboost-test',
    compatibilityDate: '2026-11-14', manifest: { mainModule: 'worker.mjs',
      modulesRoot: root.pathname, modules } } }] });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
  });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'signal-tls-v1');
  const socket = response.webSocket;
  socket.accept();
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  socket.send('not binary');
  const event = await closed;
  assert.equal(event.code, 1003);
  const binaryResponse = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
  });
  const binarySocket = binaryResponse.webSocket;
  binarySocket.accept();
  const binaryClosed = new Promise(resolve => binarySocket.addEventListener('close', resolve, { once: true }));
  binarySocket.send(new Uint8Array([0, 0, 0, 0, 0]));
  assert.equal((await binaryClosed).code, 1008);
  const invalid = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel?host=example.com', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
  });
  assert.equal(invalid.status, 404);
  const sessions = [];
  for (let count = 0; count < 16; count++) {
    const opened = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
    });
    assert.equal(opened.status, 101);
    opened.webSocket.accept();
    sessions.push(opened.webSocket);
  }
  const exhausted = await runtime.dispatchFetch('https://proxy.twang.chat/v1/tls-tunnel', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' },
  });
  assert.equal(exhausted.status, 503);
  for (const client of sessions) client.close(1000);
});
