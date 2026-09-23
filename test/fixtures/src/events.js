// Shared: record every interaction event with its isTrusted flag.
window.__events = [];
for (const t of ['click', 'mousedown', 'keydown', 'input', 'change', 'submit', 'focus']) {
  document.addEventListener(t, (e) => {
    window.__events.push({ type: t, trusted: e.isTrusted, target: (e.target.id || e.target.tagName) });
  }, true);
}
window.trustedSummary = () => {
  const s = { trusted: 0, untrusted: 0 };
  for (const e of window.__events) e.trusted ? s.trusted++ : s.untrusted++;
  return s;
};
