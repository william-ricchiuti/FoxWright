# Agent evaluation: Codex CLI + Foxwright (synthetic input, store build)

2026-11-17T02:41:52.606Z · linux arm64

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**6/6 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 29 s and 8 tool calls per task.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| mui-autocomplete | pass | 29 s | 8 | 0 | 147k / 0k | – | Selected “The Godfather” in the first “Movie” combo box and verified the value. Left the t |
| radix-select | pass | 29 s | 8 | 0 | 179k / 0k | – | Selected “Banana” in the top demo fruit select and verified it displays Banana. Left the t |
| gov-uk | pass | 21 s | 3 | 0 | 93k / 0k | – | It costs **£102** to renew an adult UK passport online from within the UK, according to [G |
| signup-wizard | pass | 53 s | 9 | 0 | 229k / 1k | – | Your membership code is **FOX-4BQCJR**. The confirmation tab is left open. |
| long-page-diff | pass | 21 s | 5 | 0 | 127k / 0k | – | Shipment code: **SHIP-337aedf3** Stock count: **23** Read only the outline changes after r |
| long-form | pass | 38 s | 8 | 0 | 205k / 1k | – | Application submitted successfully. Your reference number is **APP-E5VJZ0**. The confirmat |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 10 | 28691 | 2869 | 0 |
| browser_batch | 6 | 7523 | 1254 | 0 |
| navigate | 6 | 5480 | 913 | 0 |
| tabs_context_mcp | 6 | 1884 | 314 | 0 |
| get_page_text | 1 | 1514 | 1514 | 0 |
| find | 3 | 1087 | 362 | 0 |
| computer | 8 | 616 | 77 | 0 |
| tabs_create_mcp | 1 | 37 | 37 | 0 |
