// The Firefox profiles connected to Kitsune right now. Each one's helper writes
// ~/.kitsune/browsers/<pid>.json (see host.js) and listens on its own socket.
import fs from 'node:fs';
import path from 'node:path';
import { browsersDir } from './paths.js';
import { HelperClient } from './client.js';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Registry entries whose helper process is still running (stale files are removed). */
export function registeredBrowsers() {
  let names = [];
  try {
    names = fs.readdirSync(browsersDir()).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(browsersDir(), n);
    let e;
    try {
      e = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(e.pid) || !alive(e.pid)) {
      for (const f of [file, process.platform !== 'win32' ? e.socket : null].filter(Boolean)) {
        try {
          fs.unlinkSync(f);
        } catch { /* ignore */ }
      }
      continue;
    }
    if (typeof e.socket === 'string' && e.browserId)
      out.push(e);
  }
  return out.sort((a, b) => (a.started || 0) - (b.started || 0));
}

/** The socket of the browser with this id, or null if it isn't connected. */
export function socketFor(browserId) {
  return registeredBrowsers().find(e => e.browserId === browserId)?.socket || null;
}

/** Registered browsers that answer, with their status: [{ ...entry, clients, version, primary }]. */
export async function connectedBrowsers() {
  const list = registeredBrowsers();
  return (await Promise.all(list.map(async (e) => {
    const c = new HelperClient({ path: e.socket });
    try {
      const st = await c.status();
      return { ...e, name: st.browser?.name || e.name, clients: Math.max(0, (st.clients || 1) - 1), version: st.extension?.version || e.version, primary: !!st.browser?.primary };
    } catch {
      return null;
    } finally {
      c.close();
    }
  }))).filter(Boolean);
}
