// get_page_text: readable text of the page, preferring the main article.

/**
 * A page that is essentially one big <pre> (plain-text files, logs, source code shown by Firefox):
 * its text is returned exactly, whitespace and blank lines included.
 */
function mainPre(body: HTMLElement, bodyLen: number): HTMLPreElement | null {
  const pres = body.querySelectorAll('pre');
  if (!pres.length || pres.length > 3)
    return null;
  let best: HTMLPreElement | null = null;
  for (const p of Array.from(pres)) {
    if (!best || (p.textContent || '').length > (best.textContent || '').length)
      best = p;
  }
  const len = (best?.textContent || '').length;
  return best && len > 200 && len >= bodyLen * 0.8 ? best : null;
}

export function pageText(args: { maxChars?: number } = {}) {
  const max = args.maxChars ?? 5000000;
  const body = document.body;
  if (!body)
    return { title: document.title, url: location.href, text: '', source: 'empty' };
  // innerText lays out the whole page; for a huge plain-text document, textContent is far cheaper.
  const rough = (body.textContent || '').length;
  const pre = mainPre(body, rough);
  if (pre) {
    let text = pre.textContent || '';
    const totalChars = text.length;
    const truncated = text.length > max;
    if (truncated)
      text = text.slice(0, max);
    return { title: document.title, url: location.href, text, source: 'pre (plain text, shown as is)', truncated, totalChars, preformatted: true };
  }
  const bodyText = body.innerText || '';
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('article, main, [role="main"], #content, #main, .post, .article, .entry-content'));
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const len = (c.innerText || '').trim().length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  let source = 'body';
  let text = bodyText;
  if (best && bestLen > 400 && bestLen > bodyText.length * 0.35) {
    text = best.innerText;
    source = best.tagName.toLowerCase() + (best.id ? '#' + best.id : '');
  }
  text = text.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const totalChars = text.length;
  const truncated = text.length > max;
  if (truncated)
    text = text.slice(0, max);
  return { title: document.title, url: location.href, text, source, truncated, totalChars };
}
