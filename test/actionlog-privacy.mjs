// The activity log's privacy rules (src/background/actionlog.js), without a browser: whatever a
// careless or hostile agent puts in its tool arguments and summaries, and whatever a page chooses
// as title or button name, the stored log holds no typed text, form values, full addresses, file
// names or paths. Also: every permission answer is recorded with its kind, duration and level.
//   node test/actionlog-privacy.mjs
const stored = {};
globalThis.browser = {
  storage: {
    local: {
      get: async (d) => ({ ...d, ...stored }),
      set: async (o) => { Object.assign(stored, JSON.parse(JSON.stringify(o))); },
      remove: async (k) => { delete stored[k]; },
    },
  },
};
const log = await import('../src/background/actionlog.js');
const { state } = await import('../src/background/state.js');

let failed = 0, passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

/** What index.js does for a tool call: the agent's summary if it survives, else Foxwright's description. */
function logCall(tool, args, origin = 'https://shop.example') {
  const own = log.summaryForLog(tool, args);
  const text = own || log.describeForLog(tool, args);
  if (text)
    log.logEvent({ kind: 'action', origin, tabId: 7, text, own: !!own, result: 'allowed' });
}
const dump = async () => {
  await log.flushLog();
  return JSON.stringify(stored.activityLog || []);
};

console.log('Foxwright activity log: privacy');
await log.loadLog();

const SECRETS = ['hunter2secret', 'correct horse battery', '4111 1111 1111 1111', 'reset-token-9f8e7d', '/Users/alice/Documents/tax-2025.pdf', 'tax-2025.pdf', 'C:\\Users\\alice\\passwords.txt', 'alice', 'q=private+search', 'sessionid=abc123', 'Delete my account forever', 'Inbox (3) - alice@example.com'];

await test('a careless or hostile agent\'s arguments and summaries leave no secrets in the log', async () => {
  // Summaries that repeat what is typed, set or uploaded.
  logCall('computer', { tabId: 7, action: 'type', text: 'hunter2secret', action_summary: 'Types the password hunter2secret into the login form' });
  logCall('computer', { tabId: 7, action: 'type', text: 'correct horse battery', action_summary: 'Typing CORRECT HORSE BATTERY' });
  logCall('form_input', { tabId: 7, ref: 'e12', value: '4111 1111 1111 1111', action_summary: 'Sets card number to 4111 1111 1111 1111' });
  logCall('form_input', { tabId: 7, ref: 'e12<script>alice', value: 'x' });
  logCall('file_upload', { tabId: 7, paths: ['/Users/alice/Documents/tax-2025.pdf'], action_summary: 'Uploads tax-2025.pdf to the portal' });
  logCall('file_upload', { tabId: 7, paths: ['/Users/alice/Documents/tax-2025.pdf'], action_summary: 'Attaches the file' });
  // Summaries with addresses and paths the tool arguments don't contain.
  logCall('computer', { tabId: 7, action: 'left_click', ref: 'e3', action_summary: 'Opens https://shop.example/reset?token=reset-token-9f8e7d#frag now' });
  logCall('computer', { tabId: 7, action: 'left_click', ref: 'e3', action_summary: 'Goes to shop.example/search?q=private+search&sessionid=abc123' });
  logCall('computer', { tabId: 7, action: 'left_click', ref: 'e3', action_summary: 'Reads /Users/alice/Documents/tax-2025.pdf and C:\\Users\\alice\\passwords.txt and ~/alice/notes' });
  // Text smuggled through fields that aren't the summary.
  logCall('computer', { tabId: 7, action: 'key', text: 'hunter2secret' });
  logCall('computer', { tabId: 7, action: 'key', text: 'shift+h shift+u shift+n' });
  logCall('computer', { tabId: 7, action: 'key', text: 'ctrl+hunter2secret' });
  logCall('computer', { tabId: 7, action: 'hunter2secret', ref: 'hunter2secret' });
  logCall('computer', { tabId: 7, action: 'left_click', coordinate: ['hunter2secret', 4], ref: 'alice' });
  logCall('navigate', { tabId: 7, url: 'https://user:hunter2secret@shop.example/reset?token=reset-token-9f8e7d' }, 'https://shop.example/reset?token=reset-token-9f8e7d');
  logCall('navigate', { tabId: 7, url: 'shop.example/search?q=private+search' }, 'shop.example/search?q=private+search');
  logCall('javascript_tool', { tabId: 7, text: 'document.cookie="sessionid=abc123"', action_summary: 'Runs document.cookie="sessionid=abc123"' });
  logCall('handle_dialog', { tabId: 7, accept: true, prompt_text: 'hunter2secret', action_summary: 'Answers the prompt with hunter2secret' });
  // A file: page: only the scheme is kept, never the folder.
  log.logEvent({ kind: 'action', url: 'file:///Users/alice/Documents/tax-2025.pdf', tabId: 7, text: 'Read the page', result: 'allowed' });
  // Questions: page-chosen titles and element names, agent summaries, file names.
  log.logQuestion({ type: 'site', origin: 'https://shop.example/reset?token=reset-token-9f8e7d', tabTitle: 'Inbox (3) - alice@example.com' }, 'asked');
  log.logQuestion({ type: 'action', origin: 'https://shop.example', tabTitle: 'Inbox (3) - alice@example.com', element: { role: 'button', name: 'Delete my account forever', reason: 'x' }, summary: 'Deletes alice' }, 'once', 'full');
  log.logQuestion({ type: 'upload', origin: 'file:///Users/alice/Documents/', files: ['/Users/alice/Documents/tax-2025.pdf (3 KB)'] }, 'once', 'full');
  const all = await dump();
  for (const s of SECRETS)
    expect(!all.toLowerCase().includes(s.toLowerCase()), `the stored log contains ${JSON.stringify(s)}:\n${all.split('},{').filter(l => l.toLowerCase().includes(s.toLowerCase())).join('\n')}`);
  expect(!/[?#]/.test(JSON.parse(all).map(e => e.o || '').join('')), 'an origin with a query or fragment was stored');
});

await test('harmless summaries are kept, with addresses cut down to the site', async () => {
  expect(log.summaryForLog('computer', { action: 'left_click', action_summary: 'Opens the Filters menu' }) === 'Opens the Filters menu', 'plain summary changed');
  expect(log.summaryForLog('computer', { action: 'left_click', action_summary: 'Sends the reply to pat@example.com' }) === 'Sends the reply to pat@example.com', 'summary with an e-mail address changed');
  const s = log.summaryForLog('computer', { action: 'left_click', action_summary: 'Opens https://shop.example/cart/items?id=5 in a tab' });
  expect(s === 'Opens https://shop.example in a tab', s);
  expect(log.summaryForLog('computer', { action: 'left_click', action_summary: 'Chooses either/or and 3/4 of them' }) === 'Chooses either/or and 3/4 of them', 'slashes in ordinary words were taken for a path');
  expect(log.describeForLog('computer', { action: 'key', text: 'ctrl+a Delete' }) === 'Pressed ctrl+a Delete', log.describeForLog('computer', { action: 'key', text: 'ctrl+a Delete' }));
  expect(log.describeForLog('computer', { action: 'key', text: 'Tab Tab Enter' }) === 'Pressed Tab Tab Enter', 'key names');
  expect(log.describeForLog('computer', { action: 'left_click', ref: 'f2e14' }) === 'Left click on f2e14', log.describeForLog('computer', { action: 'left_click', ref: 'f2e14' }));
});

await test('every permission answer is recorded: kind, how long, and read-only or not', async () => {
  await log.clearLog();
  const o = 'https://bank.example';
  const answers = [
    [{ type: 'site', origin: o }, 'asked'],
    [{ type: 'site', origin: o }, 'hour', 'read'],
    [{ type: 'site', origin: o }, 'always', 'full'],
    [{ type: 'frame', origin: o }, 'once', 'read'],
    [{ type: 'upgrade', origin: o }, 'asked'],
    [{ type: 'upgrade', origin: o }, 'hour', 'full'],
    [{ type: 'upgrade', origin: o }, 'deny', 'full'],
    [{ type: 'action', origin: o, element: { name: 'Pay' } }, 'asked'],
    [{ type: 'action', origin: o, element: { name: 'Pay' } }, 'once', 'full'],
    [{ type: 'action', origin: o, element: { name: 'Pay' } }, 'deny', 'full'],
    [{ type: 'action', origin: o, element: { name: 'Pay' } }, 'timeout', 'full'],
  ];
  for (const [req, answer, level] of answers)
    log.logQuestion(req, answer, level);
  const e = log.readLog().entries.slice().reverse();
  expect(e.length === answers.length, `${e.length} of ${answers.length} entries were kept: ${JSON.stringify(e)}`);
  const at = (i) => `${e[i].k}/${e[i].r}/${e[i].lv || '-'}`;
  expect(at(1) === 'site/hour/read' && /read only/i.test(e[1].x), `1-hour read-only approval: ${JSON.stringify(e[1])}`);
  expect(at(2) === 'site/always/full', `always: ${at(2)}`);
  expect(at(3) === 'frame/once/read', `frame read-only: ${at(3)}`);
  expect(at(4) === 'upgrade/asked/-' && at(5) === 'upgrade/hour/full' && at(6) === 'upgrade/denied/-', `upgrade: ${at(4)} ${at(5)} ${at(6)}`);
  expect(at(7) === 'confirm/asked/-' && at(8) === 'confirm/once/-' && at(9) === 'confirm/denied/-' && at(10) === 'confirm/timeout/-', `confirmations: ${at(7)} ${at(8)} ${at(9)} ${at(10)}`);
  expect(e.every(x => x.o === o) && !JSON.stringify(e).includes('Pay'), 'origin missing, or the element name was stored');
  state.paused = true;
  log.logQuestion({ type: 'site', origin: o }, 'deny');
  state.paused = false;
  expect(log.readLog().entries[0].r === 'paused', 'a denial caused by Stop should be logged as paused');
});

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed}/${passed} passed`);
process.exit(failed ? 1 : 0);
