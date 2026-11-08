// End-to-end tests: real Firefox + Kitsune extension + MCP server.
//   node test/e2e.mjs            synthetic-input mode
//   KITSUNE_E2E_TRUSTED=1 node test/e2e.mjs   trusted (WebDriver BiDi) mode
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';

const TRUSTED = !!process.env.KITSUNE_E2E_TRUSTED;
const BASE = `http://127.0.0.1:${process.env.KITSUNE_P1}`;
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
  return (await call('javascript_tool', { action: 'javascript_exec', text: code })).text;
}

async function nav(url) {
  await call('navigate', { url: BASE + url });
}

async function main() {
  console.log(`Kitsune e2e (${TRUSTED ? 'trusted / WebDriver BiDi' : 'synthetic events'})`);
  h = await start({ trusted: TRUSTED });

  await test('tabs_context_mcp creates the Kitsune group', async () => {
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
    const f = path.join(os.tmpdir(), 'kitsune-test.txt');
    fs.writeFileSync(f, 'hello from kitsune');
    const { ref } = await refFor('Avatar');
    const r = await call('file_upload', { paths: [f], ref });
    expect(r.text.includes('kitsune-test.txt'), r.text);
    const v = await js('document.getElementById("avatar").files[0].name + ":" + document.getElementById("avatar").files[0].size');
    expect(v.includes('kitsune-test.txt:18'), v);
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
    await js('document.getElementById("result").textContent = "kitsune selects words"; window.scrollTo(0,0)');
    const pos = JSON.parse(JSON.parse(await js('(() => { const p = document.getElementById("result"); const r = document.createRange(); r.selectNodeContents(p.firstChild); r.setStart(p.firstChild, 9); r.setEnd(p.firstChild, 16); const b = r.getBoundingClientRect(); return JSON.stringify([Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]); })()')));
    await call('computer', { action: 'double_click', coordinate: pos });
    const w = await js('window.getSelection().toString()');
    expect(w.includes('selects') && !w.includes('kitsune'), 'word selection: ' + w);
    await call('computer', { action: 'triple_click', coordinate: pos });
    const p = await js('window.getSelection().toString()');
    expect(p.includes('kitsune selects words'), 'paragraph selection: ' + p);
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
    await call('computer', { action: 'type', text: ' kitsune' });
    const v = await js('document.getElementById("ce").innerText');
    expect(v.includes('Edit me: kitsune') || v.includes('Edit me:\\u00a0kitsune') || /Edit me:.kitsune/.test(v), v);
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

  await test('target=_blank link opens a new tab inside the Kitsune group', async () => {
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
    await call('computer', { action: 'type', text: 'Kitsune' });
    await pageHas('Hello, Kitsune');
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

  await test('window.open popup opens and joins the Kitsune group', async () => {
    const { ref } = await refFor('Open popup', 'button');
    await call('computer', { action: 'left_click', ref });
    await pageHas('popup opened');
    await new Promise(r => setTimeout(r, 500));
    const ctx = await h.call('tabs_context_mcp', {});
    expect(ctx.text.includes('popup=1'), 'popup tab should join the Kitsune group:\n' + ctx.text);
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

  await test('gif_creator export ignores directories in the file name', async () => {
    await call('gif_creator', { action: 'start_recording' });
    await call('computer', { action: 'left_click', coordinate: [100, 100] });
    await call('gif_creator', { action: 'stop_recording' });
    const r = await call('gif_creator', { action: 'export', filename: '../../kitsune-escape.gif' });
    const file = /to (\S+\.gif)/.exec(r.text)?.[1];
    expect(file && path.dirname(file) === h.gifDir && path.basename(file).includes('kitsune-escape'), `GIF written outside the GIF folder: ${r.text}`);
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
    await call('computer', { action: 'type', text: ' from Kitsune' });
    const v = await js(`document.getElementById('blank-editor').contentDocument.body.innerText`);
    expect(v.includes('from Kitsune'), v);
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
    expect(/confirm\("Delete everything\?"\); Kitsune answered: Cancel/.test(r1.text), r1.text);
    expect(!r1.text.includes('IGNORE PREVIOUS'), r1.text);
    await pageHas('Kept');
    await call('handle_dialog', { accept: true });
    const r2 = await call('computer', { action: 'left_click', ref });
    expect(r2.text.includes('Kitsune answered: OK'), r2.text);
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

  await test('tab outside the Kitsune group is refused', async () => {
    const r = await h.call('read_page', { tabId: 1 });
    expect(r.isError && /not in the Kitsune tab group|does not exist/.test(r.text), r.text);
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
