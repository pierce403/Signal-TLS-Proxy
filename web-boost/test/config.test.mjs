import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('overlay config is exactly the upstream native config with the proxy patch', () => {
  const native = read('../../data/nginx-terminate/nginx.conf');
  assert.match(native, /server nginx-relay:4433;/);
  assert.equal(read('../nginx-terminate/nginx.conf'), native.replace('server nginx-relay:4433;', 'server web-boost:4433;'));
  assert.doesNotMatch(read('../../docker-compose.yml'), /web-boost/);
  assert.match(read('../compose.yml'), /\.\/web-boost\/nginx-terminate:\/usr\/conf\.d:ro/);
});
