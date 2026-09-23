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
  $('tabline').textContent = req.tabTitle ? `Tab: ${req.tabTitle}` : '';
  if (req.type === 'upload') {
    document.title = 'Kitsune: allow file upload?';
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
  } else {
    $('body').textContent = req.type === 'frame'
      ? 'The AI agent wants to read and interact with an embedded frame from:'
      : 'The AI agent wants to open, read and interact with pages on:';
  }
  $('deny').addEventListener('click', () => answer('deny'));
  $('once').addEventListener('click', () => answer('once'));
  $('always').addEventListener('click', () => answer('always'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')
      answer('deny');
  });
})();
