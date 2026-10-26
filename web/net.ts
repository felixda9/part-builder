// WebSocket link to the editor server with auto-reconnect.

import type { ClientMessage, ServerMessage } from '../src/core/protocol';
import { toast } from './dom';
import type { Store } from './store';

export function connect(store: Store): void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let everOpened = false;

  const open = () => {
    store.setConn('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      store.setConn('open');
      if (everOpened) toast('Reconnected to the editor server', 'ok');
      everOpened = true;
    };
    sock.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (m.type === 'state') store.setState(m);
      else if (m.type === 'error') {
        store.setError(m.message);
        toast(m.message, 'error');
      } else if (m.type === 'notice') toast(m.message, m.level === 'warn' ? 'warn' : 'info');
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      store.setConn('closed');
      const delay = Math.min(10000, 400 * 2 ** retry++);
      setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  };

  store.send = (m: ClientMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(m));
      return true;
    }
    toast('Not connected to the editor server', 'error');
    return false;
  };

  open();
}
