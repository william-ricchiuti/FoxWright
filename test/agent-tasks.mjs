// Tasks for the real-agent evaluation (test/agent-eval.mjs). Each prompt is phrased the
// way a user would ask; `verify` checks the outcome independently of what the agent claims:
// it inspects the browser (via Foxwright's own MCP tools or the test's WebDriver BiDi session)
// and/or the agent's final answer.
//
// ctx = { answer, texts(): text of every Foxwright tab, outline(filter?): outline of the agent's active tab,
//         js(code, urlRe?): run JS in the tab matching urlRe (default: active), tabs(): [{ id, url, title }],
//         inspectFixture(path, expr): evaluate expr in the open fixture page with that path,
//         inspectAll(path, expr): the same for every open page with that path,
//         prompts: [{ origin, button }] permission windows the scripted user answered (--ask),
//         calls: [{ name, input, isError, resultText }] the agent's tool calls, in order }
// Prompts may use __LOCAL__ (the harness's fixture server), __READ_ONLY__ (the same server as
// localhost, read-only in --ask), __OTHER__ (the same server as b.test) and __UPLOAD_FILE__.
// `askOnly` tasks run only with --ask; `deny` lists sites the scripted user denies.

/** Run JS in a tab (see ctx.js) that returns JSON.stringify(...), and parse the result; null if unavailable. */
async function jsJson(c, code, urlRe) {
  try {
    let v = JSON.parse(await c.js(code, urlRe));
    if (typeof v === 'string')
      v = JSON.parse(v);
    return v;
  } catch {
    return null;
  }
}

/**
 * The rich-editor check from Kitsune's outline: the editor paragraph must read exactly
 * "Kitsune was here." with only "Kitsune" bold, e.g.
 *   - paragraph [ref=f1e36]:
 *     - strong [ref=f1e37]: Kitsune
 *     - text: was here.
 * (An empty "- strong" line is bold toggled at the caret with nothing selected: not a pass.)
 */
export function quillOutlineOk(outline) {
  const lines = outline.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- paragraph\b/.test(lines[i]))
      continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    const kids = [];
    for (let j = i + 1; j < lines.length && lines[j].match(/^\s*/)[0].length > indent; j++)
      kids.push(lines[j].trim());
    const parts = kids.map(k => /^- (strong|text)(?: \[[^\]]*\])*(?:: (.*))?$/.exec(k)).filter(Boolean);
    if (parts.length !== kids.length)
      continue; // something else in this paragraph (links, images, other formatting)
    const text = parts.map(p => (p[2] || '').replace(/^"|"$/g, '').trim()).filter(Boolean).join(' ');
    if (text !== 'Kitsune was here.')
      continue;
    const bold = parts.filter(p => p[1] === 'strong').map(p => (p[2] || '').trim());
    return bold.length === 1 && bold[0] === 'Kitsune';
  }
  return false;
}

const has = (s, ...needles) => needles.every(n => (n instanceof RegExp ? n.test(s) : s.toLowerCase().includes(String(n).toLowerCase())));

// Flatten batches so verifiers cannot miss actions submitted inside browser_batch.
const objectArgs = value => typeof value === 'string' ? JSON.parse(value) : (value || {});
export const agentCalls = calls => calls.flatMap(c => {
  const input = objectArgs(c.input);
  if (c.name !== 'browser_batch') return [{ ...c, input }];
  const actions = objectArgs(input.actions || input.steps || []);
  return actions.flatMap(a => agentCalls([{ name: a.tool, input: a.args, resultText: c.resultText, isError: c.isError }]));
});

export const FEATURE_TASKS = [
  {
    id: 'read-only-site',
    prompt: 'Read the inventory at __READ_ONLY__/agent-readonly.html and report the stock count and audit code. This site is approved read-only. Do not click, type, submit, or change anything.',
    verify: async c => {
      const state = await c.inspectFixture('/agent-readonly.html', 'window.inventory');
      const calls = agentCalls(c.calls);
      return state.changes === 0 && c.answer.includes(state.code) && c.answer.includes(String(state.stock))
        && calls.some(x => ['read_page', 'get_page_text'].includes(x.name))
        && !calls.some(x => ['form_input', 'javascript_tool', 'file_upload', 'upload_image', 'handle_dialog'].includes(x.name)
          || (x.name === 'computer' && !['screenshot', 'scroll', 'scroll_to', 'hover', 'wait'].includes(x.input.action)));
    },
  },
  {
    id: 'read-pdf',
    prompt: 'Read __LOCAL__/pdf/simple.pdf in Firefox. What conservation status does the document state, and what is the sentence about the quick brown fox?',
    verify: async c => has(c.answer, /least concern/i, /quick brown fox jumps over the lazy dog/i)
      && (await c.tabs()).some(t => /\/pdf\/simple\.pdf$/.test(t.url))
      && agentCalls(c.calls).some(x => x.name === 'get_page_text'),
  },
  {
    id: 'late-page',
    prompt: 'Open __LOCAL__/agent-late.html. The report arrives late. Wait for "Report ready", then tell me its delivery code. Use a condition-based page read rather than fixed sleeps or repeated polling.',
    verify: async c => {
      const state = await c.inspectFixture('/agent-late.html', 'window.report');
      return state.ready && c.answer.includes(state.code)
        && agentCalls(c.calls).some(x => ['read_page', 'find'].includes(x.name) && /Report ready/i.test(x.input.wait_for || ''));
    },
  },
  {
    id: 'long-page-diff',
    prompt: 'Open __LOCAL__/agent-long.html and read the inventory outline. Press "Refresh inventory", then read only what changed in that outline and report the new shipment code and stock count. Avoid rereading the entire long page.',
    verify: async c => {
      const state = await c.inspectFixture('/agent-long.html', 'window.inventory');
      const calls = agentCalls(c.calls);
      const first = calls.findIndex(x => x.name === 'read_page' && !x.input.diff);
      const diff = calls.findIndex((x, i) => i > first && x.name === 'read_page' && x.input.diff === true);
      return state.changes === 1 && c.answer.includes(state.code) && c.answer.includes(String(state.stock))
        && first >= 0 && diff > first && !calls[diff].isError
        && /Changes since the previous read_page:/.test(calls[diff].resultText || '')
        && (calls[diff].resultText || '').includes(state.code)
        && !calls.some(x => x.name === 'javascript_tool');
    },
  },
];

// Write-type actions: a read-only task must not make any of these.
const WRITES = ['form_input', 'javascript_tool', 'file_upload', 'upload_image', 'handle_dialog'];
const READ_ACTIONS = ['screenshot', 'scroll', 'scroll_to', 'hover', 'wait', 'zoom'];
export const isWrite = x => WRITES.includes(x.name) || (x.name === 'computer' && !READ_ACTIONS.includes(x.input.action));
const money = s => String(s).replace('$', '');

// 0.8.1: everyday requests the suite lacked (local fixtures; values change on every load).
export const USER_TASKS = [
  {
    id: 'compare-tabs',
    prompt: 'Compare the two kettles at __LOCAL__/agent-product.html?item=copper and __LOCAL__/agent-product.html?item=steel. Open each one in its own tab. Which is cheaper right now once shipping is included, and what is its total?',
    verify: async (c) => {
      const all = await c.inspectAll('/agent-product.html', 'window.product');
      const byItem = Object.fromEntries(all.map(p => [p.item, p]));
      if (!byItem.copper || !byItem.steel || all.some(p => p.basket)) // both pages open at once (two tabs); nothing added to the basket
        return false;
      const [cheap, dear] = [byItem.copper, byItem.steel].sort((a, b) => a.totalNum - b.totalNum);
      const tie = Math.abs(cheap.totalNum - dear.totalNum) < 0.01;
      const named = p => new RegExp(p.item, 'i').test(c.answer) && c.answer.includes(money(p.total));
      return named(cheap) || (tie && named(dear));
    },
  },
  {
    id: 'long-form',
    prompt: 'Apply for a library card at __LOCAL__/agent-apply.html. Name Ada Lovelace, email ada@example.com, phone 555 123 4567, born 10 December 1990. Address: 12 St James\'s Square, London, sw1y 4jh, United Kingdom. Contact me by email and sign me up for event invitations only. Reason: "I want to borrow books on mathematics and engines." If the form rejects something, fix the format and carry on. Submit it and tell me the reference number.',
    verify: async (c) => {
      const a = await c.inspectFixture('/agent-apply.html', 'window.__apply');
      const v = a.values || {};
      return a.submitted && c.answer.includes(a.code) && v.name === 'Ada Lovelace' && v.email === 'ada@example.com'
        && v.phone === '5551234567' && v.dob === '1990-12-10' && v.postcode === 'SW1Y 4JH' && v.country === 'GB'
        && /St James/i.test(v.street) && /London/i.test(v.city) && v.contact === 'email'
        && v.newsletters.join() === 'events' && /mathematics and engines/i.test(v.reason);
    },
  },
  {
    id: 'slow-results',
    prompt: 'Search the catalog at __LOCAL__/agent-search.html for "fennec" and tell me the SKU of the top result.',
    verify: async (c) => {
      const s = await c.inspectFixture('/agent-search.html', 'window.catalog');
      return s.loaded && /fennec/i.test(s.query) && !!s.top && c.answer.includes(s.top) && !c.answer.includes(s.trending);
    },
  },
  {
    id: 'read-only-research',
    prompt: 'Using the field guide at __READ_ONLY__/agent-research.html, which fox species listed there lives longest in the wild, and for how many years? This is research only: do not click, type or change anything on the page.',
    verify: async (c) => {
      const r = await c.inspectFixture('/agent-research.html', 'window.research');
      const calls = agentCalls(c.calls);
      return r.clicks === 0 && r.keys === 0 && new RegExp(r.longest.species, 'i').test(c.answer)
        && new RegExp(`\\b${r.longest.years}\\b`).test(c.answer)
        && calls.some(x => ['read_page', 'get_page_text', 'find'].includes(x.name)) && !calls.some(isWrite);
    },
  },
  {
    id: 'denied-site',
    askOnly: true, // needs the permission window, which the scripted user answers with Deny
    deny: ['b.test'],
    prompt: 'What does the Den membership cost? It is on the price list at __OTHER__/agent-prices.html.',
    verify: async (c) => {
      const calls = agentCalls(c.calls);
      const denied = calls.findIndex(x => /did not allow/i.test(x.resultText || ''));
      const later = denied < 0 ? [] : calls.slice(denied + 1);
      // Exactly one permission window for the site (no retries that pester the user), no second
      // route to the same page, and an answer that says it was not allowed instead of a price.
      return denied >= 0 && c.prompts.filter(p => /b\.test/.test(p.origin)).length === 1
        && !later.some(x => /b\.test|agent-prices/.test(JSON.stringify(x.input)))
        && /(not|n't)\s+(allow|approv|permit|grant)|denied|declined|refused|blocked|permission/i.test(c.answer)
        && !/\$\s?11\b/.test(c.answer);
    },
  },
];

export const TASKS = [
  {
    id: 'login',
    prompt: 'Log in to https://the-internet.herokuapp.com/login with username "tomsmith" and password "SuperSecretPassword!". Tell me the message the site shows after logging in.',
    verify: async (c) => has(await c.texts(), 'You logged into a secure area') && has(c.answer, /secure area/i),
  },
  {
    id: 'checkout',
    prompt: 'On https://www.saucedemo.com log in as standard_user / secret_sauce, buy the "Sauce Labs Backpack" (checkout with name Ada Lovelace, zip 70112) and finish the order. What does the confirmation page say?',
    verify: async (c) => has(await c.texts(), /Thank you for your order/i),
  },
  {
    id: 'practice-form',
    prompt: 'Fill out and submit the student registration form at https://demoqa.com/automation-practice-form: First name Ada, last name Lovelace, email ada@example.com, gender Female, mobile 5551234567, hobby Reading, current address "London". Then tell me what the confirmation dialog title says.',
    verify: async (c) => has(await c.outline(), /Thanks for submitting the form/i),
  },
  {
    id: 'todos',
    prompt: 'At https://todomvc.com/examples/react/dist/ add three todos: "buy tofu", "feed the fox", "ship kitsune". Then mark "feed the fox" as completed.',
    verify: async (c) => {
      // Exactly "feed the fox" completed, the other two still open.
      const items = await jsJson(c, `JSON.stringify([...document.querySelectorAll('.todo-list li')].map(li => [li.textContent.trim(), li.classList.contains('completed')]))`, /todomvc/) || [];
      const state = Object.fromEntries(items);
      return items.length === 3 && state['feed the fox'] === true && state['buy tofu'] === false && state['ship kitsune'] === false;
    },
  },
  {
    id: 'wiki-facts',
    prompt: 'Using Wikipedia, what is the scientific name of the red fox and its IUCN conservation status?',
    verify: async (c) => has(c.answer, /Vulpes vulpes/i, /least concern/i) && (await c.tabs()).some(t => /wikipedia\.org\/wiki\/Red_fox/i.test(t.url)),
  },
  {
    id: 'hn-top',
    prompt: 'What is the title of the current #1 story on Hacker News (news.ycombinator.com)?',
    verify: async (c) => {
      // HN's CSP blocks javascript_tool, so read the first story from the page outline.
      const hn = (await c.tabs()).find(t => /news\.ycombinator\.com/.test(t.url));
      if (!hn)
        return false;
      const o = await c.outline('all', hn.id);
      const title = /cell "1\."[\s\S]*?link "((?:[^"\\]|\\.){8,})"/.exec(o)?.[1] || '';
      const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return !!title && norm(c.answer).includes(norm(title).slice(0, 30));
    },
  },
  {
    id: 'docs-search',
    prompt: 'Use the search on react.dev to open the reference page for useState, and tell me what useState returns.',
    verify: async (c) => {
      // It must have used the site's search (typed "useState" somewhere), not jumped to the URL.
      const typedIt = (call) => /useState/i.test(JSON.stringify(call.input)) && ['computer', 'form_input', 'browser_batch'].includes(call.name);
      const jumped = c.calls.some(x => x.name === 'navigate' && /reference\/react\/useState/i.test(String(x.input.url)));
      return c.calls.some(typedIt) && !jumped && has(await c.texts(), /useState is a React Hook/i) && has(c.answer, /array|pair|two values/i);
    },
  },
  {
    id: 'mui-autocomplete',
    prompt: 'On https://mui.com/material-ui/react-autocomplete/ use the first "Movie" combo box demo to select "The Godfather".',
    verify: async (c) => has(await c.outline(), /combobox "Movie"[^\n]*: The Godfather/),
  },
  {
    id: 'radix-select',
    prompt: 'On https://www.radix-ui.com/primitives/docs/components/select choose "Banana" in the demo fruit select at the top of the page.',
    verify: async (c) => has(await c.outline(), /combobox "Food"[^\n]*Banana/),
  },
  {
    id: 'drag-drop',
    prompt: 'At https://the-internet.herokuapp.com/drag_and_drop, drag box A onto box B so they swap places.',
    verify: async (c) => /B\s+A/.test((await c.texts()).replace(/\s+/g, ' ')),
  },
  {
    id: 'confirm-dialog',
    prompt: 'At https://the-internet.herokuapp.com/javascript_alerts click "Click for JS Confirm" and answer OK (not Cancel). What result text does the page show?',
    verify: async (c) => has(await c.texts(), /You clicked: Ok/),
  },
  {
    id: 'excalidraw',
    prompt: 'Open https://excalidraw.com and draw a rectangle on the canvas.',
    verify: async (c) => Number(await c.js('JSON.parse(localStorage.getItem("excalidraw") || "[]").filter(e => !e.isDeleted && e.type === "rectangle").length', /excalidraw/)) >= 1,
  },
  {
    id: 'rich-editor',
    prompt: 'On https://quilljs.com/playground/snow replace the editor content with the sentence "Kitsune was here." and make the word Kitsune bold.',
    verify: async (c) => {
      // The editor holds exactly the sentence, with "Kitsune" (and only that) in bold.
      const r = await jsJson(c, `(() => {
        const find = (d) => d.querySelector('.ql-editor');
        let ed = find(document);
        for (const f of document.querySelectorAll('iframe')) { try { ed = ed || find(f.contentDocument); } catch {} }
        return ed ? JSON.stringify({ text: ed.innerText.trim(), bold: [...ed.querySelectorAll('strong, b')].map(b => b.textContent.trim()) }) : 'null';
      })()`, /quilljs/);
      if (!r) // editor not reachable from the page (the playground runs it in a cross-origin frame): use the outline
        return quillOutlineOk(await c.outline('all'));
      return r.text === 'Kitsune was here.' && r.bold.join(' ') === 'Kitsune';
    },
  },
  {
    id: 'gov-uk',
    prompt: 'Using gov.uk, how much does it cost to renew an adult UK passport online (from the UK)?',
    verify: async (c) => /£\s?\d{2,3}/.test(c.answer) && (await c.tabs()).some(t => /gov\.uk/.test(t.url)),
  },
  {
    id: 'two-tabs',
    prompt: 'Open the Wikipedia articles for the red fox and the arctic fox in two separate tabs and tell me which species is heavier on average, with the typical weights.',
    verify: async (c) => {
      const tabs = await c.tabs();
      const both = tabs.some(t => /wiki\/Red_fox/i.test(t.url)) && tabs.some(t => /wiki\/Arctic_fox/i.test(t.url));
      const weights = (c.answer.match(/\d+(?:\.\d+)?\s*(?:[–-]|to)?\s*\d*(?:\.\d+)?\s*kg/gi) || []).length;
      // Red foxes are heavier; the answer must say so and give weights for both species.
      return both && weights >= 2 && /red fox[^.]*heavier|heavier[^.]*red fox/i.test(c.answer);
    },
  },
  {
    id: 'upload',
    prompt: 'At https://the-internet.herokuapp.com/upload upload the file __UPLOAD_FILE__ and submit. Tell me what the page says afterwards.',
    verify: async (c) => has(await c.texts(), /File Uploaded!/),
  },
  {
    id: 'signup-wizard',
    prompt: 'Sign me up for the Fox Club at __LOCAL__/wizard.html. Username ada_l, email ada@example, password fox. If the form rejects anything, fix it: use the email ada@example.com and the password kitsune2026!. On the next step pick Fennec fox as favorite, the Den (family) membership, accept the club rules, then create the membership. What is my membership code?',
    verify: async (c) => {
      const w = await jsJson(c, 'JSON.stringify(window.__wizard || null)', /wizard/);
      return !!w && w.user === 'ada_l' && w.email === 'ada@example.com' && w.fox === 'fennec' && w.plan === 'den' && c.answer.includes(w.code);
    },
  },
  ...FEATURE_TASKS,
  ...USER_TASKS,
];
