# Agent evaluation: Claude Code + Kitsune (trusted input)

2026-09-23T23:08:51.743Z · linux x64 · max turns 40

**16/16 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 15 s and 7 tool calls per task; total cost $1.58.

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 13 s | 7 | 0 | 238k / 1k | $0.074 | Login succeeded. The site shows: **"You logged into a secure area!"** on the Secure Area p |
| checkout | pass | 18 s | 8 | 0 | 294k / 1k | $0.085 | Order completed successfully. The confirmation page ("Checkout: Complete!") reads: **"Than |
| practice-form | pass | 18 s | 7 | 0 | 257k / 1k | $0.076 | The form was submitted successfully, with all details correctly reflected (Ada Lovelace, a |
| todos | pass | 19 s | 12 | 0 | 437k / 1k | $0.126 | Done — all three todos were added, and "feed the fox" is now marked completed (shown with  |
| wiki-facts | pass | 11 s | 3 | 0 | 130k / 0k | $0.051 | According to Wikipedia: - **Scientific name:** *Vulpes vulpes* (Linnaeus, 1758) - **IUCN c |
| hn-top | pass | 13 s | 3 | 0 | 128k / 0k | $0.042 | The current #1 story on Hacker News is: **"Claude discovers a novel enzyme system with CRI |
| docs-search | pass | 40 s | 18 | 0 | 821k / 3k | $0.283 | Note: the search on react.dev is currently broken — its Algolia backend returned 404s on e |
| mui-autocomplete | pass | 29 s | 14 | 0 | 557k / 1k | $0.171 | "The Godfather" is now selected in the Movie combo box demo (shown with the clear "×" butt |
| radix-select | pass | 15 s | 7 | 0 | 280k / 1k | $0.091 | Done — the demo select now shows "Banana" selected. |
| drag-drop | pass | 14 s | 6 | 0 | 227k / 1k | $0.070 | The drag completed successfully — box A and box B have swapped places (column A now shows  |
| confirm-dialog | pass | 11 s | 6 | 0 | 228k / 1k | $0.066 | The page shows: **"You clicked: Ok"** |
| excalidraw | pass | 14 s | 6 | 0 | 237k / 1k | $0.077 | Done — a rectangle has been drawn on the Excalidraw canvas. |
| rich-editor | pass | 25 s | 12 | 0 | 474k / 2k | $0.150 | The editor now shows "**Kitsune** was here." with "Kitsune" bolded and the Bold toolbar bu |
| gov-uk | pass | 8 s | 3 | 0 | 125k / 0k | $0.034 | According to gov.uk, it costs **£102** to renew an adult UK passport online (compared to £ |
| two-tabs | pass | 18 s | 8 | 0 | 254k / 1k | $0.114 | Both articles are now open in separate tabs. Here's what they say about typical weight: ** |
| upload | pass | 12 s | 6 | 0 | 236k / 1k | $0.071 | The upload succeeded. The page now shows: **"File Uploaded!"** **kitsune-agent-upload.txt* |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| get_page_text | 10 | 33109 | 3311 | 0 |
| navigate | 18 | 30984 | 1721 | 0 |
| read_page | 4 | 18830 | 4708 | 0 |
| tabs_context_mcp | 16 | 4968 | 311 | 0 |
| read_network_requests | 1 | 4959 | 4959 | 0 |
| computer | 46 | 4851 | 105 | 14 |
| browser_batch | 4 | 3698 | 925 | 0 |
| find | 6 | 2537 | 423 | 0 |
| form_input | 5 | 289 | 58 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 1 | 36 | 36 | 0 |
| ToolSearch | 13 | 0 | 0 | 0 |
