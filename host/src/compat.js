// What to do and say when the three parts of Foxwright are different versions: the extension
// (updated by Firefox from the add-ons store, possibly days after a release while Mozilla reviews
// it), the helper (updated by `setup`) and the MCP server (a process the AI client keeps running
// until it is restarted). Pure functions, shared by the MCP server and `doctor`; no I/O.

/** [major, minor, patch] of "0.8.1" (missing or odd parts count as 0), or null if there is no version. */
export function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

/** -1, 0 or 1; null when either side is unknown. `parts`: how many of major.minor.patch count. */
export function compareVersions(a, b, parts = 3) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y)
    return null;
  for (let i = 0; i < parts; i++) {
    if (x[i] !== y[i])
      return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Releases are compatible within one minor version (0.8.0 and 0.8.3 work together). */
export const olderMinor = (a, b) => compareVersions(a, b, 2) === -1;

export const SETUP_LATEST = 'npx foxwright-firefox@latest setup';
/** How the extension gets updated: Firefox does it, nothing to run. */
export const EXTENSION_UPDATE_HINT = 'Firefox updates the extension by itself once the new version is in the add-ons store, which can be a few days after a release while Mozilla reviews it. To check now: about:addons → gear menu → "Check for Updates".';

// ---------- options the connected extension is too old for ----------

/** The extension version that added each option the MCP server offers (older extensions ignore them silently). */
const SINCE = '0.8.0';

const tooOld = (what, extVersion) => `${what} need${/s$/.test(what) ? '' : 's'} Foxwright extension ${SINCE.replace(/\.0$/, '')} or newer; the extension in this Firefox is ${extVersion}.`;

/**
 * Adapt one tool call to the connected extension.
 * Returns { args } unchanged when the extension can do it all, or
 *   { args, note }  the call still makes sense without the new option: send it without, and tell the agent plainly, or
 *   { error }       it doesn't: an older extension would do something else and report success.
 * `extVersion` null (not known) changes nothing.
 */
export function adaptToExtension(tool, args, extVersion) {
  if (!extVersion || compareVersions(extVersion, SINCE) !== -1)
    return { args };
  const a = { ...args };
  const notes = [];
  if (tool === 'read_page') {
    if (a.diff) {
      delete a.diff;
      notes.push(`${tooOld('read_page {diff}', extVersion)} This is the full outline instead.`);
    }
    if (a.wait_for !== undefined) {
      notes.push(`${tooOld('read_page {wait_for}', extVersion)} The page was read at once, without waiting for ${JSON.stringify(a.wait_for)}: if it isn't in the outline below, wait with computer {action: "wait", duration: 2} and read again.`);
      delete a.wait_for;
      delete a.timeout;
    }
  } else if (tool === 'find') {
    if (a.wait_for !== undefined) {
      notes.push(`${tooOld('find {wait_for}', extVersion)} The search ran at once, without waiting for ${JSON.stringify(a.wait_for)}: if what you want isn't listed, wait with computer {action: "wait", duration: 2} and call find again.`);
      delete a.wait_for;
      delete a.timeout;
    }
  } else if (tool === 'computer' && a.action === 'wait') {
    const cond = ['text', 'text_gone', 'ref_gone', 'until'].filter(k => a[k] !== undefined && a[k] !== '');
    if (cond.length)
      return { error: `${tooOld(`computer wait with ${cond.join('/')}`, extVersion)} Nothing was waited for. Use computer {action: "wait", duration: N} (seconds, max 10) and then check the page with read_page or find. ${EXTENSION_UPDATE_HINT}` };
  }
  if (!notes.length)
    return { args };
  return { args: a, note: `Note: ${notes.join(' ')} ${EXTENSION_UPDATE_HINT}` };
}

/** Rewrite an older extension's answer where it is misleading (PDFs: readable from 0.8 on). */
export function explainOldExtensionError(tool, message, extVersion) {
  if (!extVersion || compareVersions(extVersion, SINCE) !== -1)
    return null;
  if (/built-in PDF viewer/.test(String(message)))
    return `This tab shows a PDF. Reading PDFs (get_page_text) needs Foxwright extension ${SINCE.replace(/\.0$/, '')} or newer; the extension in this Firefox is ${extVersion}, which can't read or screenshot Firefox's PDF viewer. ${EXTENSION_UPDATE_HINT}`;
  return null;
}

// ---------- version mismatch, said once per connection ----------

/**
 * What the agent should know (and pass on) when versions differ, or null. The advice depends on
 * the direction: an older extension only needs patience (store review), an older helper needs
 * setup, an older MCP server needs the AI client restarted.
 *   mine: this MCP server; helperV: the helper Firefox is running; extV: the extension.
 */
export function describeVersionMismatch(mine, helperV, extV) {
  const out = [];
  if (olderMinor(extV, mine))
    out.push(`The Foxwright extension in Firefox (${extV}) is older than this MCP server (${mine}). Everything the extension already had keeps working; options added since (they say so when used) are unavailable until it updates. The user does NOT need to run setup again: ${EXTENSION_UPDATE_HINT}`);
  else if (olderMinor(mine, extV))
    out.push(`This MCP server (${mine}) is older than the Foxwright extension in Firefox (${extV}); some tools may misbehave. Tell the user to run \`${SETUP_LATEST}\` in a terminal and then restart this AI client (quit and reopen it), so it starts the updated MCP server.`);
  if (olderMinor(helperV, mine))
    out.push(`The Foxwright helper Firefox is running (${helperV}) is older than this MCP server (${mine}). Tell the user to run \`${SETUP_LATEST}\` in a terminal; if this message comes back afterwards, restart Firefox.`);
  else if (olderMinor(mine, helperV) && !olderMinor(mine, extV))
    out.push(`This MCP server (${mine}) is older than the installed Foxwright helper (${helperV}). Tell the user to restart this AI client (quit and reopen it) so it starts the updated MCP server; if its MCP settings start "npx foxwright-firefox@<version>" with a fixed version, that version needs updating too.`);
  return out.length ? `Version note: ${out.join(' ')}` : null;
}

/**
 * The same for `doctor`, which knows more: [{ level: 'warn' | 'bad', text, fix }].
 *   cmd: this doctor command; installed: the helper file setup installed; running: the helper a
 *   Firefox runs; ext: that Firefox's extension.
 */
export function doctorVersionFindings({ cmd, installed, running, ext }) {
  const out = [];
  const newestHelper = [running, installed].filter(Boolean).sort((a, b) => compareVersions(b, a) || 0)[0];
  if (ext && newestHelper && olderMinor(ext, newestHelper)) {
    out.push({ level: 'warn', text: `The Foxwright extension in that Firefox (${ext}) is older than the helper (${newestHelper}). It works, without the options added since`,
      fix: `Nothing to run for the older extension: ${EXTENSION_UPDATE_HINT}` });
  } else if (ext && newestHelper && olderMinor(newestHelper, ext)) {
    out.push({ level: 'bad', text: `The helper (${newestHelper}) is older than the Foxwright extension in that Firefox (${ext})`,
      fix: `Update the helper: ${SETUP_LATEST} . Then restart your AI client (quit and reopen it).` });
  }
  if (running && installed && compareVersions(running, installed) !== 0) {
    out.push({ level: 'warn', text: `That Firefox still runs helper ${running}; ${installed} is installed`,
      fix: 'Restart Firefox (or toggle the Foxwright extension off and on in about:addons) to start the installed helper.' });
  }
  if (cmd && installed && compareVersions(cmd, installed) !== 0) {
    out.push(compareVersions(cmd, installed) === 1
      ? { level: 'warn', text: `The installed helper is ${installed}; this command is the newer ${cmd}`, fix: `Install ${cmd}: ${SETUP_LATEST} . Then restart your AI client (quit and reopen it).` }
      : { level: 'warn', text: `This command is ${cmd}, older than the installed helper (${installed})`, fix: 'Use the newest doctor: npx foxwright-firefox@latest doctor' });
  }
  return out;
}

/** For the user, when an MCP server from before 0.8 knocked on the helper and was refused. */
export const OLD_CLIENT_USER_MSG = 'An AI client on this computer is still running an older Foxwright (from before 0.8), which this helper refuses. Restart that AI client: quit it completely and open it again.';
