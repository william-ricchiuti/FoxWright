// Tasks for the real-agent evaluation (test/agent-eval.mjs). Each prompt is phrased the
// way a user would ask; `verify` checks the outcome independently of what the agent claims:
// it inspects the browser (via Kitsune's own MCP tools) and/or the agent's final answer.
//
// ctx = { answer, texts(): text of every Kitsune tab, outline(filter?): outline of the agent's active tab,
//         js(code, urlRe?): run JS in the tab matching urlRe (default: active), tabs(): [{ id, url, title }] }

const has = (s, ...needles) => needles.every(n => (n instanceof RegExp ? n.test(s) : s.toLowerCase().includes(String(n).toLowerCase())));

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
      const t = await c.texts();
      return has(t, 'buy tofu', 'ship kitsune', /2 items? left/);
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
    verify: async (c) => has(await c.texts(), /useState is a React Hook/i) && has(c.answer, /array|pair|two values/i),
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
    verify: async (c) => /Kitsune/.test(await c.outline('all')) && /was here/.test(await c.outline('all')),
  },
  {
    id: 'gov-uk',
    prompt: 'Using gov.uk, how much does it cost to renew an adult UK passport online (from the UK)?',
    verify: async (c) => /£\s?\d{2,3}/.test(c.answer) && (await c.tabs()).some(t => /gov\.uk/.test(t.url)),
  },
  {
    id: 'two-tabs',
    prompt: 'Open the Wikipedia articles for the red fox and the arctic fox in two separate tabs and tell me which species is heavier on average, with the typical weights.',
    verify: async (c) => has(c.answer, /red fox/i, /kg/i) && (await c.tabs()).length >= 2,
  },
  {
    id: 'upload',
    prompt: 'At https://the-internet.herokuapp.com/upload upload the file __UPLOAD_FILE__ and submit. Tell me what the page says afterwards.',
    verify: async (c) => has(await c.texts(), /File Uploaded!/),
  },
];
