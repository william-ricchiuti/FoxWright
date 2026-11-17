# Foxwright agent guide

Give these instructions to an AI client connected to the Foxwright MCP server.

1. **Get sites approved up front.** Tell the user which sites the task needs and whether reading is enough. Start by navigating to those sites in Foxwright tabs so Firefox can show its approval prompts. Wait for the user's decision and respect any denial or read-only access. Ask before adding a site outside the agreed scope.
2. **A denial ends the attempt.** If a tool says the user did not allow a site, stop and tell the user. Don't retry it, and don't reach the same page another way (another address, a cached copy, a different tab): every retry opens another permission window.
3. **Do only what was asked.** Reading or comparing pages needs no clicks. Don't add to a basket, accept cookie banners, submit forms or press other buttons with side effects unless the task needs it. When the user says read only, use `read_page`, `find`, `get_page_text` and screenshots.
4. **Read the page before taking a screenshot.** Call `read_page` for the accessibility outline and element references. Use refs for clicks and form input. Take a screenshot when the task depends on visual details or the outline leaves you unsure what to act on.
5. **Batch the obvious steps.** `browser_batch` runs several steps in one call. Each `computer` step needs its `action`, e.g. `{tool: "computer", args: {action: "left_click", ref: "e5"}}`. Refs from before a page change are stale; read again after the batch.
6. **Wait for a page condition.** Use `wait_for` on `read_page` or `find` with the expected text or a role and name, such as `button "Save"`. The default timeout is 5 seconds; raise `timeout` (up to 30) for slow searches and reports. If it times out, inspect the current page before deciding what to do next. Skip fixed sleeps.
7. **Fix what a form rejects.** After submitting, read the page for validation messages and correct the format the site asks for (e.g. digits only, capital letters) instead of retrying the same value.
8. **Close the tabs you opened.** Use `tabs_close_mcp` when the task is done, unless the user asks to keep a tab open. Leave any tabs you inherited available to the user.
