// Read only the public ClientHello SNI needed for routing. TLS remains opaque.
export const SIGNAL_HOSTS = Object.freeze([
  'chat.signal.org', 'storage.signal.org', 'cdn.signal.org', 'cdn2.signal.org',
  'cdn3.signal.org', 'cdsi.signal.org', 'contentproxy.signal.org',
  'grpc.chat.signal.org', 'sfu.voip.signal.org', 'svr2.signal.org',
  'svrb.signal.org', 'updates.signal.org', 'updates2.signal.org',
]);
const allowed = new Set(SIGNAL_HOSTS);
const MAX_HELLO = 32 * 1024;
const MAX_PREFIX = 64 * 1024;
const bad = () => { throw new Error('Invalid TLS ClientHello'); };

function serverName(body) {
  let position = 0;
  const take = length => {
    if (position + length > body.length) bad();
    const value = body.subarray(position, position + length);
    position += length;
    return value;
  };
  const byte = () => take(1)[0];
  const word = () => { const bytes = take(2); return bytes[0] * 256 + bytes[1]; };
  const version = word();
  if (version < 0x0301 || version > 0x0303) bad();
  take(32); // random
  const session = byte();
  if (session > 32) bad();
  take(session);
  const ciphers = word();
  if (!ciphers || ciphers % 2) bad();
  take(ciphers);
  const compression = byte();
  if (!compression) bad();
  take(compression);
  const extensionsLength = word();
  if (position + extensionsLength !== body.length) bad();
  let name;
  const extensions = new Set();
  while (position < body.length) {
    const type = word();
    const extension = take(word());
    if (extensions.has(type)) bad();
    extensions.add(type);
    if (type !== 0) continue;
    if (extension.length < 5) bad();
    const listLength = extension[0] * 256 + extension[1];
    if (listLength !== extension.length - 2) bad();
    let offset = 2;
    const names = new Set();
    while (offset < extension.length) {
      if (offset + 3 > extension.length) bad();
      const nameType = extension[offset++];
      const length = extension[offset++] * 256 + extension[offset++];
      if (!length || offset + length > extension.length || names.has(nameType)) bad();
      names.add(nameType);
      if (nameType === 0) {
        const bytes = extension.subarray(offset, offset + length);
        if (length > 253 || bytes.some(value => value > 127)) bad();
        name = String.fromCharCode(...bytes).toLowerCase();
      }
      offset += length;
    }
  }
  if (!name || !allowed.has(name)) throw new Error('Signal hostname required');
  return name;
}

export class ClientHelloRouter {
  constructor() {
    this.bytes = new Uint8Array(MAX_PREFIX);
    this.length = 0;
    this.position = 0;
    this.handshake = new Uint8Array(MAX_HELLO + 4);
    this.handshakeLength = 0;
  }
  push(chunk) {
    if (this.length + chunk.length > MAX_PREFIX) throw new Error('ClientHello too large');
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    const combined = this.bytes;
    while (this.position + 5 <= this.length) {
      const position = this.position;
      const type = combined[position];
      const version = combined[position + 1] * 256 + combined[position + 2];
      const length = combined[position + 3] * 256 + combined[position + 4];
      if (type !== 22 || version < 0x0301 || version > 0x0303 || !length || length > 18432) bad();
      if (position + 5 + length > this.length) return null;
      const copyLength = Math.min(length, this.handshake.length - this.handshakeLength);
      this.handshake.set(combined.subarray(position + 5, position + 5 + copyLength), this.handshakeLength);
      this.handshakeLength += copyLength;
      const handshake = this.handshake;
      if (this.handshakeLength >= 4) {
        if (handshake[0] !== 1) bad();
        const helloLength = handshake[1] * 65536 + handshake[2] * 256 + handshake[3];
        if (helloLength > MAX_HELLO) throw new Error('ClientHello too large');
        if (this.handshakeLength >= helloLength + 4) {
          return { hostname: serverName(handshake.subarray(4, helloLength + 4)), bytes: combined.slice(0, this.length) };
        }
      }
      this.position += 5 + length;
    }
    return null;
  }
}
