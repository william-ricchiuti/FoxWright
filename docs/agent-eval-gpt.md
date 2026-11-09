# Agent evaluation: Codex CLI + Kitsune (synthetic input)

> Run 2026-11-08 with Codex CLI 0.161.0 (Codex's default reasoning effort). This run used the old `rich-editor` check, which didn't verify the bold when the editor sits in a cross-origin frame; the transcript shows the correct result (`strong: Kitsune`, then `was here.`), and a rerun of that task with the fixed check passed. A second full run was stopped after 6 tasks (all passed) by the ChatGPT plan's Codex usage limit.

2026-11-08T23:40:35.819Z · darwin arm64 · model gpt-6-astra


**17/17 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 27 s and 7 tool calls per task.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 28 s | 6 | 0 | 118k / 0k | – | The site shows: **“You logged into a secure area!”** |
| checkout | pass | 40 s | 9 | 0 | 236k / 1k | – | The order is complete. The confirmation page says: > **Thank you for your order!** > > You |
| practice-form | pass | 28 s | 5 | 0 | 122k / 0k | – | Submitted successfully. The confirmation dialog title says: **“Thanks for submitting the f |
| todos | pass | 30 s | 6 | 0 | 149k / 0k | – | Added and verified all three todos: - buy tofu - ✅ feed the fox — completed - ship kitsune |
| wiki-facts | pass | 18 s | 4 | 0 | 93k / 0k | – | According to [Wikipedia](https://en.wikipedia.org/wiki/Red_fox): - **Scientific name:** *V |
| hn-top | pass | 12 s | 3 | 0 | 92k / 0k | – | The current #1 story is [“KetchUp – Open-source SketchUp alternative built with Rust and W |
| docs-search | pass | 27 s | 11 | 0 | 233k / 0k | – | Using react.dev’s search, I opened the [useState reference](https://react.dev/reference/re |
| mui-autocomplete | pass | 22 s | 8 | 0 | 144k / 0k | – | Selected and verified “The Godfather” in the first “Movie” combo box. Kitsune reported a v |
| radix-select | pass | 24 s | 7 | 0 | 148k / 0k | – | Selected “Banana” in the top demo fruit select and verified it displays “Banana.” |
| drag-drop | pass | 20 s | 5 | 0 | 119k / 0k | – | Done—dragged A onto B and verified they swapped: B is on the left, A on the right. |
| confirm-dialog | pass | 16 s | 6 | 0 | 119k / 0k | – | The page shows: **“You clicked: Ok”** |
| excalidraw | pass | 29 s | 8 | 0 | 149k / 0k | – | Drew a rectangle on the Excalidraw canvas and visually verified it. Kitsune reported a ver |
| rich-editor | pass | 29 s | 13 | 0 | 179k / 1k | – | Done. The editor now reads “**Kitsune** was here.” Verified that only “Kitsune” is bold. |
| gov-uk | pass | 15 s | 4 | 0 | 91k / 0k | – | It costs **£102** to renew a standard adult UK passport online from within the UK, accordi |
| two-tabs | pass | 34 s | 8 | 0 | 182k / 0k | – | The **red fox is generally heavier**. I opened both Wikipedia articles in separate Kitsune |
| upload | pass | 23 s | 7 | 0 | 143k / 0k | – | The page says **“File Uploaded!”** and displays **kitsune-agent-upload.txt**. |
| signup-wizard | pass | 29 s | 8 | 0 | 199k / 1k | – | Your membership was created! Your membership code is **FOX-4BQCJR**. |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 18 | 38867 | 2159 | 0 |
| get_page_text | 11 | 35552 | 3232 | 0 |
| browser_batch | 12 | 32104 | 2675 | 0 |
| navigate | 18 | 20321 | 1129 | 0 |
| tabs_context_mcp | 17 | 8444 | 497 | 0 |
| computer | 23 | 3598 | 156 | 5 |
| find | 4 | 1318 | 330 | 0 |
| tabs_create_mcp | 10 | 357 | 36 | 0 |
| form_input | 3 | 247 | 82 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
