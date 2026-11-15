// WebSocket for the test scripts on every supported Node version. Node 22 has a global
// WebSocket; Node 20 doesn't, so fall back to the `ws` package the helper already depends on
// (host/node_modules, installed by `npm ci --prefix host`). Both support addEventListener with
// the `open`/`message`/`error` events and `event.data` the test clients use.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  if (typeof globalThis.WebSocket === 'function')
    return globalThis.WebSocket;
  try {
    return createRequire(path.join(root, 'host', 'package.json'))('ws');
  } catch {
    throw new Error('No WebSocket: this Node has no global WebSocket (Node < 22) and host/node_modules/ws is missing. Run `npm ci --prefix host`.');
  }
}

export const WebSocket = load();
