/* global browser */
// Extension-owned confirmation window. Pages can't reach or restyle it.
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

function answer(a) {
  browser.runtime.sendMessage({ kind: 'prompt-answer', id, answer: a, readOnly: !$('readonly-row').hidden && $('readonly').checked }).finally(() => window.close());
}

/** Text chosen by a web page or the agent: one line, no control, zero-width or text-direction characters (they can reorder or hide what is shown), at most `max` characters. */
function untrusted(s, max) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

(async () => {
  const req = await browser.runtime.sendMessage({ kind: 'prompt-details', id });
  if (!req) {
    window.close();
    return;
  }
  $('origin').textContent = req.origin;
  // The title is chosen by the web page, so label it as such and keep it short: a hostile page
  // could otherwise use it to talk the user into allowing.
  if (req.tabTitle)
    $('tabline').textContent = `Page title (set by the website): “${untrusted(req.tabTitle, 70)}”`;
  const oneOff = () => {
    $('always').hidden = true;
    $('hour').hidden = true;
  };
  if (req.type === 'upload') {
    document.title = 'Foxwright: allow file upload?';
    $('title').textContent = 'Upload files to this site?';
    $('body').textContent = 'The AI agent wants to attach these files from your computer to a page on:';
    const ul = $('files');
    ul.hidden = false;
    for (const f of req.files || []) {
      const li = document.createElement('li');
      li.textContent = f;
      ul.appendChild(li);
    }
    $('once').textContent = 'Upload';
    oneOff();
  } else if (req.type === 'pair') {
    document.title = 'Foxwright: use this Firefox?';
    $('title').textContent = 'Use this Firefox for the AI agent?';
    $('subtitle').textContent = 'An AI agent connected through Foxwright wants to pick a browser.';
    $('body').textContent = 'Several Firefox windows or profiles are connected to Foxwright. If this is the one the agent should work in, click Connect. This browser is named:';
    $('once').textContent = 'Connect';
    $('deny').textContent = 'Not this one';
    oneOff();
  } else if (req.type === 'action') {
    // "Confirm before consequential actions": what Foxwright found on the page (the element's role
    // and name, chosen by the website) and what the agent says it is doing (its own words).
    document.title = 'Foxwright: allow this action?';
    $('title').textContent = 'Allow this action?';
    $('body').textContent = 'The AI agent is about to press something that may send, buy, delete or submit, on:';
    const el = req.element || {};
    $('element').hidden = false;
    $('elname').textContent = `${untrusted(el.role, 30) || 'Element'} named (by the website): “${untrusted(el.name, 80)}”`;
    $('elreason').textContent = `Foxwright asks because it ${untrusted(el.reason, 120)}.`;
    if (req.summary) {
      $('summary').hidden = false;
      $('summary').textContent = `The agent describes it as: “${untrusted(req.summary, 120)}”`;
    }
    $('once').textContent = 'Allow once';
    oneOff();
  } else if (req.type === 'upgrade') {
    document.title = 'Foxwright: allow clicking and typing?';
    $('title').textContent = 'Let the agent click and type here?';
    $('body').textContent = 'You allowed the agent to read this site only. It now wants to click, type or fill in forms on:';
  } else {
    // site or frame: the person can also choose read-only access.
    $('readonly-row').hidden = false;
    $('body').textContent = req.type === 'frame'
      ? 'The AI agent wants to read and interact with an embedded frame from:'
      : 'The AI agent wants to open, read and interact with pages on:';
  }
  // Clickjacking guard: the window can pop up under a cursor that's mid-click, so the buttons only
  // work after the window has been visible and focused for a moment (as Firefox's own dialogs do).
  const buttons = [$('deny'), $('once'), $('always'), $('hour'), $('readonly')];
  let armTimer = null;
  const disarm = () => {
    clearTimeout(armTimer);
    armTimer = null;
    buttons.forEach(b => { b.disabled = true; });
  };
  const pendingArm = () => armTimer !== null;
  const arm = () => {
    disarm();
    armTimer = setTimeout(() => {
      armTimer = null;
      buttons.forEach(b => { b.disabled = false; });
      $('deny').focus();
    }, 800);
  };
  disarm();
  window.addEventListener('blur', disarm);
  window.addEventListener('focus', arm);
  document.addEventListener('visibilitychange', () => (document.hidden ? disarm() : arm()));
  // Some window managers don't focus new windows: pointer movement inside it also counts as "seen".
  document.documentElement.addEventListener('pointermove', () => {
    if (buttons[0].disabled && !document.hidden && !pendingArm())
      arm();
  });
  if (document.hasFocus() || !document.hidden)
    arm();
  $('deny').addEventListener('click', () => answer('deny'));
  $('once').addEventListener('click', () => answer('once'));
  $('always').addEventListener('click', () => answer('always'));
  $('hour').addEventListener('click', () => answer('hour'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      answer('deny');
  });
})();
