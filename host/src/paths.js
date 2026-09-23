// Filesystem locations shared by the helper, the MCP server and setup.
// Dependency-free (node built-ins only) because the helper is copied to ~/.kitsune/app.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const EXTENSION_IDS = ['kitsune@william-ricchiuti.com', 'kitsune-full@william-ricchiuti.com'];
export const HOST_NAME = 'kitsune';

export function kitsuneDir() {
  return process.env.KITSUNE_HOME || path.join(os.homedir(), '.kitsune');
}

export function socketPath() {
  if (process.env.KITSUNE_SOCKET)
    return process.env.KITSUNE_SOCKET;
  if (process.platform === 'win32') {
    // Unguessable pipe name kept in the user's profile, so another local user can't
    // pre-create ("squat") the pipe and impersonate the helper.
    const idFile = path.join(kitsuneDir(), 'pipe-id');
    let id;
    try {
      id = fs.readFileSync(idFile, 'utf8').trim();
    } catch { /* first run */ }
    if (!id || !/^[a-f0-9]{32}$/.test(id)) {
      id = crypto.randomBytes(16).toString('hex');
      fs.mkdirSync(kitsuneDir(), { recursive: true });
      fs.writeFileSync(idFile, id);
    }
    return `\\\\.\\pipe\\kitsune-${id}`;
  }
  return path.join(kitsuneDir(), 'kitsune.sock');
}

export function nativeManifestDir() {
  const home = os.homedir();
  if (process.env.KITSUNE_NATIVE_MANIFEST_DIR)
    return process.env.KITSUNE_NATIVE_MANIFEST_DIR;
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts');
  if (process.platform === 'win32')
    return path.join(kitsuneDir()); // manifest lives here; registry key points to it
  return path.join(home, '.mozilla', 'native-messaging-hosts');
}

export function logPath() {
  return path.join(kitsuneDir(), 'helper.log');
}
