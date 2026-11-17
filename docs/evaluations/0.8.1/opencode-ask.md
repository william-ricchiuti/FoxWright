# Agent evaluation: OpenCode + Foxwright (synthetic, ask input, store build)

2026-11-17T02:27:32.520Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**25/26 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 18 s and 6 tool calls per task; total cost $0.03.


Foxwright was in "ask" mode: a scripted user answered 16 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 17 s | 6 | 0 | 68k / 1k | $0.001 | Logged in successfully. The site shows: **"You logged into a secure area!"** — followed by |
| checkout | pass | 28 s | 10 | 1 | 116k / 1k | $0.001 | Order complete. Confirmation page says: - **"Checkout: Complete!"** - **"Thank you for you |
| practice-form | pass | 19 s | 5 | 0 | 59k / 1k | $0.001 | The confirmation dialog title says: **"Thanks for submitting the form"** The form was subm |
| todos | pass | 16 s | 6 | 0 | 73k / 1k | $0.001 | Done. All three todos added and "feed the fox" is checked. |
| wiki-facts | pass | 14 s | 3 | 0 | 39k / 0k | $0.001 | Scientific name: **Vulpes vulpes** (Linnaeus, 1758). IUCN status: **Least Concern** (IUCN  |
| hn-top | pass | 12 s | 3 | 0 | 39k / 0k | $0.000 | "Carnegie Mellon is putting computer science courses on YouTube for free" |
| docs-search | pass | 23 s | 8 | 0 | 91k / 1k | $0.001 | Opened https://react.dev/reference/react/useState (found via the site's search) and left t |
| mui-autocomplete | pass | 23 s | 8 | 0 | 94k / 1k | $0.001 | Selected "The Godfather" in the first Movie combo box (value now shows "The Godfather"). T |
| radix-select | pass | 31 s | 11 | 0 | 135k / 1k | $0.002 | Done — the fruit select now shows "Banana". The task tab (tab 22) is left open for the ver |
| drag-drop | pass | 17 s | 6 | 0 | 71k / 1k | $0.001 | Done — the boxes swapped: A is now on the right, B on the left. Tab 24 remains open for ve |
| confirm-dialog | pass | 14 s | 5 | 0 | 57k / 0k | $0.001 | The page shows: **You clicked: Ok** |
| excalidraw | pass | 25 s | 8 | 0 | 99k / 1k | $0.001 | Rectangle drawn on the Excalidraw canvas and selected. Tab 26 remains open for the verifie |
| rich-editor | pass | 38 s | 12 | 0 | 148k / 2k | $0.003 | Done. The editor now contains "Kitsune was here." with **Kitsune** in bold (verified in th |
| gov-uk | pass | 16 s | 5 | 0 | 60k / 0k | $0.001 | £102 for online renewal of a standard adult (16+) 34-page passport from the UK (£116 for t |
| two-tabs | pass | 15 s | 6 | 0 | 66k / 1k | $0.001 | The **red fox** is heavier on average. - **Red fox**: typically 2.2–14 kg (4.9–30.9 lb) ac |
| upload | pass | 15 s | 7 | 0 | 78k / 1k | $0.001 | The page says **"File Uploaded!"** with **`foxwright-agent-upload.txt`** listed below it. |
| signup-wizard | pass | 26 s | 12 | 0 | 136k / 1k | $0.002 | Membership code: **FOX-4BQCJR** |
| read-only-site | pass | 10 s | 3 | 0 | 37k / 0k | $0.000 | Stock count: **17**; audit code: **AUDIT-662293b3**. (Page read only; tab left open for ve |
| read-pdf | pass | 10 s | 3 | 0 | 37k / 0k | $0.000 | Conservation status: **Least Concern**. The sentence: "The quick brown fox jumps over the  |
| late-page | pass | 18 s | 3 | 0 | 38k / 0k | $0.000 | Delivery code: `DELIVERY-e105b058` |
| long-page-diff | pass | 14 s | 4 | 0 | 60k / 0k | $0.001 | New shipment code: **SHIP-f851a790**, stock count: **23**. |
| compare-tabs | **fail** | 23 s | 13 | 0 | 105k / 1k | $0.002 | **Copper kettle — total $36.95** ($36.95 price with free shipping). Steel kettle: $30.34 + |
| long-form | pass | 36 s | 15 | 0 | 182k / 1k | $0.002 | Submitted. Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 51 s | 24 | 0 | 258k / 2k | $0.003 | The top result is **Fennec fox plush, large — SKU FX-C63D2B**. |
| read-only-research | pass | 25 s | 9 | 1 | 105k / 2k | $0.002 | The **gray fox** — 6 years in the wild (the longest of the five species in the table). |
| denied-site | pass | 10 s | 2 | 1 | 28k / 0k | $0.000 | The site access request was denied, so I can't load the price list. If you approve Foxwrig |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 26 | 40771 | 1568 | 0 |
| get_page_text | 26 | 25951 | 998 | 0 |
| navigate | 31 | 23933 | 772 | 0 |
| computer | 50 | 8248 | 165 | 0 |
| tabs_context_mcp | 25 | 7921 | 317 | 0 |
| browser_batch | 14 | 6116 | 437 | 0 |
| find | 8 | 5095 | 637 | 0 |
| read_console_messages | 3 | 444 | 148 | 0 |
| read_network_requests | 3 | 320 | 107 | 0 |
| form_input | 5 | 240 | 48 | 0 |
| tabs_create_mcp | 3 | 114 | 38 | 0 |
| file_upload | 1 | 111 | 111 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_close_mcp | 1 | 14 | 14 | 0 |
