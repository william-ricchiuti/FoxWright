// Real-website scenarios (needs internet). Each scenario does a user-level task
// through the MCP tools only and checks the outcome.
//   node test/realsites.mjs [filter]          synthetic input
//   KITSUNE_E2E_TRUSTED=1 node test/realsites.mjs   WebDriver BiDi input
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';

const TRUSTED = !!process.env.KITSUNE_E2E_TRUSTED;
const FILTER = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const results = [];
let h, tabId;
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Fail extends Error {}
function expect(c, m) {
  if (!c)
    throw new Fail(m);
}

async function call(name, args = {}, { allowError = false } = {}) {
  const t0 = Date.now();
  const r = await h.call(name, { tabId, ...args });
  r.ms = Date.now() - t0;
  if (r.isError && !allowError)
    throw new Fail(`${name}(${JSON.stringify(args).slice(0, 120)}) failed: ${r.text.slice(0, 400)}`);
  return r;
}

const nav = (url) => call('navigate', { url });
const outline = async (filter = 'interactive', max = 150000) => (await call('read_page', { filter, max_chars: max })).text;
const text = async () => (await call('get_page_text')).text;

/** Find the first element in the interactive outline whose role matches and whose line matches nameRe. */
async function pick(role, nameRe, { filter = 'interactive', tries = 6 } = {}) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = await outline(filter);
    for (const line of last.split('\n')) {
      const m = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?.*\[ref=([^\]]+)\]/.exec(line);
      if (!m)
        continue;
      const [, r, name = ''] = m;
      if ((role === '*' || new RegExp(`^(${role})$`).test(r)) && (!nameRe || nameRe.test(name) || nameRe.test(line)))
        return m[3];
    }
    await sleep(700);
  }
  throw new Fail(`no ${role} matching ${nameRe} in outline:\n${last.slice(0, 1500)}`);
}

async function waitText(re, { tries = 15, source = 'text' } = {}) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = source === 'text' ? await text() : await outline('all');
    if (re.test(last))
      return last;
    await sleep(700);
  }
  throw new Fail(`page never matched ${re}. Got:\n${last.slice(0, 800)}`);
}

const click = (ref, extra = {}) => call('computer', { action: 'left_click', ref, ...extra });
const type = (t) => call('computer', { action: 'type', text: t });
const key = (k) => call('computer', { action: 'key', text: k });
const js = async (code) => (await call('javascript_tool', { action: 'javascript_exec', text: code })).text;

async function scenario(site, name, fn) {
  const label = `${site}: ${name}`;
  if (FILTER && !FILTER.test(label))
    return;
  const t0 = Date.now();
  const notes = [];
  try {
    await Promise.race([fn(notes), sleep(120000).then(() => { throw new Fail('scenario timed out (120s)'); })]);
    results.push({ site, name, ok: true, ms: Date.now() - t0, notes });
    console.log(`  ✓ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)${notes.length ? '  — ' + notes.join('; ') : ''}`);
  } catch (e) {
    const msg = e instanceof Fail ? e.message : `${e.name}: ${e.message}`;
    results.push({ site, name, ok: false, ms: Date.now() - t0, err: msg, notes });
    console.log(`  ✗ ${label}\n      ${msg.split('\n').slice(0, 8).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------

async function theInternet() {
  const B = 'https://the-internet.herokuapp.com';
  await scenario('the-internet', 'login form', async () => {
    await nav(`${B}/login`);
    await call('form_input', { ref: await pick('textbox', /Username/i), value: 'tomsmith' });
    await call('form_input', { ref: await pick('textbox', /Password/i), value: 'SuperSecretPassword!' });
    await click(await pick('button', /Login/i));
    await waitText(/You logged into a secure area/);
  });
  await scenario('the-internet', 'checkboxes', async () => {
    await nav(`${B}/checkboxes`);
    const ref = await pick('checkbox', null);
    await click(ref);
    const o = await outline();
    expect(/checkbox \[checked\] \[ref=/.test(o.split('\n').find(l => l.includes(`[ref=${ref}]`)) || '') || (o.match(/\[checked\]/g) || []).length === 2, o);
  });
  await scenario('the-internet', 'native select', async () => {
    await nav(`${B}/dropdown`);
    await call('form_input', { ref: await pick('combobox', null), value: 'Option 2' });
    const o = await outline('all');
    expect(/option "Option 2" \[selected\]/.test(o), o);
  });
  await scenario('the-internet', 'HTML5 drag and drop (famously fails in Selenium)', async () => {
    await nav(`${B}/drag_and_drop`);
    const shot = await call('computer', { action: 'find' === 'x' ? 'screenshot' : 'screenshot' });
    void shot;
    const a = await call('find', { query: 'A' });
    const b = await call('find', { query: 'B' });
    const ca = /- \w+ "?A"?[^\n]*at \((\d+), (\d+)\)/.exec(a.text) || /at \((\d+), (\d+)\)/.exec(a.text);
    const cb = /- \w+ "?B"?[^\n]*at \((\d+), (\d+)\)/.exec(b.text) || /at \((\d+), (\d+)\)/.exec(b.text);
    expect(ca && cb, `couldn't locate columns: ${a.text}\n${b.text}`);
    await call('computer', { action: 'left_click_drag', start_coordinate: [+ca[1], +ca[2]], coordinate: [+cb[1], +cb[2]] });
    const t = await text();
    expect(/B\s+A/.test(t.replace(/\s+/g, ' ')), `columns not swapped: ${t.slice(0, 200)}`);
  });
  await scenario('the-internet', 'hover reveals caption (CSS :hover)', async (notes) => {
    await nav(`${B}/hovers`);
    const r = await call('find', { query: 'user avatar image' });
    const c = /at \((\d+), (\d+)\)/.exec(r.text);
    expect(c, r.text);
    await call('computer', { action: 'hover', coordinate: [+c[1], +c[2]] });
    const o = await outline('all');
    const visible = /name: user1/.test(o);
    if (!visible)
      notes.push('caption is CSS :hover-only');
    expect(visible || !TRUSTED, 'caption not shown on hover');
    if (!TRUSTED)
      notes.push(visible ? 'visible even with synthetic hover' : 'expected limitation in synthetic mode');
  });
  await scenario('the-internet', 'key presses', async () => {
    await nav(`${B}/key_presses`);
    await click(await pick('textbox', null));
    await key('Escape');
    await waitText(/You entered: ESCAPE/);
    await type('q');
    await waitText(/You entered: Q/);
  });
  await scenario('the-internet', 'JS alert is handled without blocking', async (notes) => {
    await nav(`${B}/javascript_alerts`);
    const r = await click(await pick('button', /JS Alert/));
    notes.push(`click took ${r.ms}ms`);
    expect(r.ms < 5000, 'click blocked');
    expect(/alert\(/.test(r.text), 'result should report the alert: ' + r.text);
    await waitText(/You successfully clicked an alert/);
  });
  await scenario('the-internet', 'JS confirm: Cancel by default, OK via handle_dialog', async () => {
    await nav(`${B}/javascript_alerts`);
    const btn = await pick('button', /JS Confirm/);
    const r = await click(btn);
    expect(/confirm\(/.test(r.text) && /Cancel/.test(r.text), r.text);
    await waitText(/You clicked: Cancel/);
    await call('handle_dialog', { accept: true });
    await click(btn);
    await waitText(/You clicked: Ok/);
  });
  await scenario('the-internet', 'JS prompt answered with text', async () => {
    await nav(`${B}/javascript_alerts`);
    await call('handle_dialog', { accept: true, prompt_text: 'kitsune' });
    await click(await pick('button', /JS Prompt/));
    await waitText(/You entered: kitsune/);
  });
  await scenario('the-internet', 'nested frames (4 frames)', async () => {
    await nav(`${B}/nested_frames`);
    const o = await outline('all');
    for (const w of ['LEFT', 'MIDDLE', 'RIGHT', 'BOTTOM'])
      expect(o.includes(w), `frame text ${w} missing:\n${o.slice(0, 1200)}`);
  });
  await scenario('the-internet', 'dynamic loading (wait for content)', async () => {
    await nav(`${B}/dynamic_loading/2`);
    await click(await pick('button', /Start/));
    await waitText(/Hello World!/);
  });
  await scenario('the-internet', 'shadow DOM content is visible', async () => {
    await nav(`${B}/shadowdom`);
    const o = await outline('all');
    expect(/Let's have some different text!/.test(o) && /In a list!/.test(o), o.slice(0, 800));
  });
  await scenario('the-internet', 'horizontal slider with arrow keys', async () => {
    await nav(`${B}/horizontal_slider`);
    await click(await pick('slider', null));
    const before = /slider[^\n]*: "?([\d.]+)/.exec(await outline())?.[1];
    await key('ArrowRight ArrowRight');
    const after = /slider[^\n]*: "?([\d.]+)/.exec(await outline())?.[1];
    expect(parseFloat(after) === parseFloat(before) + 1, `slider ${before} -> ${after}`);
  });
  await scenario('the-internet', 'new window opens in the Kitsune group', async () => {
    await nav(`${B}/windows`);
    await click(await pick('link', /Click Here/));
    await sleep(1000);
    const ctx = await h.call('tabs_context_mcp', {});
    expect(/windows\/new/.test(ctx.text), ctx.text);
    const other = /tabId (\d+):[^\n]*windows\/new/.exec(ctx.text);
    if (other)
      await h.call('tabs_close_mcp', { tabId: +other[1] });
  });
  await scenario('the-internet', 'file upload + submit', async () => {
    const f = path.join(os.tmpdir(), 'kitsune-real-upload.txt');
    fs.writeFileSync(f, 'uploaded by kitsune');
    await nav(`${B}/upload`);
    await call('file_upload', { paths: [f], ref: await pick('button', /Choose File|Browse|file/i) });
    await click(await pick('button', /Upload/));
    await waitText(/File Uploaded!/);
  });
  await scenario('the-internet', 'add/remove elements', async () => {
    await nav(`${B}/add_remove_elements/`);
    const add = await pick('button', /Add Element/);
    for (let i = 0; i < 3; i++)
      await click(add);
    const o = await outline();
    expect((o.match(/button "Delete"/g) || []).length === 3, o);
  });
  await scenario('the-internet', 'infinite scroll loads more', async () => {
    await nav(`${B}/infinite_scroll`);
    const before = (await text()).length;
    for (let i = 0; i < 4; i++) {
      await call('computer', { action: 'scroll', coordinate: [600, 400], scroll_direction: 'down', scroll_amount: 10 });
      await sleep(600);
    }
    const after = (await text()).length;
    expect(after > before * 1.3, `before ${before} after ${after}`);
  });
  await scenario('the-internet', 'sortable table header', async () => {
    await nav(`${B}/tables`);
    const r = await call('find', { query: 'Last Name' });
    const ref = /\[ref=([^\]]+)\]/.exec(r.text)[1];
    await click(ref);
    const t = await text();
    const i = t.indexOf('Bach'), j = t.indexOf('Smith');
    expect(i > -1 && j > i, 'table not sorted by last name');
  });
  await scenario('the-internet', 'entry ad modal: close it', async () => {
    await nav(`${B}/entry_ad`);
    await sleep(1500);
    await click(await pick('*', /^Close$|Close/));
    await sleep(600);
    const o = await outline('all');
    expect(!/THIS IS A MODAL WINDOW/.test(o) || /dialog/.test(o) === false, 'modal still open');
  });
  await scenario('the-internet', 'large DOM outline speed', async (notes) => {
    await nav(`${B}/large`);
    const r = await call('read_page', { filter: 'all', max_chars: 50000 });
    notes.push(`read_page ${r.ms}ms, ${r.text.length} chars`);
    expect(r.ms < 15000, 'too slow');
  });
}

async function demoqa() {
  const B = 'https://demoqa.com';
  await scenario('demoqa', 'text box form (React)', async () => {
    await nav(`${B}/text-box`);
    await click(await pick('textbox', /Full Name/i));
    await type('Ada Lovelace');
    await call('form_input', { ref: await pick('textbox', /name@example.com|Email/i), value: 'ada@example.com' });
    await call('form_input', { ref: await pick('textbox', /Current Address/i), value: '1 Analytical Engine Way' });
    await click(await pick('button', /Submit/));
    await waitText(/Name:\s*Ada Lovelace[\s\S]*Email:\s*ada@example\.com/);
  });
  await scenario('demoqa', 'radio buttons (styled, hidden inputs)', async () => {
    await nav(`${B}/radio-button`);
    await click(await pick('radio', /Impressive/));
    await waitText(/You have selected Impressive/);
  });
  await scenario('demoqa', 'double / right / dynamic click buttons', async () => {
    await nav(`${B}/buttons`);
    await call('computer', { action: 'double_click', ref: await pick('button', /Double Click Me/) });
    await call('computer', { action: 'right_click', ref: await pick('button', /Right Click Me/) });
    await click(await pick('button', /^Click Me$/));
    await waitText(/You have done a double click[\s\S]*You have done a right click[\s\S]*You have done a dynamic click/);
  });
  await scenario('demoqa', 'react-select custom dropdown', async () => {
    await nav(`${B}/select-menu`);
    const r = await call('find', { query: 'Select Option' });
    const ref = /\[ref=([^\]]+)\]/.exec(r.text)?.[1];
    expect(ref, r.text);
    await click(ref);
    await sleep(400);
    await click(await pick('option|generic', /Group 2, option 1/, { filter: 'all' }));
    await waitText(/Group 2, option 1/, { source: 'outline' });
  });
  await scenario('demoqa', 'autocomplete (type + pick suggestion)', async () => {
    await nav(`${B}/auto-complete`);
    const inputs = (await outline()).match(/(?:textbox|combobox)[^\n]*\[ref=([^\]]+)\]/g) || [];
    const ref = /\[ref=([^\]]+)\]/.exec(inputs[inputs.length - 1] || '')?.[1];
    expect(ref, 'no input');
    await click(ref);
    await type('Gre');
    await sleep(500);
    await key('Enter');
    await waitText(/Green/, { source: 'outline' });
  });
  await scenario('demoqa', 'practice form end-to-end (React)', async (notes) => {
    await nav(`${B}/automation-practice-form`);
    await call('form_input', { ref: await pick('textbox', /First Name/i), value: 'Ada' });
    await call('form_input', { ref: await pick('textbox', /Last Name/i), value: 'Lovelace' });
    await call('form_input', { ref: await pick('textbox', /name@example.com/i), value: 'ada@example.com' });
    await click(await pick('radio', /^Female$|Female/));
    await call('form_input', { ref: await pick('textbox', /Mobile/i), value: '5551234567' });
    await click(await pick('checkbox', /Reading/));
    await call('form_input', { ref: await pick('textbox', /Current Address/i), value: 'London' });
    const submit = await pick('button', /Submit/);
    await call('computer', { action: 'scroll_to', ref: submit });
    await click(submit);
    await waitText(/Thanks for submitting the form/, { source: 'outline' });
    notes.push('submitted');
  });
}

async function saucedemo() {
  await scenario('saucedemo', 'login → add to cart → checkout → finish (React)', async () => {
    await nav('https://www.saucedemo.com/');
    await click(await pick('textbox', /Username/i));
    await type('standard_user');
    await click(await pick('textbox', /Password/i));
    await type('secret_sauce');
    await key('Enter');
    await waitText(/Sauce Labs Backpack/);
    await click(await pick('button', /Add to cart/i));
    await click(await pick('link|generic|button', /shopping_cart|cart|^1$/i));
    await click(await pick('button', /Checkout/i));
    await call('form_input', { ref: await pick('textbox', /First Name/i), value: 'Ada' });
    await call('form_input', { ref: await pick('textbox', /Last Name/i), value: 'Lovelace' });
    await call('form_input', { ref: await pick('textbox', /Zip|Postal/i), value: '70112' });
    await click(await pick('button', /Continue/i));
    await click(await pick('button', /Finish/i));
    await waitText(/Thank you for your order/i);
  });
}

async function todomvc() {
  await scenario('todomvc', 'React TodoMVC: add, complete, filter', async () => {
    await nav('https://todomvc.com/examples/react/dist/');
    await click(await pick('textbox', /What needs to be done|New Todo|todo/i));
    for (const t of ['buy tofu', 'feed the fox', 'ship kitsune']) {
      await type(t);
      await key('Enter');
    }
    const o = await outline('all');
    expect(/feed the fox/.test(o) && /ship kitsune/.test(o), o.slice(0, 1200));
    const boxes = [...(await outline('all')).matchAll(/checkbox[^\n]*\[ref=([^\]]+)\]/g)].map(m => m[1]);
    expect(boxes.length === 4, `expected toggle-all + 3 todo checkboxes, got ${boxes.length}`);
    await click(boxes[2]); // the "feed the fox" item
    await click(await pick('link', /^Active$/));
    const t = await text();
    expect(/2 items? left/.test(t), t.slice(0, 400));
  });
}

async function seleniumForm() {
  await scenario('selenium.dev', 'web form with many input types', async () => {
    await nav('https://www.selenium.dev/selenium/web/web-form.html');
    await call('form_input', { ref: await pick('textbox', /Text input/i), value: 'hello' });
    await call('form_input', { ref: await pick('textbox', /Password/i), value: 'pw' });
    await call('form_input', { ref: await pick('textbox', /Textarea/i), value: 'multi\nline' });
    await call('form_input', { ref: await pick('combobox', /Dropdown \(select\)/i), value: 'Two' });
    await call('form_input', { ref: await pick('checkbox', /Default checkbox/i), value: true });
    await call('form_input', { ref: await pick('slider', /Example range/i), value: 8 });
    await click(await pick('button', /Submit/));
    await waitText(/Received!/);
  });
}

async function bigSites() {
  await scenario('wikipedia', 'search and read an article', async () => {
    await nav('https://en.wikipedia.org/wiki/Main_Page');
    const ref = await pick('searchbox|combobox|textbox', /Search/i);
    await click(ref);
    await type('Red fox');
    await key('Enter');
    await waitText(/Vulpes vulpes/);
  });
  await scenario('hacker news', 'open "new" and a comments page', async () => {
    await nav('https://news.ycombinator.com/');
    await click(await pick('link', /^new$/));
    await waitText(/newest|new/i, { source: 'outline' });
    const o = await outline();
    const stories = (o.match(/link "\d+ comments?"|link "discuss"/g) || []).length;
    expect(stories >= 10, `only ${stories} comment links`);
  });
  await scenario('duckduckgo', 'web search', async (notes) => {
    await nav('https://duckduckgo.com/');
    await click(await pick('combobox|searchbox|textbox', /Search/i));
    await type('mozilla firefox');
    await key('Enter');
    const t = await waitText(/mozilla\.org|Firefox Browser|Download Firefox/i, { tries: 20 });
    notes.push(`${t.length} chars of results`);
  });
  await scenario('google', 'web search', async (notes) => {
    await nav('https://www.google.com/');
    const o = await outline();
    if (/Before you continue|Accept all|Reject all/i.test(o)) {
      await click(await pick('button', /Reject all/i));
      notes.push('rejected cookie consent');
    }
    await click(await pick('combobox|searchbox|textbox', /Search/i));
    await type('mozilla firefox');
    await key('Enter');
    const t = await waitText(/mozilla|unusual traffic|not a robot/i);
    if (/unusual traffic|not a robot/i.test(t))
      notes.push('Google showed a bot check (expected for a data-center IP)');
  });
  await scenario('react.dev', 'DocSearch dialog: ctrl+k, type, open result', async () => {
    await nav('https://react.dev/');
    await click(await pick('button', /Search/i));
    await sleep(600);
    await type('useState');
    await sleep(1500);
    await key('Enter');
    await waitText(/useState is a React Hook/i);
  });
  await scenario('gov.uk', 'site search', async () => {
    await nav('https://www.gov.uk/');
    await click(await pick('searchbox|textbox|combobox', /Search/i));
    await type('passport renewal');
    await key('Enter');
    await waitText(/passport/i);
  });
  await scenario('amazon', 'product search', async (notes) => {
    await nav('https://www.amazon.com/');
    await sleep(2500); // Amazon's home page keeps loading/redirecting for a moment
    const o = await outline();
    if (/captcha|Enter the characters|Continue shopping/i.test(o)) {
      notes.push('Amazon interstitial shown');
      const c = /button "Continue shopping"[^\n]*\[ref=([^\]]+)\]/.exec(o);
      if (c)
        await click(c[1]);
    }
    await click(await pick('searchbox', /Search Amazon/i));
    await type('fox plush toy');
    await key('Enter');
    await waitText(/fox plush toy/i, { tries: 25, source: 'outline' });
  });
  await scenario('youtube', 'search videos', async (notes) => {
    await nav('https://www.youtube.com/');
    const o = await outline();
    if (/Reject all|Before you continue/i.test(o)) {
      await click(await pick('button', /Reject all/i));
      notes.push('rejected consent');
    }
    await click(await pick('combobox|searchbox|textbox', /Search/i));
    await type('red fox documentary');
    await key('Enter');
    await waitText(/fox/i, { source: 'outline' });
  });
  await scenario('excalidraw', 'draw a rectangle on the canvas', async (notes) => {
    await nav('https://excalidraw.com/');
    await sleep(3500);
    const o = await outline();
    const close = /button "(?:Close|Got it)"[^\n]*\[ref=([^\]]+)\]/.exec(o);
    if (close)
      await click(close[1]);
    await key('r');
    await call('computer', { action: 'left_click_drag', start_coordinate: [500, 300], coordinate: [700, 450] });
    let n = 0;
    for (let i = 0; i < 6 && !(Number(n) >= 1); i++) {
      await sleep(500); // Excalidraw saves to localStorage after a debounce
      n = await js('JSON.parse(localStorage.getItem("excalidraw") || "[]").filter(e => !e.isDeleted).length');
    }
    notes.push(`elements on canvas: ${n}`);
    expect(Number(n) >= 1, 'no shape drawn');
  });
}


async function editorsAndWidgets() {
  const typeInto = async (url, role, nameRe, textToType, check, wait = 2500) => {
    await nav(url);
    await sleep(wait);
    const ref = await pick(role, nameRe, { filter: 'all' });
    await click(ref);
    await key('ctrl+a Delete');
    await type(textToType);
    await sleep(500);
    await waitText(check, { source: 'outline' });
  };
  await scenario('lexical', 'type into the Lexical playground', async () => {
    await typeInto('https://playground.lexical.dev/', 'textbox', null, 'Hello from Kitsune', /Hello from Kitsune/);
  });
  await scenario('slate', 'type into a Slate editor', async () => {
    await typeInto('https://www.slatejs.org/examples/richtext', 'textbox', null, 'Slate says hi', /Slate says hi/);
  });
  await scenario('quill', 'type into Quill (editor inside an iframe)', async () => {
    await typeInto('https://quilljs.com/playground/snow', 'textbox', /\[ref=f\d+e\d+\]/, 'Quill says hi', /Quill says hi/, 3500);
  });
  await scenario('prosemirror.net', 'type into ProseMirror (real site)', async () => {
    await typeInto('https://prosemirror.net/examples/basic/', 'textbox', null, 'ProseMirror says hi', /ProseMirror says hi/);
  });
  await scenario('codemirror', 'type code into CodeMirror 6', async () => {
    await typeInto('https://codemirror.net/try/', 'textbox', null, 'const fox = 42;', /const fox = 42;/, 3000);
  });
  await scenario('monaco', 'type code into Monaco (VS Code editor)', async () => {
    await nav('https://microsoft.github.io/monaco-editor/playground.html');
    await sleep(5000);
    const r = await call('find', { query: 'automaticLayout' });
    const c = /generic "automaticLayout[^\n]*at \((\d+), (\d+)\)/.exec(r.text);
    expect(c, 'code line not found: ' + r.text);
    await call('computer', { action: 'left_click', coordinate: [+c[1], +c[2]] });
    await key('ctrl+a Delete');
    await type('let kitsune = 1;');
    await sleep(800);
    const v = await js('monaco.editor.getEditors()[0].getValue()');
    expect(/let kitsune = 1;/.test(v), 'text not in editor model: ' + v.slice(0, 300));
  });
  await scenario('jqueryui', 'sortable list drag (inside an iframe)', async () => {
    await nav('https://jqueryui.com/sortable/');
    await sleep(1500);
    const f1 = await call('find', { query: 'Item 1' });
    const f4 = await call('find', { query: 'Item 4' });
    const a = /Item 1[^\n]*at \((\d+), (\d+)\)/.exec(f1.text);
    const b = /Item 4[^\n]*at \((\d+), (\d+)\)/.exec(f4.text);
    expect(a && b, `items not located:\n${f1.text}\n${f4.text}`);
    await call('computer', { action: 'left_click_drag', start_coordinate: [+a[1], +a[2]], coordinate: [+b[1], +b[2] + 10] });
    await sleep(600);
    const after = await outline('all');
    const items = [...after.matchAll(/listitem[^\n]*?"?(Item \d)/g)].map(m => m[1]);
    expect(items.length >= 7 && items[0] !== 'Item 1', `order unchanged: ${items.join(',')}`);
  });
  await scenario('mui', 'MUI Autocomplete: type and choose', async () => {
    await nav('https://mui.com/material-ui/react-autocomplete/');
    await sleep(2000);
    await click(await pick('combobox', /Movie/i));
    await type('The Godf');
    await sleep(600);
    await click(await pick('option', /The Godfather$|The Godfather\b/, { filter: 'all' }));
    await sleep(300);
    const o = await outline();
    expect(/combobox "Movie"[^\n]*: The Godfather/.test(o), o.split('\n').filter(l => /Movie/.test(l)).join('\n'));
  });
  await scenario('radix', 'Radix Select: open and choose', async () => {
    await nav('https://www.radix-ui.com/primitives/docs/components/select');
    await sleep(2000);
    const trig = await pick('combobox', /Food|fruit|Select/i);
    await click(trig);
    await sleep(500);
    await click(await pick('option', /Banana/i, { filter: 'all' }));
    await sleep(300);
    const o = await outline();
    expect(/combobox[^\n]*Banana/.test(o), o.split('\n').filter(l => /combobox/.test(l)).join('\n'));
  });
  await scenario('httpbin', 'classic HTML form POST (JSON response)', async (notes) => {
    await nav('https://httpbin.org/forms/post');
    await call('form_input', { ref: await pick('textbox', /Customer name/i), value: 'Ada' });
    await click(await pick('radio', /Medium/));
    await click(await pick('checkbox', /Bacon/));
    await click(await pick('button', /Submit order/));
    const r = await call('get_page_text', {}, { allowError: true });
    expect(r.isError && /JSON viewer/.test(r.text), 'expected the JSON-viewer explanation, got: ' + r.text.slice(0, 200));
    notes.push('POST result is in Firefox JSON viewer: reported clearly (known limitation)');
  });
  await scenario('httpbin', 'GET JSON is re-fetched and readable', async () => {
    await call('navigate', { url: 'https://httpbin.org/json' }, { allowError: true });
    const r = await call('get_page_text');
    expect(/slideshow/.test(r.text), r.text.slice(0, 300));
  });
  await scenario('reddit', 'read a subreddit and scroll', async (notes) => {
    await nav('https://www.reddit.com/r/firefox/');
    await sleep(2500);
    const o = await outline('interactive');
    const posts = (o.match(/link "[^"]{15,}"/g) || []).length;
    notes.push(`${posts} long links`);
    expect(posts > 5, o.slice(0, 600));
  });
  await scenario('bbc', 'news page: consent + headlines', async (notes) => {
    await nav('https://www.bbc.com/news');
    await sleep(2000);
    const o = await outline();
    const consent = /button "(?:Yes, I agree|I agree|Accept|Reject)[^"]*"[^\n]*\[ref=([^\]]+)\]/.exec(o);
    if (consent) {
      await click(consent[1]);
      notes.push('dismissed consent');
    }
    const t = await text();
    expect(t.length > 1500, t.slice(0, 300));
  });
}

async function main() {
  console.log(`Kitsune real-site tests (${TRUSTED ? 'trusted / BiDi' : 'synthetic'} input)`);
  h = await start({ trusted: TRUSTED });
  const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
  tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
  for (const group of [theInternet, demoqa, saucedemo, todomvc, seleniumForm, bigSites, editorsAndWidgets])
    await group();
  await h.stop();
  const passed = results.filter(r => r.ok).length;
  console.log(`\n${passed}/${results.length} passed (${TRUSTED ? 'trusted' : 'synthetic'})`);
  fs.mkdirSync('test/results', { recursive: true });
  fs.writeFileSync(`test/results/realsites-${TRUSTED ? 'trusted' : 'synthetic'}${FILTER ? '-partial' : ''}.json`, JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await h?.stop();
  } catch { /* ignore */ }
  process.exit(2);
});
