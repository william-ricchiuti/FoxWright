// What to tell the person when the extension and the helper are different versions, or when an
// AI client is still running an MCP server the helper refuses. Shown by the toolbar popup and the
// setup page. The advice depends on the direction: an older helper needs `setup`; an older
// extension only needs patience (Firefox updates it once the store has the new version).
// Pure functions, no browser APIs.

const minorOf = (v) => {
  const m = /^(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
};
/** true if a is an older minor release than b; false if not or if either is unknown. */
function olderMinor(a, b) {
  const x = minorOf(a), y = minorOf(b);
  return !!x && !!y && (x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]));
}

export const SETUP_LATEST = 'npx foxwright-firefox@latest setup';
/** How long after the helper last refused an old MCP server the popup keeps saying so. */
export const OLD_CLIENT_NOTE_MS = 10 * 60000;

/**
 * [{ kind, text, cmd? }] for the popup; empty when there is nothing to say.
 *   helperVersion: null for a helper from before 0.8 (it doesn't say its version).
 *   oldClientAt: when the helper last refused an MCP server from before 0.8 (ms since epoch), or 0.
 */
export function versionNotes({ connected, version, helperVersion, oldClientAt = 0, now = Date.now() }) {
  const notes = [];
  if (!connected)
    return notes;
  if (!helperVersion || olderMinor(helperVersion, version)) {
    notes.push({
      kind: 'helper-older',
      text: `The helper on this computer (${helperVersion || 'from before 0.8'}) is older than this extension (${version}). Update it from a terminal, then restart your AI client:`,
      cmd: SETUP_LATEST,
    });
  } else if (olderMinor(version, helperVersion)) {
    notes.push({
      kind: 'extension-older',
      text: `This extension (${version}) is older than the helper (${helperVersion}). Firefox updates it by itself once the new version is in the add-ons store, which can take a few days while Mozilla reviews it. You don't need to run anything. To check now, open about:addons, click the gear and choose "Check for Updates".`,
    });
  }
  if (oldClientAt && now - oldClientAt < OLD_CLIENT_NOTE_MS) {
    notes.push({
      kind: 'old-client',
      text: 'An AI client is still running an older Foxwright and can\'t connect. Restart your AI client: quit it completely and open it again.',
    });
  }
  return notes;
}
