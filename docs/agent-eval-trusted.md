# Agent evaluation: Claude Code + Kitsune (trusted input)

2026-11-08T21:40:35.989Z · darwin arm64 · max turns 40


**17/17 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 31 s and 6 tool calls per task; total cost $3.68.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 29 s | 4 | 0 | 191k / 1k | $0.206 | The login worked. The browser went to `https://the-internet.herokuapp.com/secure`, and the |
| checkout | pass | 44 s | 8 | 0 | 358k / 2k | $0.256 | I placed the order. The confirmation page (`checkout-complete.html`) says: > **Checkout: C |
| practice-form | pass | 75 s | 5 | 0 | 195k / 1k | $0.213 | I submitted the form. The confirmation dialog's title says **"Thanks for submitting the fo |
| todos | pass | 35 s | 8 | 0 | 313k / 1k | $0.235 | I added the three todos to the TodoMVC React example and marked "feed the fox" as complete |
| wiki-facts | pass | 24 s | 4 | 0 | 183k / 1k | $0.180 | According to the Wikipedia article on the [red fox](https://en.wikipedia.org/wiki/Red_fox) |
| hn-top | pass | 19 s | 3 | 0 | 145k / 0k | $0.152 | The #1 story on Hacker News right now is **"Goldman Sachs Is Pulling Claude Code from Its  |
| docs-search | pass | 34 s | 7 | 0 | 276k / 1k | $0.236 | I used the search box on react.dev, typed "useState", and opened the top result: https://r |
| mui-autocomplete | pass | 26 s | 6 | 0 | 271k / 1k | $0.217 | "The Godfather" is now selected in the first "Movie" combo box on the MUI Autocomplete pag |
| radix-select | pass | 31 s | 9 | 0 | 308k / 1k | $0.218 | I chose "Banana" in the fruit select demo at the top of the Radix Select page. The select  |
| drag-drop | pass | 20 s | 6 | 0 | 192k / 1k | $0.201 | I dragged box A onto box B, and they swapped places. A screenshot afterward shows **B** in |
| confirm-dialog | pass | 23 s | 6 | 0 | 226k / 1k | $0.185 | The page shows **"You clicked: Ok"**. I clicked "Click for JS Confirm" in the browser. The |
| excalidraw | pass | 25 s | 7 | 0 | 230k / 1k | $0.210 | I drew a rectangle on the Excalidraw canvas. I opened excalidraw.com in the Kitsune tab, p |
| rich-editor | pass | 54 s | 19 | 0 | 400k / 2k | $0.297 | The Quill snow playground editor at https://quilljs.com/playground/snow now reads "**Kitsu |
| gov-uk | pass | 39 s | 4 | 0 | 181k / 1k | $0.165 | Renewing an adult UK passport online from the UK costs **£102** for the standard 34-page p |
| two-tabs | pass | 39 s | 8 | 0 | 275k / 1k | $0.264 | I opened both articles in separate tabs (red fox in tab 16, arctic fox in tab 17). **The r |
| upload | pass | 31 s | 6 | 0 | 268k / 1k | $0.199 | The upload worked. After I submitted, the page showed: > **File Uploaded!** > kitsune-agen |
| signup-wizard | pass | 44 s | 8 | 0 | 316k / 1k | $0.242 | Your membership code is **FOX-4BQCJR**. - **Step 1:** The form rejected `ada@example` beca |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| get_page_text | 9 | 35909 | 3990 | 0 |
| navigate | 18 | 19640 | 1091 | 0 |
| browser_batch | 16 | 15713 | 982 | 2 |
| computer | 26 | 5913 | 227 | 8 |
| tabs_context_mcp | 17 | 5177 | 305 | 0 |
| read_page | 7 | 3908 | 558 | 0 |
| find | 5 | 2525 | 505 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 1 | 36 | 36 | 0 |
| ToolSearch | 17 | 0 | 0 | 0 |
