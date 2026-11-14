// End-to-end tests: real Firefox + Foxwright extension + MCP server.
//   node test/e2e.mjs            synthetic-input mode
//   FOXWRIGHT_E2E_TRUSTED=1 node test/e2e.mjs   trusted (WebDriver BiDi) mode
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';

const TRUSTED = !!process.env.FOXWRIGHT_E2E_TRUSTED;
const BASE = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;
const results = [];
let h, tabId;

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

function expect(cond, msg) {
  if (!cond)
    throw new Error(msg);
}

async function call(name, args = {}) {
  const r = await h.call(name, { tabId, ...args });
  if (r.isError)
    throw new Error(`${name} failed: ${r.text}`);
  return r;
}

async function pageHas(text, { retries = 10 } = {}) {
  let last = '';
  for (let i = 0; i < retries; i++) {
    last = (await call('read_page', { max_chars: 200000 })).text;
    if (last.includes(text))
      return last;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`page never contained ${JSON.stringify(text)}. Last outline:\n${last.slice(0, 1500)}`);
}

async function refFor(query, role) {
  const r = await call('find', { query });
  const lines = r.text.split('\n').filter(l => l.includes('[ref='));
  const line = lines.find(l => !role || l.trim().startsWith(`- ${role}`)) || lines[0];
  expect(line, `find "${query}" returned nothing:\n${r.text}`);
  return { ref: /\[ref=([^\]]+)\]/.exec(line)[1], line, coord: (/at \((\d+), (\d+)\)/.exec(line) || []).slice(1).map(Number) };
}

async function js(code) {
  // javascript_tool on the Full build; the harness's page probe on the store build.
  return h.js(tabId, code);
}

async function nav(url) {
  await call('navigate', { url: BASE + url });
}

async function main() {
  console.log(`Foxwright e2e (${TRUSTED ? 'trusted / WebDriver BiDi' : 'synthetic events'})`);
  h = await start({ trusted: TRUSTED });

  await test('tabs_context_mcp creates the Foxwright group', async () => {
    const r = await h.call('tabs_context_mcp', { createIfEmpty: true });
    tabId = parseInt(/tabId (\d+)/.exec(r.text)[1], 10);
    expect(tabId > 0, r.text);
    if (TRUSTED && !r.text.includes('Input mode: trusted')) {
      // Say why, so a CI failure shows whether Firefox ever opened its debugging port.
      const port = Number(/:(\d+)\//.exec(h.bidiUrl)?.[1]);
      const probe = await new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(`port ${port} accepts connections`); });
        s.once('error', (e) => resolve(`port ${port}: ${e.code || e.message}`));
      });
      expect(false, `${r.text}\n[diagnostic] ${probe}`);
    }
    expect(r.text.includes(TRUSTED ? 'Input mode: trusted' : 'Input mode: synthetic'), r.text);
  });

  await test('navigate + read_page outline', async () => {
    await nav('/basic.html');
    const r = await call('read_page', {});
    expect(r.text.includes('textbox "Full name"') && r.text.includes('button "Create account"'), r.text.slice(0, 800));
  });

  await test('read_page interactive filter is compact', async () => {
    const r = await call('read_page', { filter: 'interactive' });
    expect(!/- generic \[active\]/.test(r.text), 'body generic should be filtered');
    expect(r.text.includes('combobox "Plan"') && r.text.includes('generic [ref=e31]') || r.text.includes('"Edit me:"'), r.text);
  });

  await test('find ranks the right element first', async () => {
    const { line } = await refFor('plan dropdown');
    expect(line.includes('combobox "Plan"'), line);
  });

  await test('form_input text field (by ref)', async () => {
    const { ref } = await refFor('Full name', 'textbox');
    const r = await call('form_input', { ref, value: 'Ada Lovelace' });
    expect(r.text.includes('Ada Lovelace'), r.text);
  });

  await test('click + type into email field', async () => {
    const { ref } = await refFor('Email', 'textbox');
    await call('computer', { action: 'left_click', ref });
    const r = await call('computer', { action: 'type', text: 'ada@example.com' });
    expect(r.text.includes('ada@example.com') || TRUSTED, r.text);
  });

  await test('form_input select by visible text', async () => {
    const { ref } = await refFor('Plan', 'combobox');
    const r = await call('form_input', { ref, value: 'Pro plan' });
    expect(r.text.includes('Pro plan'), r.text);
  });

  await test('form_input checkbox true', async () => {
    const { ref } = await refFor('accept the terms', 'checkbox');
    const r = await call('form_input', { ref, value: true });
    expect(r.text.includes('Checked: true'), r.text);
  });

  await test('click radio by ref', async () => {
    const { ref } = await refFor('Blue', 'radio');
    await call('computer', { action: 'left_click', ref });
    await pageHas('radio "Blue" [checked]');
  });

  await test('type multi-line text into textarea', async () => {
    const { ref } = await refFor('Bio', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: 'line one\nline two' });
    expect((await js('document.getElementById("bio").value')).includes('line one\\nline two'), 'textarea value');
  });

  await test('form_input range + date', async () => {
    const vol = await refFor('Volume', 'slider');
    await call('form_input', { ref: vol.ref, value: 70 });
    const bday = await refFor('Birthday');
    await call('form_input', { ref: bday.ref, value: '2026-09-23' });
    const v = await js('document.getElementById("vol").value + "|" + document.getElementById("bday").value');
    expect(v.includes('70|2026-09-23'), v);
  });

  await test('file_upload attaches a file', async () => {
    const f = path.join(os.tmpdir(), 'foxwright-test.txt');
    fs.writeFileSync(f, 'hello from foxwright');
    const { ref } = await refFor('Avatar');
    const r = await call('file_upload', { paths: [f], ref });
    expect(r.text.includes('foxwright-test.txt'), r.text);
    const v = await js('document.getElementById("avatar").files[0].name + ":" + document.getElementById("avatar").files[0].size');
    expect(v.includes('foxwright-test.txt:20'), v); // 'hello from foxwright' is 20 bytes
  });

  await test('submit button click submits the form with all values', async () => {
    const { ref } = await refFor('Create account', 'button');
    await call('computer', { action: 'left_click', ref });
    const t = await pageHas('SUBMITTED');
    expect(/SUBMITTED name=Ada Lovelace email=ada@example.com plan=pro terms=true color=blue bio=line one\\\\?n?line two/.test(t) || t.includes('SUBMITTED name=Ada Lovelace email=ada@example.com plan=pro terms=true color=blue'), t.match(/SUBMITTED[^\n]*/)?.[0]);
  });

  await test('Enter in a text field submits (implicit submission)', async () => {
    await js('document.getElementById("result").textContent = "reset"');
    const { ref } = await refFor('Full name', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'key', text: 'Enter' });
    await pageHas('SUBMITTED name=Ada');
  });

  await test('ctrl+a Backspace clears a field', async () => {
    const { ref } = await refFor('Full name', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'key', text: 'ctrl+a Backspace' });
    const v = await js('JSON.stringify(document.getElementById("name").value)');
    expect(v.includes('""'), v);
  });

  await test('Tab moves focus to the next field', async () => {
    const { ref } = await refFor('Full name', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'key', text: 'Tab' });
    const v = await js('document.activeElement.id');
    expect(v.includes('email'), v);
  });

  await test('left_click by screenshot coordinate', async () => {
    const shot = await call('computer', { action: 'screenshot' });
    expect(shot.images.length === 1, 'no image');
    const { coord } = await refFor('Clicked 0 times', 'button');
    expect(coord.length === 2, 'no coordinates from find');
    await call('computer', { action: 'left_click', coordinate: coord });
    await pageHas('Clicked 1 times');
  });

  await test('double_click', async () => {
    const { ref } = await refFor('Double-click me', 'button');
    await call('computer', { action: 'double_click', ref });
    await pageHas('double clicked');
  });

  await test('right_click reaches custom context menus', async () => {
    const { ref } = await refFor('Right-click me', 'button');
    await call('computer', { action: 'right_click', ref });
    await pageHas('custom menu opened');
  });

  await test('double_click selects a word, triple_click the paragraph', async () => {
    await js('document.getElementById("result").textContent = "foxwright selects words"; window.scrollTo(0,0)');
    const pos = JSON.parse(JSON.parse(await js('(() => { const p = document.getElementById("result"); const r = document.createRange(); r.selectNodeContents(p.firstChild); r.setStart(p.firstChild, 9); r.setEnd(p.firstChild, 16); const b = r.getBoundingClientRect(); return JSON.stringify([Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]); })()')));
    await call('computer', { action: 'double_click', coordinate: pos });
    const w = await js('window.getSelection().toString()');
    expect(w.includes('selects') && !w.includes('foxwright'), 'word selection: ' + w);
    await call('computer', { action: 'triple_click', coordinate: pos });
    const p = await js('window.getSelection().toString()');
    expect(p.includes('foxwright selects words'), 'paragraph selection: ' + p);
  });

  await test('hover fires mouseenter', async () => {
    const r = await call('find', { query: 'Hover over me' });
    const coord = /at \((\d+), (\d+)\)/.exec(r.text);
    if (coord) {
      await call('computer', { action: 'hover', coordinate: [Number(coord[1]), Number(coord[2])] });
    } else {
      const shot = await js('JSON.stringify((r => [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)])(document.getElementById("hoverbox").getBoundingClientRect()))');
      await call('computer', { action: 'hover', coordinate: JSON.parse(shot) });
    }
    await pageHas('hovered!');
  });

  await test('type into contenteditable', async () => {
    const r = await call('read_page', { filter: 'interactive' });
    const ref = /- textbox \[ref=(e\d+)\]: "?Edit me/.exec(r.text)?.[1];
    expect(ref, 'contenteditable not listed in interactive outline:\n' + r.text);
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: ' foxwright' });
    const v = await js('document.getElementById("ce").innerText');
    expect(v.includes('Edit me: foxwright') || v.includes('Edit me:\\u00a0foxwright') || /Edit me:.foxwright/.test(v), v);
  });

  await test('scroll_to + click element inside a scroll container', async () => {
    const { ref } = await refFor('Deep button', 'button');
    await call('computer', { action: 'scroll_to', ref });
    await call('computer', { action: 'left_click', ref });
    const v = await js('document.activeElement.id');
    expect(v.includes('deep'), v);
  });

  await test('scroll the page with the wheel', async () => {
    await js('window.scrollTo(0,0)');
    const r = await call('computer', { action: 'scroll', coordinate: [600, 300], scroll_direction: 'down', scroll_amount: 3 });
    const y = await js('window.scrollY');
    expect(parseFloat(y) > 100, `scrollY=${y}; ${r.text}`);
    await js('window.scrollTo(0,0)');
  });

  await test('HTML5 drag and drop', async () => {
    const pos = JSON.parse(JSON.parse(await js('document.getElementById("drop").scrollIntoView({block:"center"}); JSON.stringify([document.getElementById("drag"), document.getElementById("drop")].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)]; }))')));
    await call('computer', { action: 'left_click_drag', start_coordinate: pos[0], coordinate: pos[1] });
    await pageHas('dropped: fox');
  });

  await test('same-origin iframe: outline + click by ref', async () => {
    const r = await call('read_page', { filter: 'interactive' });
    const refs = [...r.text.matchAll(/button "Frame button" \[ref=(f\d+e\d+)\]/g)].map(m => m[1]);
    expect(refs.length === 2, 'expected two frame buttons:\n' + r.text);
    await call('computer', { action: 'left_click', ref: refs[0] });
    await pageHas('frame button clicked');
  });

  await test('cross-origin iframe: click by coordinate is forwarded into the frame', async () => {
    const pos = JSON.parse(JSON.parse(await js('JSON.stringify((() => { const f = document.getElementById("xo-frame"); f.scrollIntoView({block:"center"}); const r = f.getBoundingClientRect(); return [Math.round(r.left + 50), Math.round(r.top + 12)]; })())')));
    await call('computer', { action: 'left_click', coordinate: pos });
    const r = await call('read_page', { filter: 'interactive' });
    const count = (r.text.match(/frame button clicked/g) || []).length;
    expect(count === 2, 'cross-origin frame button should now be clicked too:\n' + r.text);
  });

  await test('type into an input inside a cross-origin iframe', async () => {
    const r = await call('read_page', { filter: 'interactive' });
    const ref = [...r.text.matchAll(/textbox "Frame input" \[ref=(f\d+e\d+)\]/g)].map(m => m[1])[1];
    expect(ref, 'no cross-origin frame input:\n' + r.text);
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: 'hi from the fox' });
    const t = (await call('read_page', { filter: 'interactive' })).text;
    expect(new RegExp('textbox "Frame input"( \\[active\\])? \\[ref=' + ref + '\\]: hi from the fox').test(t), t);
  });

  await test('read_console_messages captures logs from page start', async () => {
    await nav('/basic.html');
    const r = await call('read_console_messages', { pattern: 'fixture|loaded' });
    expect(r.text.includes('basic page loaded') && r.text.includes('fixture error message'), r.text);
  });

  await test('link click navigates; navigate back works', async () => {
    const { ref } = await refFor('Go to page two', 'link');
    const r = await call('computer', { action: 'left_click', ref });
    expect(r.text.includes('navigated to') && r.text.includes('page2.html'), r.text);
    await call('navigate', { url: 'back' });
    await pageHas('Sign up');
  });

  await test('target=_blank link opens a new tab inside the Foxwright group', async () => {
    const { ref } = await refFor('Open page two in new tab', 'link');
    await call('computer', { action: 'left_click', ref });
    await new Promise(r => setTimeout(r, 800));
    const ctx = await h.call('tabs_context_mcp', {});
    expect(ctx.text.includes('page2.html?from=blank'), ctx.text);
    const other = [...ctx.text.matchAll(/tabId (\d+):.*from=blank/g)].map(m => Number(m[1]))[0];
    if (other)
      await h.call('tabs_close_mcp', { tabId: other });
  });

  await test('read_network_requests sees fetches', async () => {
    await nav('/page2.html');
    await new Promise(r => setTimeout(r, 500));
    const r = await call('read_network_requests', { urlPattern: 'data.json' });
    expect(r.text.includes('200') && r.text.includes('data.json'), r.text);
  });

  await test('get_page_text', async () => {
    const r = await call('get_page_text', {});
    expect(r.text.includes('Page two'), r.text);
  });

  await test('zoom returns an image', async () => {
    const r = await call('computer', { action: 'zoom', region: [0, 0, 400, 200] });
    expect(r.images.length === 1, r.text);
  });

  // ---- React ----
  await test('React: click + type updates controlled input state', async () => {
    await nav('/react.html');
    const { ref } = await refFor('Your name', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: 'Foxwright' });
    await pageHas('Hello, Foxwright');
  });

  await test('React: form_input replaces value and React sees it', async () => {
    const { ref } = await refFor('Your name', 'textbox');
    await call('form_input', { ref, value: 'Inari' });
    await pageHas('Hello, Inari');
  });

  await test('React: checkbox, select, button clicks', async () => {
    await call('form_input', { ref: (await refFor('Agree', 'checkbox')).ref, value: true });
    await call('form_input', { ref: (await refFor('Size', 'combobox')).ref, value: 'Large' });
    const btn = await refFor('Count', 'button');
    await call('computer', { action: 'left_click', ref: btn.ref });
    await call('computer', { action: 'left_click', ref: btn.ref });
    await pageHas('Count: 2');
  });

  await test('React: typing drives an autocomplete', async () => {
    const { ref } = await refFor('Search', 'combobox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: 'fox' });
    await pageHas('option "foxglove"');
  });

  await test('form_input on a custom combobox types and picks the matching option', async () => {
    const { ref } = await refFor('Search', 'combobox');
    const r = await call('form_input', { ref, value: 'foxg' });
    expect(/Chose "foxglove"/.test(r.text), r.text);
    const v = await js('document.getElementById("rsearch").value');
    expect(v.includes('foxglove'), v);
  });

  await test('React: Enter submits with the final state', async () => {
    const { ref } = await refFor('Your name', 'textbox');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'key', text: 'Enter' });
    const t = await pageHas('SAVED');
    expect(/SAVED \{\\?"name\\?":\\?"Inari\\?",\\?"agree\\?":true,\\?"size\\?":\\?"l\\?"\}/.test(t), t.match(/SAVED[^\n]*/)?.[0]);
  });

  // ---- ProseMirror ----
  await test('ProseMirror: typing, Enter, Backspace update the editor model', async () => {
    await nav('/editor.html');
    const r = await call('read_page', { filter: 'interactive' });
    const ref = /textbox \[ref=(e\d+)\]/.exec(r.text)?.[1];
    expect(ref, 'editor not found:\n' + r.text);
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'type', text: 'Hello fox' });
    await call('computer', { action: 'key', text: 'Enter' });
    await call('computer', { action: 'type', text: 'second!' });
    await call('computer', { action: 'key', text: 'Backspace' });
    const model = await js('pmView.state.doc.toJSON().content.map(p => (p.content||[]).map(t=>t.text).join("")).join("|")');
    expect(model.includes('Hello fox|second'), model);
  });

  // ---- isTrusted-gated behaviour ----
  await test(`anti-bot button (${TRUSTED ? 'should pass' : 'expected to reject synthetic clicks'})`, async () => {
    await nav('/trusted.html');
    const { ref } = await refFor('Strict button', 'button');
    await call('computer', { action: 'left_click', ref });
    await pageHas(TRUSTED ? 'TRUSTED CLICK' : 'rejected: untrusted click');
  });

  await test('window.open popup opens and joins the Foxwright group', async () => {
    const { ref } = await refFor('Open popup', 'button');
    await call('computer', { action: 'left_click', ref });
    await pageHas('popup opened');
    await new Promise(r => setTimeout(r, 500));
    const ctx = await h.call('tabs_context_mcp', {});
    expect(ctx.text.includes('popup=1'), 'popup tab should join the Foxwright group:\n' + ctx.text);
  });

  await test('javascript_tool returns values and reports trusted-event counts', async () => {
    const v = await js('window.trustedSummary()');
    expect(/"trusted": \d+/.test(v), v);
    console.log(`      events on trusted.html: ${v.replace(/\s+/g, ' ')}`);
  });

  await test('agent ergonomics: default tabId, find aliases, clamped numbers', async () => {
    await nav('/basic.html');
    const r = await h.call('find', { description: 'Create account button' }); // no tabId, alias for query
    expect(!r.isError && r.text.includes('Create account'), r.text);
    const s = await h.call('computer', { action: 'scroll', coordinate: [400, 300], scroll_direction: 'down', scroll_amount: 50 });
    expect(!s.isError, s.text);
  });

  await test('get_page_text: query returns only relevant passages; offset pages', async () => {
    await nav('/basic.html');
    const q = await call('get_page_text', { query: 'favorite color' });
    expect(/Passages matching/.test(q.text) && /Favorite color/i.test(q.text), q.text);
    const p1 = await call('get_page_text', { max_chars: 1000 });
    expect(p1.text.length < 1400, 'page size not respected');
  });

  await test('browser_batch runs several steps in one call', async () => {
    await nav('/react.html');
    const name = (await refFor('Your name', 'textbox')).ref;
    const count = (await refFor('Count', 'button')).ref;
    const r = await call('browser_batch', { actions: [
      { tool: 'form_input', args: { ref: name, value: 'Batch' } },
      { tool: 'computer', args: { action: 'left_click', ref: count } },
      { tool: 'computer', args: { action: 'left_click', ref: count } },
      { tool: 'computer', args: { action: 'screenshot' } },
    ] });
    expect(/4\. computer screenshot/.test(r.text) && r.images.length === 1, r.text);
    await pageHas('Hello, Batch');
    await pageHas('Count: 2');
  });

  await test('gif_creator records actions and exports a GIF', async () => {
    await call('gif_creator', { action: 'start_recording' });
    await nav('/react.html');
    const { ref } = await refFor('Count', 'button');
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'left_click', coordinate: [100, 100] });
    await call('gif_creator', { action: 'stop_recording' });
    const r = await call('gif_creator', { action: 'export', filename: 'e2e-test.gif' });
    const file = /to (\S+\.gif)/.exec(r.text)?.[1];
    expect(file && fs.existsSync(file), r.text);
    const head = fs.readFileSync(file).subarray(0, 6).toString();
    expect(head === 'GIF89a' && /[4-9]-frame|\d\d-frame/.test(r.text), r.text);
    fs.rmSync(file, { force: true });
  });

  await test('gif_creator export options: labels and overlays drawn by the extension, or turned off', async () => {
    await call('gif_creator', { action: 'start_recording' });
    await nav('/react.html');
    const { ref } = await refFor('Count', 'button');
    await call('computer', { action: 'left_click', ref, action_summary: 'Clicks the Count button' });
    await call('computer', { action: 'left_click_drag', start_coordinate: [60, 60], coordinate: [260, 160] });
    await call('gif_creator', { action: 'stop_recording' });
    const full = await call('gif_creator', { action: 'export', filename: 'e2e-full.gif' });
    const plain = await call('gif_creator', { action: 'export', filename: 'e2e-plain.gif', options: { showClickIndicators: false, showDragPaths: false, showActionLabels: false, showProgressBar: false, showWatermark: false, quality: 30 } });
    const fileOf = (r) => /to (\S+\.gif)/.exec(r.text)?.[1];
    expect(fileOf(full) && fileOf(plain), `${full.text}\n${plain.text}`);
    expect(!/only click circles/.test(full.text), `overlays should be drawn by the extension: ${full.text}`);
    const [a, b] = [fs.statSync(fileOf(full)).size, fs.statSync(fileOf(plain)).size];
    expect(a > b, `the full GIF (labels, arrows, 186 colors) should be bigger than the plain one (32 colors): ${a} vs ${b} bytes`);
    for (const r of [full, plain])
      fs.rmSync(fileOf(r), { force: true });
    await call('gif_creator', { action: 'clear' });
  });

  await test('gif_creator export ignores directories in the file name', async () => {
    await call('gif_creator', { action: 'start_recording' });
    await call('computer', { action: 'left_click', coordinate: [100, 100] });
    await call('gif_creator', { action: 'stop_recording' });
    const r = await call('gif_creator', { action: 'export', filename: '../../foxwright-escape.gif' });
    const file = /to (\S+\.gif)/.exec(r.text)?.[1];
    expect(file && path.dirname(file) === h.gifDir && path.basename(file).includes('foxwright-escape'), `GIF written outside the GIF folder: ${r.text}`);
    fs.rmSync(file, { force: true });
  });

  await test('password values never reach the agent', async () => {
    await nav('/frames2.html');
    const outline = (await call('read_page', { max_chars: 200000 })).text;
    expect(!outline.includes('hunter2'), `password leaked in read_page:\n${outline.slice(0, 800)}`);
    expect(/password, 14 characters/.test(outline), outline.slice(0, 800));
    const { ref } = await refFor('Password', 'textbox');
    const r = await call('computer', { action: 'left_click', ref });
    expect(!r.text.includes('hunter2'), r.text);
    const k = await call('computer', { action: 'key', text: 'End' });
    expect(!k.text.includes('hunter2'), k.text);
    const f = await call('find', { query: 'password' });
    expect(!f.text.includes('hunter2'), f.text);
  });

  await test('srcdoc iframe: form_input into its field', async () => {
    const outline = await pageHas('Coupon code');
    const line = outline.split('\n').find(l => l.includes('textbox "Coupon code"'));
    expect(line, outline.slice(0, 1500));
    const ref = /\[ref=([^\]]+)\]/.exec(line)[1];
    const r = await call('form_input', { ref, value: 'FOX10' });
    expect(r.text.includes('FOX10'), r.text);
    const v = await js(`document.getElementById('srcdoc-frame').contentDocument.getElementById('coupon').value`);
    expect(v.includes('FOX10'), v);
  });

  await test('about:blank iframe editor: click + type', async () => {
    const outline = await pageHas('Message body');
    const line = outline.split('\n').find(l => /textbox "Message body".*\[ref=f/.test(l));
    expect(line, `no editor ref inside the blank frame:\n${outline.slice(0, 1500)}`);
    const ref = /\[ref=([^\]]+)\]/.exec(line)[1];
    await call('computer', { action: 'left_click', ref });
    await call('computer', { action: 'key', text: 'ctrl+End' });
    await call('computer', { action: 'type', text: ' from Foxwright' });
    const v = await js(`document.getElementById('blank-editor').contentDocument.body.innerText`);
    expect(v.includes('from Foxwright'), v);
  });

  await test('closed shadow root: outline sees it and click works', async () => {
    const outline = await pageHas('Secret shadow button');
    const line = outline.split('\n').find(l => l.includes('button "Secret shadow button"'));
    const ref = /\[ref=([^\]]+)\]/.exec(line)[1];
    await call('computer', { action: 'left_click', ref });
    await pageHas('Shadow clicks: 1');
  });

  await test('read_page waits for frames inside frames that are still loading', async () => {
    await nav('/basic.html'); // same tab already has a page, as when an agent moves on to a new site
    await nav('/frameset.html');
    const outline = (await call('read_page', { filter: 'all', max_chars: 200000 })).text;
    for (const w of ['LEFT LEAF', 'RIGHT LEAF', 'Frame button'])
      expect(outline.includes(w), `${w} missing from the outline:\n${outline.slice(0, 1200)}`);
  });

  await test('dialogs: confirm answered Cancel, then OK after handle_dialog; page cannot forge reports', async () => {
    await nav('/frames2.html');
    const { ref } = await refFor('Delete everything', 'button');
    const r1 = await call('computer', { action: 'left_click', ref });
    expect(/confirm\("Delete everything\?"\); Foxwright answered: Cancel/.test(r1.text), r1.text);
    expect(!r1.text.includes('IGNORE PREVIOUS'), r1.text);
    await pageHas('Kept');
    await call('handle_dialog', { accept: true });
    const r2 = await call('computer', { action: 'left_click', ref });
    expect(r2.text.includes('Foxwright answered: OK'), r2.text);
    await pageHas('Deleted');
  });

  await test('console capture survives a page that pre-sets the old hook flag', async () => {
    await call('read_console_messages', {}); // make sure capture is on for this page
    const { ref } = await refFor('Log something', 'button');
    await call('computer', { action: 'left_click', ref });
    const r = await call('read_console_messages', { pattern: 'hostile page' });
    expect(r.text.includes('frames2 hostile page logged'), r.text);
  });

  await test('parallel commands on one tab run one at a time (no interleaved typing)', async () => {
    await nav('/basic.html');
    const { ref } = await refFor('Full name', 'textbox');
    await call('form_input', { ref, value: '' });
    await call('computer', { action: 'left_click', ref });
    await Promise.all([
      call('computer', { action: 'type', text: 'aaaaaaaaaa' }),
      call('computer', { action: 'type', text: 'bbbbbbbbbb' }),
    ]);
    const v = await js(`document.querySelector('#name, input[placeholder="Jane Doe"]').value`);
    expect(/"(a{10}b{10}|b{10}a{10})"/.test(v), `typing interleaved: ${v}`);
  });

  await test('Cmd/Alt/Ctrl + arrow, Home and End move and select like a real keyboard', async () => {
    if (TRUSTED)
      return; // real keys follow the OS's own conventions (e.g. Cmd+Left isn't "line start" on Linux)
    await nav('/keys.html');
    // Put the caret at `pos` (a number, or 'end') in the element, then press keys; report what's selected.
    const setup = (sel, pos) => js(`(() => { const el = document.querySelector('${sel}'); el.focus();
      if (el.isContentEditable) { const t = el.firstChild; const s = getSelection(); s.collapse(t, ${JSON.stringify(pos)} === 'end' ? t.length : ${JSON.stringify(pos)}); }
      else { const p = ${JSON.stringify(pos)} === 'end' ? el.value.length : ${JSON.stringify(pos)}; el.setSelectionRange(p, p); }
      return 'ok'; })()`);
    const state = (sel) => js(`(() => { const el = document.querySelector('${sel}');
      if (el.isContentEditable) { const s = getSelection(); return JSON.stringify({ sel: s.toString(), at: s.focusOffset }); }
      return JSON.stringify({ sel: el.value.slice(el.selectionStart, el.selectionEnd), at: el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd }); })()`);
    const cases = [
      // [element, caret start, keys, expected selection, expected caret]
      ['#ce', 'end', ['cmd+left'], '', 0],
      ['#ce', 'end', ['cmd+left', 'shift+right'], 'K', 1],
      ['#ce', 'end', ['cmd+left', 'shift+alt+right'], 'Kitsune', 7],
      ['#ce', 0, ['cmd+right'], '', 17],
      ['#ce', 'end', ['alt+left'], '', 12],
      ['#ce', 'end', ['ctrl+left'], '', 12],
      ['#ce', 'end', ['shift+cmd+left'], 'Kitsune was here.', 0],
      ['#field', 'end', ['cmd+left'], '', 0],
      ['#field', 'end', ['cmd+left', 'shift+alt+right'], 'Kitsune', 7],
      ['#field', 'end', ['alt+left'], '', 12],
      ['#field', 'end', ['ctrl+left'], '', 12],
      ['#field', 0, ['ctrl+right'], '', 8],
      ['#field', 0, ['alt+right'], '', 7],
      ['#field', 'end', ['shift+ctrl+left'], 'here.', 12],
      ['#field', 'end', ['ctrl+home'], '', 0],
      ['#area', 18, ['cmd+left'], '', 11],
      ['#area', 11, ['cmd+right'], '', 28],
      ['#area', 18, ['cmd+up'], '', 0],
      ['#area', 0, ['ctrl+end'], '', 38],
      ['#area', 11, ['shift+cmd+right'], 'Kitsune was here.', 28],
    ];
    const bad = [];
    for (const [sel, pos, keys, wantSel, wantAt] of cases) {
      await setup(sel, pos);
      for (const k of keys)
        await call('computer', { action: 'key', text: k });
      const got = JSON.parse(JSON.parse(await state(sel)));
      if (got.sel !== wantSel || got.at !== wantAt)
        bad.push(`${sel} from ${pos}, ${keys.join(' ')}: selected ${JSON.stringify(got.sel)} caret ${got.at}; expected ${JSON.stringify(wantSel)} caret ${wantAt}`);
    }
    expect(!bad.length, `${bad.length}/${cases.length} wrong:\n      ${bad.join('\n      ')}`);
  });

  // ---- waiting for the page (instead of fixed sleeps) ----
  const jsv = async (code) => JSON.parse(await js(code));

  await test('wait {text}: returns as soon as fetched data shows up', async () => {
    await nav('/waits.html');
    await call('computer', { action: 'left_click', ref: (await refFor('Load data', 'button')).ref });
    const t0 = Date.now();
    const r = await call('computer', { action: 'wait', text: 'Loaded 3 items', timeout: 8 });
    const ms = Date.now() - t0;
    expect(/^Waited \d+\.\d s for "Loaded 3 items" to appear/.test(r.text), r.text);
    expect(ms < 4000, `took ${ms} ms`);
    expect((await call('get_page_text')).text.includes('Loaded 3 items'), 'text not on the page afterwards');
  });

  await test('wait {text_gone} and {until: "idle"}', async () => {
    await call('computer', { action: 'left_click', ref: (await refFor('Load data', 'button')).ref });
    const r = await call('computer', { action: 'wait', text_gone: 'Loading', timeout: 8 });
    expect(/to go away/.test(r.text), r.text);
    await call('computer', { action: 'left_click', ref: (await refFor('Load data', 'button')).ref });
    const r2 = await call('computer', { action: 'wait', until: 'idle', timeout: 10 });
    expect(/settle/.test(r2.text), r2.text);
    const s = await jsv('document.getElementById("status").textContent');
    expect(s === 'Loaded 3 items', `idle returned while the page still showed ${JSON.stringify(s)} (${r2.text})`);
  });

  await test('wait times out with a clear error and what is on screen', async () => {
    const r = await h.call('computer', { tabId, action: 'wait', text: 'this text never appears', timeout: 1 });
    expect(r.isError && /Timed out after 1 s waiting for "this text never appears" to appear/.test(r.text) && /On screen now/.test(r.text) && /Load data/.test(r.text), r.text);
    const plain = await call('computer', { action: 'wait', duration: 0.2 });
    expect(/Waited 0.2s/.test(plain.text), plain.text);
  });

  await test('find {wait_for}: finds the field of a dialog that opens late, then typing reaches it', async () => {
    await nav('/waits.html');
    await call('computer', { action: 'left_click', ref: (await refFor('Search', 'button')).ref });
    const f = await call('find', { query: 'search docs box', wait_for: 'dialog "Search docs"', timeout: 5 });
    expect(/after waiting \d+\.\d s for dialog "Search docs"/.test(f.text) && /searchbox "Search docs" \[ref=/.test(f.text), f.text);
    await call('computer', { action: 'type', text: 'useState' });
    expect((await jsv('document.getElementById("typed").textContent')) === 'typed: useState', 'text did not reach the search box');
  });

  await test('type right after a click waits for a late dialog to take focus', async () => {
    await nav('/waits.html');
    await call('computer', { action: 'left_click', ref: (await refFor('Search', 'button')).ref });
    const r = await call('computer', { action: 'type', text: 'hooks' });
    // The note appears when the dialog was still on its way (the usual case); under load it may already be there.
    if (!/Waited \d+ ms for focus/.test(r.text)) console.log(`      (no wait was needed: ${r.text.split("\n")[0]})`);
    expect((await jsv('document.getElementById("typed").textContent')) === 'typed: hooks', `typed text went elsewhere: ${r.text}`);
  });

  await test('read_page {wait_for} and wait {ref_gone}', async () => {
    const r = await call('read_page', { filter: 'interactive', wait_for: 'searchbox "Search docs"' });
    expect(/^\(Waited \d+\.\d s for searchbox "Search docs"\.\)/.test(r.text), r.text.slice(0, 300));
    const dlg = /dialog "Search docs" \[ref=([^\]]+)\]/.exec((await call('read_page', {})).text)?.[1];
    expect(dlg, 'dialog ref not found');
    await call('computer', { action: 'left_click', ref: (await refFor('Close', 'button')).ref });
    const g = await call('computer', { action: 'wait', ref_gone: dlg, timeout: 5 });
    expect(/to go away/.test(g.text), g.text);
  });

  await test('clicking a menu button waits for the menu and reports it', async () => {
    const r = await call('computer', { action: 'left_click', ref: (await refFor('Actions', 'button')).ref });
    expect(/Opened: menu/.test(r.text), r.text);
    const o = await call('read_page', { filter: 'interactive' });
    expect(/menuitem "Rename"/.test(o.text), 'menu not in the next read_page:\n' + o.text.slice(0, 800));
  });

  await test('clicking a button that opens a dialog reports it and the focused field', async () => {
    const r = await call('computer', { action: 'left_click', ref: (await refFor('Edit profile', 'button')).ref });
    expect(/Opened: dialog "Edit profile" \[ref=/.test(r.text) && /Focus is now on <input#dlg-name>[^\n]*\[ref=/.test(r.text), r.text);
    const k = await call('computer', { action: 'key', text: 'Escape' });
    expect(/Closed: dialog "Edit profile"/.test(k.text), k.text);
  });

  await test('ordinary clicks get no popup notes', async () => {
    const r = await call('computer', { action: 'left_click', ref: (await refFor('Count 0', 'button')).ref });
    expect(!/Opened:|Closed:|Focus is now/.test(r.text), r.text);
  });

  // ---- read_page diffs ----
  await test('read_page {diff}: refs stay stable and only changes come back', async () => {
    await nav('/waits.html');
    const first = await call('read_page', { diff: true });
    // An earlier test read this URL before the reload: either reason means "full outline".
    expect(/Full outline: (there is no earlier read_page|the page navigated)/.test(first.text), first.text.slice(0, 300));
    const before = /button "Count 0" \[ref=([^\]]+)\]/.exec(first.text)?.[1];
    expect(before, 'counter not found');
    await call('computer', { action: 'left_click', ref: before });
    await call('computer', { action: 'left_click', ref: before });
    const d = await call('read_page', { diff: true });
    expect(new RegExp(`~ +- button "Count 2"[^\\n]*\\[ref=${before}\\]`).test(d.text) && /\(was: - button "Count 0"/.test(d.text), d.text);
    expect(d.text.length < first.text.length / 2, `diff (${d.text.length} chars) not much smaller than the outline (${first.text.length})`);
    const same = await call('read_page', { diff: true });
    expect(/No changes since the previous read_page/.test(same.text), same.text);
    await call('computer', { action: 'left_click', ref: (await refFor('Advanced settings', 'button')).ref });
    const d2 = await call('read_page', { diff: true });
    expect(/\+ +- button "Delete account"/.test(d2.text) && /button "Advanced settings"[^\n]*\[expanded\]/.test(d2.text), d2.text);
    await nav('/waits.html?again');
    const d3 = await call('read_page', { diff: true });
    expect(/Full outline: the page navigated/.test(d3.text), d3.text.slice(0, 300));
  });

  // ---- find: collapsed sections ----
  await test('find says when a match is inside a collapsed section', async () => {
    await nav('/waits.html');
    const a = await call('find', { query: 'Delete account' });
    expect(/button "Delete account" \(hidden: inside a collapsed section; expand it first with button "Advanced settings" \[ref=/.test(a.text), a.text);
    const b = await call('find', { query: 'Hidden pricing link' });
    expect(/link "Hidden pricing link" \(hidden: inside a collapsed section; expand it first with button "Pricing details"/.test(b.text), b.text);
    const c = await call('find', { query: 'Zero height link' });
    expect(/link "Zero height link" \[ref=[^\]]+\][^\n]*\(inside a collapsed section; expand it first with button "More links"/.test(c.text), c.text);
  });

  // ---- form_input papercuts ----
  await test('form_input on <select multiple>: array and comma list', async () => {
    const ref = (await refFor('Colors', 'listbox')).ref;
    const r = await call('form_input', { ref, value: ['Red', 'Blue'] });
    expect((await jsv('document.getElementById("picked").textContent')) === 'picked: r,b', r.text);
    await call('form_input', { ref, value: 'Green, Yellow' });
    expect((await jsv('document.getElementById("picked").textContent')) === 'picked: g,y', 'comma list not applied');
  });

  await test('form_input on contenteditable editors (plain and ProseMirror)', async () => {
    const ref = (await refFor('Notes', 'textbox')).ref;
    await call('form_input', { ref, value: 'First line\nSecond line' });
    const t = await jsv('document.getElementById("plain-ed").innerText');
    expect(/^First line\n+Second line$/.test(t.trim()), JSON.stringify(t));
    await nav('/editor.html');
    const pm = /textbox \[ref=(e\d+)\]/.exec((await call('read_page', { filter: 'interactive' })).text)?.[1];
    await call('form_input', { ref: pm, value: 'Replaced text\nwith two paragraphs' });
    const model = await js('pmView.state.doc.toJSON().content.map(p => (p.content||[]).map(t=>t.text).join("")).join("|")');
    expect(model.includes('Replaced text|with two paragraphs'), model);
  });

  // ---- get_page_text papercuts ----
  await test('get_page_text on a giant <pre>: exact text, all of it reachable', async () => {
    await nav('/pre.html');
    const r = await call('get_page_text', { max_chars: 5000 });
    expect(/Source: pre/.test(r.text), r.text.slice(0, 300));
    const total = Number(/of (\d+)\./.exec(r.text)?.[1]);
    expect(total > 1500000, `total ${total}`);
    const mid = await call('get_page_text', { offset: 2000, max_chars: 8000 });
    expect(mid.text.includes('    indented:   value with   spaces\n\n\n    after three blank lines'), 'whitespace not preserved:\n' + mid.text.slice(0, 1500));
    const end = await call('get_page_text', { offset: total - 200, max_chars: 1000 });
    expect(end.text.includes('LAST LINE OF THE LOG'), end.text.slice(-400));
    const q = await call('get_page_text', { query: 'checksum mismatch' });
    expect(/12345 ERROR worker-3 checksum mismatch/.test(q.text) && /matching lines/.test(q.text), q.text.slice(0, 600));
  });

  // ---- typing non-ASCII text ----
  await test('typing emoji, RTL and CJK text: exact value, input events, React state', async () => {
    const s = 'héllo 👋🏽 שלום عربي 日本語 👨‍👩‍👧 🇫🇷 é';
    await nav('/waits.html');
    await call('computer', { action: 'left_click', ref: (await refFor('Message', 'textbox')).ref });
    await call('computer', { action: 'type', text: s });
    const v = await jsv('document.getElementById("msg").value');
    expect(v === s, `plain input: ${JSON.stringify(v)}`);
    const n = await jsv('window.inputs');
    expect(n >= 10, `only ${n} input events`);
    await nav('/react.html');
    await call('computer', { action: 'left_click', ref: (await refFor('Your name', 'textbox')).ref });
    await call('computer', { action: 'type', text: s });
    const rv = await jsv('document.getElementById("rname").value');
    const echo = await jsv('document.getElementById("echo").textContent');
    expect(rv === s && echo === `Hello, ${s}`, `React: value ${JSON.stringify(rv)}, echo ${JSON.stringify(echo)}`);
  });

  // ---- PDFs in Firefox's viewer ----
  await test('get_page_text reads PDFs (simple, multipage paging/query, object streams)', async () => {
    await nav('/pdf/simple.pdf');
    const a = await call('get_page_text');
    expect(/Source: PDF, 1 page/.test(a.text) && a.text.includes('The quick brown fox jumps over the lazy dog.') && a.text.includes('café'), a.text.slice(0, 800));
    await nav('/pdf/multipage.pdf');
    const b = await call('get_page_text', { max_chars: 1000 });
    expect(/PDF, 3 pages/.test(b.text) && b.text.includes('[Page 1]') && b.text.includes('naïve – “ok” ✓ 日本'), b.text.slice(0, 1200));
    const q = await call('get_page_text', { query: 'population estimate' });
    expect(q.text.includes('Population estimate: 4,500 foxes.'), q.text);
    const off = await call('get_page_text', { offset: 300, max_chars: 1000 });
    expect(/Showing characters 300–/.test(off.text) || off.text.includes('Text inside a form XObject'), off.text.slice(0, 600));
    await nav('/pdf/objstm.pdf');
    const c = await call('get_page_text');
    expect(c.text.includes('The first flag – a déjà vu moment.'), c.text.slice(0, 600));
  });

  await test('get_page_text explains encrypted and image-only PDFs', async () => {
    await nav('/pdf/encrypted.pdf');
    const e = await h.call('get_page_text', { tabId });
    expect(e.isError && /encrypted/.test(e.text) && !/Secret text/.test(e.text), e.text);
    await nav('/pdf/image-only.pdf');
    const i = await h.call('get_page_text', { tabId });
    expect(i.isError && /no text layer/.test(i.text), i.text);
  });

  await test('javascript_tool: a slow async script times out but the page stays usable', async () => {
    if (h.isStore)
      return; // javascript_tool only exists in the Full build
    await nav('/basic.html');
    const r = await h.call('javascript_tool', { tabId, text: 'await new Promise(r => setTimeout(r, 4000)); 1', timeout: 1 });
    expect(r.isError && /didn't finish within 1 s/.test(r.text) && /responsive/.test(r.text), r.text);
    const after = await call('find', { query: 'Full name' });
    expect(/textbox "Full name"/.test(after.text), after.text);
  });

  await test('javascript_tool: an endless loop times out, later calls fail fast, navigate recovers the tab', async () => {
    if (h.isStore)
      return; // javascript_tool only exists in the Full build
    await nav('/basic.html?loop');
    const t0 = Date.now();
    const r = await h.call('javascript_tool', { tabId, text: 'while (true) {}', timeout: 2 });
    expect(r.isError && /still running after 2 s/.test(r.text) && Date.now() - t0 < 15000, r.text);
    const t1 = Date.now();
    const busy = await h.call('read_page', { tabId });
    expect(busy.isError && /still running a javascript_tool script/.test(busy.text) && Date.now() - t1 < 10000, busy.text);
    await nav('/page2.html');
    const ok = await call('read_page', {});
    expect(/page two/i.test(ok.text), ok.text.slice(0, 300));
  });

  await test('tab outside the Foxwright group is refused', async () => {
    const r = await h.call('read_page', { tabId: 1 });
    expect(r.isError && /not in the Foxwright tab group|does not exist/.test(r.text), r.text);
  });

  await h.stop();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (${TRUSTED ? 'trusted' : 'synthetic'} mode)`);
  fs.mkdirSync('test/results', { recursive: true });
  fs.writeFileSync(`test/results/e2e-${TRUSTED ? 'trusted' : 'synthetic'}.json`, JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await h?.stop();
  } catch { /* ignore */ }
  process.exit(2);
});
