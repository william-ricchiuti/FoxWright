# Agent evaluation: Qwen Code + Foxwright (synthetic input, store build)

2026-11-17T02:53:40.695Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 4 times. pass@1: **88%** (7/8 runs). pass@4: 2/2 tasks. Passed every time: 1/2 tasks.

**7/8 runs succeeded** (checked in the browser, not taken from the agent's word). Median 23 s and 11 tool calls per task.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | pass | 13 s | 6 | 0 | 197k / 0k | – | **Copper kettle** is cheaper: $24.21 + $9.99 shipping = **$34.20** total. Steel kettle: $2 |
| slow-results | pass | 18 s | 7 | 0 | 227k / 1k | – | Top result: **Fennec fox plush, large — SKU FX-EA36BD** |
| compare-tabs | pass | 14 s | 10 | 0 | 200k / 1k | – | Copper kettle is cheaper once shipping is included. / Kettle / Price / Shipping / Total /  |
| slow-results | pass | 27 s | 14 | 0 | 450k / 1k | – | Top result for "fennec": **Fennec fox plush, large — SKU FX-5E1DDC** (Results below it: Fe |
| compare-tabs | **fail** | 33 s | 17 | 0 | 553k / 2k | – | **Copper kettle** is cheaper. - Copper: $22.22 (was $27.22) + $9.99 shipping = **$32.21**  |
| slow-results | pass | 23 s | 11 | 0 | 351k / 1k | – | Top result for "fennec": **Fennec fox plush, large — SKU FX-5FA302**. The search tab is le |
| compare-tabs | pass | 10 s | 6 | 0 | 137k / 1k | – | **Steel kettle — $35.79 total** ($30.80 + $4.99 shipping). - Copper: $32.37 + $9.99 shippi |
| slow-results | pass | 29 s | 14 | 0 | 446k / 1k | – | Top result for "fennec": **Fennec fox plush, large — SKU FX-58058B** (Results took a few s |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 18 | 12004 | 667 | 0 |
| navigate | 14 | 4168 | 298 | 0 |
| get_page_text | 12 | 2970 | 248 | 0 |
| tabs_context_mcp | 8 | 2520 | 315 | 0 |
| computer | 14 | 1106 | 79 | 0 |
| find | 2 | 615 | 308 | 0 |
| read_console_messages | 4 | 592 | 148 | 0 |
| read_network_requests | 3 | 331 | 110 | 0 |
| browser_batch | 1 | 214 | 214 | 0 |
| tabs_create_mcp | 5 | 185 | 37 | 0 |
| form_input | 3 | 129 | 43 | 0 |
| tabs_close_mcp | 1 | 13 | 13 | 0 |
