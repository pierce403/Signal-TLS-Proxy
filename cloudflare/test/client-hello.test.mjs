import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ClientHelloRouter, SIGNAL_HOSTS } from '../client-hello.mjs';
import { hello, record, join } from './helpers.mjs';

test('Worker destination list stays exactly aligned with production Nginx', () => {
  const source = readFileSync(new URL('../../data/nginx-relay/nginx.conf', import.meta.url), 'utf8');
  const mapping = source.split('map $ssl_preread_server_name $name {')[1].split('default')[0];
  const names = [...mapping.matchAll(/^\s+([\w.-]+\.signal\.org)\s+/gm)].map(match => match[1]);
  assert.deepEqual([...SIGNAL_HOSTS].sort(), names.sort());
});

test('routes only the unchanged stock proxy Signal host allowlist', () => {
  for (const hostname of SIGNAL_HOSTS) {
    const bytes = hello(hostname);
    const result = new ClientHelloRouter().push(bytes);
    assert.equal(result.hostname, hostname);
    assert.deepEqual(result.bytes, bytes);
  }
  for (const host of ['example.com', 'chat.signal.org.attacker.test', '127.0.0.1',
    'localhost', 'CHAT.SIGNAL.ORG.', '', 'chat.signal.org\0evil']) {
    assert.throws(() => new ClientHelloRouter().push(hello(host)));
  }
});
test('fragmented WebSocket chunks and TLS records preserve bytes', () => {
  const original = hello();
  const body = original.subarray(5);
  const bytes = join(record(body.subarray(0, 6)), record(body.subarray(6)));
  const router = new ClientHelloRouter();
  for (let index = 0; index < bytes.length - 1; index++) {
    assert.equal(router.push(bytes.subarray(index, index + 1)), null);
  }
  const result = router.push(bytes.subarray(-1));
  assert.equal(result.hostname, 'chat.signal.org');
  assert.deepEqual(result.bytes, bytes);
});
test('no incomplete prefix selects an upstream', () => {
  const bytes = hello();
  for (let length = 0; length < bytes.length; length++) {
    assert.equal(new ClientHelloRouter().push(bytes.subarray(0, length)), null);
  }
});
test('malformed, duplicate and oversized hellos fail closed', () => {
  assert.throws(() => new ClientHelloRouter().push(hello('chat.signal.org', { duplicateSni: true })));
  const wrongType = hello(); wrongType[0] = 23;
  assert.throws(() => new ClientHelloRouter().push(wrongType));
  const wrongVersion = hello(); wrongVersion[2] = 0;
  assert.throws(() => new ClientHelloRouter().push(wrongVersion));
  assert.throws(() => new ClientHelloRouter().push(new Uint8Array(65537)), /too large/);
  assert.throws(() => new ClientHelloRouter().push(record(new Uint8Array([1, 1, 0, 0]))), /too large/);
});
