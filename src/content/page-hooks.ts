// Runs in the page's MAIN world at document start, only in agent tabs on approved sites.
// Emulates pointer capture for Zenko's synthetic pointer events (see below).
// Console capture and dialogs are handled from the isolated world instead (hooks.ts), where
// the page can't tamper with them. A page that disables this file only breaks its own drags.

(() => {
  const w = window as any;
  if (w.__zenkoPointerHooked)
    return;
  Object.defineProperty(w, '__zenkoPointerHooked', { value: true, enumerable: false });

  // ----- pointer capture for synthetic pointers -----
  // Pages (canvas apps, sliders, drag libraries) call setPointerCapture(e.pointerId) in
  // pointerdown. Firefox rejects that for synthetic events ("Invalid pointer id"), which
  // aborts the page's handler. During a Zenko-synthesized gesture we emulate capture
  // instead, and tell the content script which element captured the pointer.
  let synthetic = false;
  let emulated: Element | null = null;
  const EP = Element.prototype as any;
  const origSet = EP.setPointerCapture, origRelease = EP.releasePointerCapture, origHas = EP.hasPointerCapture;
  EP.setPointerCapture = function (this: Element, id: number) {
    try {
      return origSet.call(this, id);
    } catch (err) {
      if (!synthetic)
        throw err;
      emulated = this;
      this.dispatchEvent(new CustomEvent('zenko:pointer-capture', { bubbles: true, composed: true }));
    }
  };
  EP.releasePointerCapture = function (this: Element, id: number) {
    try {
      return origRelease.call(this, id);
    } catch (err) {
      if (!synthetic)
        throw err;
      if (emulated === this) {
        emulated = null;
        this.dispatchEvent(new CustomEvent('zenko:pointer-release', { bubbles: true, composed: true }));
      }
    }
  };
  EP.hasPointerCapture = function (this: Element, id: number) {
    return origHas.call(this, id) || (synthetic && emulated === this);
  };
  document.addEventListener('zenko:synthetic-pointer', (e: Event) => {
    synthetic = (e as CustomEvent).detail === 'on';
    if (!synthetic)
      emulated = null;
  });
})();
