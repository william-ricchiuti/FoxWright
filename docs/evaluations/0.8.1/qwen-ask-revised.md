# Agent evaluation: Qwen Code + Foxwright (synthetic, ask input, store build)

2026-11-17T02:48:30.175Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**2/3 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 21 s and 10 tool calls per task.


Foxwright was in "ask" mode: a scripted user answered 2 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | **fail** | 21 s | 12 | 0 | 326k / 1k | – | **Steel kettle** is cheaper: **$24.96 total** (free shipping), vs. the copper kettle at $2 |
| read-only-research | pass | 28 s | 10 | 2 | 338k / 2k | – | **Fennec fox — 6 years** in the wild. From the field guide table (5 species listed): / Spe |
| denied-site | pass | 10 s | 2 | 1 | 76k / 0k | – | Foxwright was denied access to `http://b.test:8765`, so I couldn't load the price list. If |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| navigate | 7 | 2930 | 419 | 0 |
| read_page | 2 | 2093 | 1047 | 0 |
| get_page_text | 4 | 1455 | 364 | 0 |
| tabs_context_mcp | 3 | 945 | 315 | 0 |
| run_shell_command | 1 | 132 | 132 | 0 |
| tabs_create_mcp | 3 | 111 | 37 | 0 |
| read_network_requests | 1 | 108 | 108 | 0 |
| computer | 1 | 33 | 33 | 0 |
| tabs_close_mcp | 2 | 26 | 13 | 0 |
