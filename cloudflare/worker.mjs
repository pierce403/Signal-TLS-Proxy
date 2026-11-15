import { connect } from 'cloudflare:sockets';
import { requestStatus, bridgeWebSocket, SUBPROTOCOL } from './relay.mjs';

let sessions = 0;
export default {
  fetch(request) {
    const status = requestStatus(request);
    if (status !== 101) return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
    if (sessions >= 16) return new Response(null, { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.binaryType = 'arraybuffer';
    server.accept();
    sessions++;
    bridgeWebSocket(server, connect, { onClose: () => sessions-- });
    return new Response(null, { status: 101, webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } });
  },
};
