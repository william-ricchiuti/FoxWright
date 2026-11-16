# Foxwright agent guide

Give these instructions to an AI client connected to the Foxwright MCP server.

1. **Get sites approved up front.** Tell the user which sites the task needs and whether reading is enough. Start by navigating to those sites in Foxwright tabs so Firefox can show its approval prompts. Wait for the user's decision and respect any denial or read-only access. Ask before adding a site outside the agreed scope.
2. **Read the page before taking a screenshot.** Call `read_page` for the accessibility outline and element references. Use refs for clicks and form input. Take a screenshot when the task depends on visual details or the outline leaves you unsure what to act on.
3. **Wait for a page condition.** Use `wait_for` on `read_page` or `find` with the expected text or a role and name, such as `button "Save"`. If it times out, inspect the current page before deciding what to do next. Skip fixed sleeps.
4. **Close the tabs you opened.** Use `tabs_close_mcp` when the task is done, unless the user asks to keep a tab open. Leave any tabs you inherited available to the user.
