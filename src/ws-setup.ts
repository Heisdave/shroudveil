// Route nostr-tools WebSocket traffic through the sandbox HTTP egress proxy
// when one is configured (direct wss is blocked in this sandbox). On a phone
// or a normal server no proxy env is set and plain ws is used.
// Reused from the spike (scripts/proxied-ws.js), which proved this path.
import WebSocket from 'ws';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HttpsProxyAgent } = require('https-proxy-agent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useWebSocketImplementation } = require('nostr-tools/relay');

let done = false;
export function setupWebSocket(): void {
  if (done) return;
  done = true;
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    class ProxiedWebSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { agent });
      }
    }
    useWebSocketImplementation(ProxiedWebSocket);
  } else {
    useWebSocketImplementation(WebSocket);
  }
}
