# Agent evaluation: Claude Code + Kitsune (synthetic input)

2026-11-08T21:30:33.239Z · darwin arm64 · max turns 40


**17/17 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 36 s and 7 tool calls per task; total cost $4.05.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 32 s | 5 | 0 | 197k / 1k | $0.236 | The login worked. The site sent me to `https://the-internet.herokuapp.com/secure`, and the |
| checkout | pass | 55 s | 9 | 0 | 357k / 2k | $0.292 | The order went through, and the confirmation page (`checkout-complete.html`) says: > **Che |
| practice-form | pass | 48 s | 7 | 0 | 275k / 1k | $0.247 | I filled out and submitted the form. The confirmation dialog's title is **"Thanks for subm |
| todos | pass | 33 s | 7 | 0 | 273k / 1k | $0.249 | I added "buy tofu", "feed the fox" and "ship kitsune" to the TodoMVC React demo, then mark |
| wiki-facts | pass | 29 s | 4 | 0 | 183k / 1k | $0.201 | According to the [Red fox article on Wikipedia](https://en.wikipedia.org/wiki/Red_fox): -  |
| hn-top | pass | 23 s | 3 | 0 | 145k / 0k | $0.172 | The #1 story on Hacker News right now is **"Goldman Sachs Is Pulling Claude Code from Its  |
| docs-search | pass | 36 s | 7 | 0 | 276k / 1k | $0.254 | I searched react.dev for "useState" and opened the reference page at https://react.dev/ref |
| mui-autocomplete | pass | 53 s | 8 | 0 | 312k / 1k | $0.255 | I selected "The Godfather" in the first "Movie" combo box, in the Combo box section of the |
| radix-select | pass | 41 s | 9 | 0 | 309k / 1k | $0.241 | I picked "Banana" in the fruit select at the top of the Radix Select page. I opened the dr |
| drag-drop | pass | 27 s | 6 | 0 | 268k / 1k | $0.230 | I dragged box A onto box B and they swapped places: B is now on the left and A is on the r |
| confirm-dialog | pass | 29 s | 7 | 0 | 227k / 1k | $0.210 | The page shows **"You clicked: Ok"** under "Result:". I clicked "Click for JS Confirm", th |
| excalidraw | pass | 33 s | 7 | 0 | 230k / 1k | $0.234 | I opened excalidraw.com in the Kitsune tab, picked the Rectangle tool, and dragged out a r |
| rich-editor | pass | 40 s | 12 | 0 | 318k / 1k | $0.277 | I replaced the Quill playground editor's content with "Kitsune was here." and made "Kitsun |
| gov-uk | pass | 25 s | 4 | 0 | 181k / 1k | $0.179 | According to GOV.UK, it costs **£102** to renew an adult UK passport online from the UK. A |
| two-tabs | pass | 97 s | 9 | 0 | 317k / 1k | $0.291 | The **red fox is heavier**. I opened both Wikipedia articles in separate tabs (red fox in  |
| upload | pass | 39 s | 6 | 0 | 268k / 1k | $0.221 | The upload worked. After I submitted the file, the page shows: > **File Uploaded!** > kits |
| signup-wizard | pass | 39 s | 8 | 0 | 317k / 1k | $0.264 | You're signed up for the Fox Club. Your membership code is **FOX-4BQCJR**. The first step  |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| get_page_text | 10 | 30273 | 3027 | 0 |
| navigate | 18 | 19802 | 1100 | 0 |
| browser_batch | 15 | 14193 | 946 | 1 |
| tabs_context_mcp | 17 | 5279 | 311 | 0 |
| computer | 25 | 4084 | 163 | 10 |
| find | 7 | 3499 | 500 | 0 |
| read_page | 6 | 3382 | 564 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 1 | 36 | 36 | 0 |
| ToolSearch | 17 | 0 | 0 | 0 |
