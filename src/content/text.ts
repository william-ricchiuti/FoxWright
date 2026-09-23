// get_page_text: readable text of the page, preferring the main article.

export function pageText(args: { maxChars?: number } = {}) {
  const max = args.maxChars ?? 1000000;
  const body = document.body;
  if (!body)
    return { title: document.title, url: location.href, text: '', source: 'empty' };
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
  text = text.replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > max;
  if (truncated)
    text = text.slice(0, max);
  return { title: document.title, url: location.href, text, source, truncated, totalChars: bodyText.length };
}
