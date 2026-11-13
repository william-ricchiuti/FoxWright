/* global browser */
// Extension-owned confirmation window. Pages can't reach or restyle it.
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

function answer(a) {
  browser.runtime.sendMessage({ kind: 'prompt-answer', id, answer: a }).finally(() => window.close());
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
  if (req.tabTitle) {
    // No control, zero-width or text-direction characters: they can reorder or hide what is shown.
    const t = req.tabTitle.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
    $('tabline').textContent = `Page title (set by the website): “${t.length > 70 ? t.slice(0, 70) + '…' : t}”`;
  }
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
    $('always').hidden = true;
  } else if (req.type === 'pair') {
    document.title = 'Foxwright: use this Firefox?';
    $('title').textContent = 'Use this Firefox for the AI agent?';
    $('subtitle').textContent = 'An AI agent connected through Foxwright wants to pick a browser.';
    $('body').textContent = 'Several Firefox windows or profiles are connected to Foxwright. If this is the one the agent should work in, click Connect. This browser is named:';
    $('once').textContent = 'Connect';
    $('deny').textContent = 'Not this one';
    $('always').hidden = true;
  } else {
    $('body').textContent = req.type === 'frame'
      ? 'The AI agent wants to read and interact with an embedded frame from:'
      : 'The AI agent wants to open, read and interact with pages on:';
  }
  // Clickjacking guard: the window can pop up under a cursor that's mid-click, so the buttons only
  // work after the window has been visible and focused for a moment (as Firefox's own dialogs do).
  const buttons = [$('deny'), $('once'), $('always')];
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      answer('deny');
  });
})();
