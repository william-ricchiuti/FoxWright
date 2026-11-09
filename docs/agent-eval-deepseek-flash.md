# Agent evaluation: OpenCode + Kitsune (synthetic input)

> Run 2026-11-08 with OpenCode 1.18.25 and the fixed `rich-editor` check, on OpenCode's free DeepSeek v4.1 flash model.

2026-11-09T00:22:15.807Z · darwin arm64 · model opencode/deepseek-v4.1-flash-free


**17/17 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 19 s and 6 tool calls per task.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 17 s | 4 | 0 | 46k / 0k | $0.000 | The site showed: **"You logged into a secure area!"** (and "Logged in as tomsmith" on the  |
| checkout | pass | 33 s | 11 | 1 | 122k / 1k | $0.000 | The confirmation page says: **"Thank you for your order!"** "Your order has been dispatche |
| practice-form | pass | 16 s | 6 | 0 | 67k / 1k | $0.000 | The confirmation dialog title says **"Thanks for submitting the form"**. All fields were s |
| todos | pass | 24 s | 9 | 0 | 103k / 1k | $0.000 | Done. All three todos are added, and "feed the fox" is checked as completed (2 items left) |
| wiki-facts | pass | 14 s | 3 | 0 | 37k / 0k | $0.000 | Scientific name: **Vulpes vulpes** (binomial, described by Linnaeus, 1758). IUCN status: * |
| hn-top | pass | 14 s | 2 | 0 | 27k / 0k | $0.000 | The #1 story is **"KetchUp – Open-source SketchUp alternative built with Rust and WebGPU"* |
| docs-search | pass | 27 s | 8 | 0 | 130k / 1k | $0.000 | `useState` returns an array with exactly two values: 1. **The current state** — during the |
| mui-autocomplete | pass | 48 s | 9 | 0 | 105k / 1k | $0.000 | Done — the first Movie combo box now has "The Godfather" selected. |
| radix-select | pass | 54 s | 12 | 0 | 158k / 1k | $0.000 | Done — the demo fruit select now shows "Banana". |
| drag-drop | pass | 18 s | 7 | 0 | 78k / 1k | $0.000 | Done — box A and box B have swapped places (left is now B, right is now A). |
| confirm-dialog | pass | 12 s | 5 | 0 | 55k / 0k | $0.000 | The page shows: **You clicked: Ok** |
| excalidraw | pass | 28 s | 5 | 0 | 58k / 0k | $0.000 | Rectangle drawn on the Excalidraw canvas (approx. 300×260 px). |
| rich-editor | pass | 47 s | 16 | 1 | 182k / 2k | $0.000 | Done. The editor now contains "Kitsune was here." with **Kitsune** in bold. |
| gov-uk | pass | 17 s | 3 | 0 | 36k / 0k | $0.000 | **£102** to renew an adult UK passport online (paper applications cost £115.50). |
| two-tabs | pass | 19 s | 6 | 0 | 64k / 1k | $0.000 | **Red fox is heavier on average.** - **Red fox:** weights range **2.2–14 kg (4.9–30.9 lb)* |
| upload | pass | 16 s | 4 | 0 | 45k / 0k | $0.000 | The page says: > **File Uploaded!** > kitsune-agent-upload.txt |
| signup-wizard | pass | 30 s | 10 | 0 | 110k / 1k | $0.000 | Your membership code is **FOX-4BQCJR**. (Email and password were rejected on step 1, so I  |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 20 | 60374 | 3019 | 0 |
| get_page_text | 11 | 39290 | 3572 | 0 |
| navigate | 18 | 20108 | 1117 | 0 |
| tabs_context_mcp | 17 | 8509 | 501 | 0 |
| browser_batch | 11 | 5755 | 523 | 0 |
| computer | 33 | 5551 | 168 | 0 |
| find | 5 | 2791 | 558 | 0 |
| invalid | 1 | 546 | 546 | 0 |
| javascript_tool | 1 | 144 | 144 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 1 | 36 | 36 | 0 |
