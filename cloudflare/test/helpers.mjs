export const join = (...chunks) => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
};
const word = value => new Uint8Array([value >> 8, value & 255]);
export function hello(hostname = 'chat.signal.org', { duplicateSni = false } = {}) {
  const name = new TextEncoder().encode(hostname);
  const entry = join(new Uint8Array([0]), word(name.length), name);
  const extension = join(word(0), word(entry.length + 2), word(entry.length), entry);
  const extensions = duplicateSni ? join(extension, extension) : extension;
  const body = join(new Uint8Array([3, 3]), new Uint8Array(32),
    new Uint8Array([0]), word(2), new Uint8Array([0x13, 1]),
    new Uint8Array([1, 0]), word(extensions.length), extensions);
  const handshake = join(new Uint8Array([1, body.length >> 16, body.length >> 8, body.length & 255]), body);
  return record(handshake);
}
export const record = bytes => join(new Uint8Array([22, 3, 1]), word(bytes.length), bytes);
export class TestWebSocket extends EventTarget {
  sent = [];
  closes = [];
  send(data) { this.sent.push(new Uint8Array(data)); this.onSend?.(data); }
  close(code, reason) { this.closes.push({ code, reason }); this.onClose?.(); }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
export function fakeSocket({ opened = Promise.resolve(), write = async () => {} } = {}) {
  let controller;
  const socket = {
    opened, closed: new Promise(() => {}), writes: [], closedCount: 0,
    readable: new ReadableStream({ start(value) { controller = value; } }),
    writable: new WritableStream({ write(chunk) { socket.writes.push(new Uint8Array(chunk)); return write(chunk); } }),
    receive(bytes) { controller.enqueue(bytes); },
    end() { controller.close(); },
    close() { socket.closedCount++; return Promise.resolve(); },
  };
  return socket;
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
