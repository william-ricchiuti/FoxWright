# Agent evaluation: OpenCode + Foxwright (trusted input, full build)

2026-11-17T02:36:47.982Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**24/25 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 19 s and 6 tool calls per task; total cost $0.03.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 19 s | 4 | 0 | 49k / 0k | $0.001 | The message shown is: **"You logged into a secure area!"** The page also displays "Welcome |
| checkout | pass | 28 s | 9 | 1 | 108k / 1k | $0.001 | The confirmation page says: **Checkout: Complete!** **Thank you for your order!** Your ord |
| practice-form | pass | 22 s | 6 | 0 | 72k / 1k | $0.001 | Submitted successfully. The confirmation dialog title says **"Thanks for submitting the fo |
| todos | pass | 26 s | 12 | 0 | 149k / 1k | $0.002 | Done. All three todos added and "feed the fox" is checked completed. |
| wiki-facts | pass | 10 s | 3 | 0 | 42k / 0k | $0.001 | Scientific name: **Vulpes vulpes**. IUCN status: **Least Concern** (IUCN 3.1, assessed 202 |
| hn-top | pass | 9 s | 2 | 0 | 29k / 0k | $0.000 | The current #1 story is **"Carnegie Mellon is putting computer science courses on YouTube  |
| docs-search | pass | 25 s | 9 | 0 | 131k / 1k | $0.002 | Done — the useState reference page is open (https://react.dev/reference/react/useState). ` |
| mui-autocomplete | pass | 26 s | 11 | 0 | 132k / 1k | $0.002 | Done. The first "Movie" combo box now shows **The Godfather** (verified value: "The Godfat |
| radix-select | pass | 24 s | 9 | 0 | 114k / 1k | $0.001 | Done — the demo select now shows "Banana". Tab 12 is left open for verification. |
| drag-drop | pass | 17 s | 6 | 0 | 72k / 0k | $0.001 | Boxes swapped: left column now shows B, right shows A. Tab 14 left open for the verifier. |
| confirm-dialog | pass | 14 s | 5 | 0 | 59k / 0k | $0.001 | The page shows: **You clicked: Ok** |
| excalidraw | pass | 48 s | 17 | 0 | 226k / 2k | $0.003 | Rectangle drawn on the canvas. Tab left open for the verifier. |
| rich-editor | pass | 26 s | 10 | 0 | 118k / 2k | $0.002 | Done. The editor now contains **Kitsune** was here. — the paragraph shows `strong: Kitsune |
| gov-uk | pass | 19 s | 6 | 0 | 72k / 0k | $0.001 | **£102** to renew an adult (16+) standard 34-page UK passport online — £115.50 by paper. T |
| two-tabs | pass | 23 s | 7 | 0 | 91k / 0k | $0.002 | The **red fox** is heavier on average. - **Red fox**: 2.2–14 kg (4.9–30.9 lb); ~6–7 kg typ |
| upload | pass | 18 s | 7 | 0 | 81k / 1k | $0.001 | Uploaded. The page says **"File Uploaded!"** followed by the filename **"foxwright-agent-u |
| signup-wizard | pass | 21 s | 8 | 0 | 93k / 1k | $0.001 | **FOX-4BQCJR** |
| read-only-site | pass | 10 s | 3 | 0 | 38k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-cf9a6d3b** (Page has an "Add stock" button I left  |
| read-pdf | pass | 11 s | 3 | 0 | 38k / 0k | $0.000 | The document states conservation status: **Least Concern**. Sentence about the fox: **"The |
| late-page | pass | 19 s | 2 | 0 | 29k / 0k | $0.000 | Delivery code: **DELIVERY-2d924a97** |
| long-page-diff | pass | 16 s | 5 | 0 | 84k / 1k | $0.002 | Done. After pressing "Refresh inventory", the changed outline line reports: - **Shipment c |
| compare-tabs | **fail** | 15 s | 6 | 0 | 59k / 1k | $0.001 | **Copper kettle** is cheaper — **$28.80 total** (price $28.80, free shipping). Steel is $2 |
| long-form | pass | 35 s | 16 | 1 | 200k / 2k | $0.002 | Submitted. Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 22 s | 7 | 0 | 79k / 0k | $0.001 | **FX-F69EA6** — Fennec fox plush, large (top result for "fennec"). |
| read-only-research | pass | 12 s | 4 | 0 | 50k / 1k | $0.001 | Arctic fox — 7 years in the wild. (Tab left open.) |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 27 | 80327 | 2975 | 0 |
| get_page_text | 21 | 48990 | 2333 | 0 |
| navigate | 28 | 24510 | 875 | 0 |
| tabs_context_mcp | 23 | 7285 | 317 | 0 |
| computer | 43 | 7225 | 168 | 0 |
| browser_batch | 12 | 6946 | 579 | 0 |
| find | 5 | 4353 | 871 | 0 |
| javascript_tool | 8 | 1796 | 225 | 0 |
| invalid | 1 | 669 | 669 | 0 |
| form_input | 4 | 186 | 47 | 0 |
| tabs_create_mcp | 3 | 114 | 38 | 0 |
| file_upload | 1 | 111 | 111 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
