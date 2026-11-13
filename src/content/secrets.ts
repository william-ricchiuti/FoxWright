// Which inputs hold a password, even after a page's "Show password" button turns them into
// ordinary text fields. Values of these are never shown to the agent.

const seen = new WeakSet<Element>();

export function isSecretInput(el: Element | null): boolean {
  if (!(el instanceof HTMLInputElement))
    return false;
  if (el.type === 'password' || seen.has(el) || /password/i.test(el.getAttribute('autocomplete') || '')) {
    seen.add(el);
    return true;
  }
  return false;
}

function mark(root: ParentNode) {
  for (const el of Array.from(root.querySelectorAll('input[type=password]')))
    seen.add(el);
}

/** Remember password fields from now on (called once when the content script loads). */
export function watchSecrets() {
  (globalThis as any).__zenkoSecret = isSecretInput; // used by the patched page-outline code
  mark(document);
  try {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.oldValue === 'password')
          seen.add(r.target as Element);
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof HTMLInputElement && n.type === 'password')
            seen.add(n);
          else if (n instanceof Element)
            mark(n);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
  } catch { /* document not observable */ }
}
