# Agent evaluation: Qwen Code + Foxwright (synthetic input, store build)

2026-11-17T02:47:28.434Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 2 times. pass@1: **88%** (7/8 runs). pass@2: 4/4 tasks. Passed every time: 3/4 tasks.

**7/8 runs succeeded** (checked in the browser, not taken from the agent's word). Median 23 s and 11 tool calls per task.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | pass | 19 s | 9 | 0 | 290k / 1k | – | **Copper kettle is cheaper: $31.91 total** (price $31.91, free shipping). - Copper: $31.91 |
| long-form | pass | 23 s | 11 | 0 | 370k / 1k | – | Submitted successfully. Reference number: **APP-E5VJZ0** Details as entered: Ada Lovelace, |
| slow-results | pass | 24 s | 11 | 0 | 351k / 1k | – | Top result for "fennec": **Fennec fox plush, large — SKU FX-1B4587** (Other results: Fenne |
| read-only-research | pass | 17 s | 6 | 0 | 201k / 1k | – | The guide's table lists five species; the longest-lived is the **Kit fox, at 6 years in th |
| compare-tabs | **fail** | 22 s | 12 | 0 | 324k / 1k | – | **Copper kettle — $25.90 total** ($25.90 + free shipping), vs. Steel kettle $48.69 ($36.19 |
| long-form | pass | 23 s | 11 | 0 | 369k / 1k | – | Submitted successfully. Your reference number is **APP-E5VJZ0**. Details as recorded: Ada  |
| slow-results | pass | 141 s | 54 | 1 | 2040k / 7k | – | Top result: **Fennec fox plush, large — SKU `FX-62C0A2`** (tab 6 is left open on the "fenn |
| read-only-research | pass | 57 s | 20 | 2 | 722k / 5k | – | **Kit fox — 6 years** lives longest in the wild among the species listed on the field guid |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 25 | 21030 | 841 | 0 |
| navigate | 22 | 6777 | 308 | 0 |
| get_page_text | 21 | 5236 | 249 | 0 |
| browser_batch | 9 | 3917 | 435 | 0 |
| tabs_context_mcp | 8 | 2520 | 315 | 0 |
| computer | 25 | 1986 | 79 | 0 |
| find | 3 | 1113 | 371 | 0 |
| read_network_requests | 5 | 534 | 107 | 0 |
| read_console_messages | 4 | 464 | 116 | 0 |
| form_input | 4 | 192 | 48 | 0 |
| tabs_create_mcp | 5 | 186 | 37 | 0 |
| tabs_close_mcp | 3 | 40 | 13 | 0 |
