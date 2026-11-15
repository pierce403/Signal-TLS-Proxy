import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeWebSocket, requestStatus, LIMITS } from '../relay.mjs';
import { TestWebSocket, fakeSocket, hello, join, tick } from './helpers.mjs';

test('upgrade validates method, exact path, absence of target query and subprotocol', () => {
  const request = (url = '/v1/tls-tunnel', options = {}) => new Request('https://proxy.twang.chat' + url,
    { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'signal-tls-v1' }, ...options });
  assert.equal(requestStatus(request()), 101);
  assert.equal(requestStatus(request('/v1/tls-tunnel?host=example.com')), 404);
  assert.equal(requestStatus(request('/other')), 404);
  assert.equal(requestStatus(request(undefined, { method: 'POST' })), 404);
  assert.equal(requestStatus(request(undefined, { headers: {} })), 426);
  assert.equal(requestStatus(request(undefined, { headers: { Upgrade: 'websocket' } })), 400);
});
test('inner SNI exclusively selects TCP443 without Worker TLS; byte order is preserved', async () => {
  const ws = new TestWebSocket();
  const socket = fakeSocket();
  const calls = [];
  const bridge = bridgeWebSocket(ws, (...args) => { calls.push(args); return socket; });
  try {
    const prefix = hello();
    ws.message(prefix.subarray(0, 9)); ws.message(prefix.subarray(9));
    ws.message(new Uint8Array([23, 1, 2, 3]));
    await tick();
    assert.deepEqual(calls, [[{ hostname: 'chat.signal.org', port: 443 }, { secureTransport: 'off', allowHalfOpen: false }]]);
    assert.deepEqual(join(...socket.writes), join(prefix, new Uint8Array([23, 1, 2, 3])));
    socket.receive(new Uint8Array([7, 8, 9]));
    await tick();
    assert.deepEqual(ws.sent, [new Uint8Array([7, 8, 9])]);
  } finally { bridge.close(); }
  assert.equal(socket.closedCount, 1);
});
test('non-Signal SNI and text never open an upstream', async () => {
  for (const input of [hello('example.com'), 'text']) {
    const ws = new TestWebSocket();
    let calls = 0;
    const bridge = bridgeWebSocket(ws, () => { calls++; return fakeSocket(); });
    ws.message(input); await tick();
    assert.equal(calls, 0); assert.equal(bridge.closed, true);
  }
});
test('large upstream reads become bounded binary frames without changing bytes', async () => {
  const ws = new TestWebSocket();
  const socket = fakeSocket();
  const bridge = bridgeWebSocket(ws, () => socket);
  try {
    ws.message(hello()); await tick();
    const response = new Uint8Array(180000).map((_value, index) => index % 251);
    socket.receive(response); await tick();
    assert.equal(ws.sent.length, 3);
    assert.ok(ws.sent.every(frame => frame.length <= LIMITS.maxMessage));
    assert.deepEqual(join(...ws.sent), response);
  } finally { bridge.close(); }
});
test('message and pending-write queue limits close the upstream', async () => {
  const ws = new TestWebSocket();
  const socket = fakeSocket({ write: () => new Promise(() => {}) });
  const bridge = bridgeWebSocket(ws, () => socket);
  ws.message(hello());
  await tick();
  for (let count = 0; count < 5; count++) ws.message(new Uint8Array(65536));
  assert.equal(bridge.closed, true); assert.equal(socket.closedCount, 1);
  const other = new TestWebSocket();
  const otherBridge = bridgeWebSocket(other, () => { throw new Error('must not connect'); });
  other.message(new Uint8Array(65537));
  assert.equal(otherBridge.closed, true);
});
test('stalled TCP open and incomplete ClientHello obey handshake timeout', async () => {
  for (const start of [false, true]) {
    const ws = new TestWebSocket();
    const socket = fakeSocket({ opened: new Promise(() => {}) });
    const bridge = bridgeWebSocket(ws, () => socket, { limits: { ...LIMITS, handshakeMs: 5 } });
    if (start) ws.message(hello());
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(bridge.closed, true); assert.equal(ws.closes[0].reason, 'Handshake timeout');
  }
});
test('byte budget, upstream failure and client close all release a session once', async () => {
  const ws = new TestWebSocket();
  const socket = fakeSocket();
  let closes = 0;
  const bridge = bridgeWebSocket(ws, () => socket, { limits: { ...LIMITS, maxSessionBytes: 200 }, onClose: () => closes++ });
  ws.message(hello()); await tick();
  socket.receive(new Uint8Array(201)); await tick();
  assert.equal(bridge.closed, true); assert.equal(closes, 1);
  ws.dispatchEvent(new Event('close')); assert.equal(closes, 1);
  const failWs = new TestWebSocket();
  const failed = bridgeWebSocket(failWs, () => { throw new Error('unreachable'); });
  failWs.message(hello()); await tick(); assert.equal(failed.closed, true);
  const client = new TestWebSocket(); const opened = fakeSocket();
  const clientBridge = bridgeWebSocket(client, () => opened);
  client.message(hello()); await tick(); client.dispatchEvent(new Event('close'));
  assert.equal(clientBridge.closed, true); assert.equal(opened.closedCount, 1);
});
