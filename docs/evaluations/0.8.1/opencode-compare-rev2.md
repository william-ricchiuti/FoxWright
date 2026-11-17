# Agent evaluation: OpenCode + Foxwright (synthetic input, store build)

2026-11-17T02:51:27.252Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 6 times. pass@1: **83%** (5/6 runs). pass@6: 1/1 tasks. Passed every time: 0/1 tasks.

**5/6 runs succeeded** (checked in the browser, not taken from the agent's word). Median 14 s and 7 tool calls per task; total cost $0.01.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | pass | 12 s | 6 | 0 | 49k / 1k | $0.001 | Steel kettle: **$23.81 + $12.50 shipping = $36.31 total**. Copper kettle: $33.93 + $9.99 s |
| compare-tabs | pass | 12 s | 6 | 0 | 59k / 0k | $0.001 | **Steel kettle** is cheaper: **$30.78** total ($25.79 + $4.99 shipping). Copper is $32.71  |
| compare-tabs | pass | 13 s | 6 | 0 | 69k / 0k | $0.001 | **Copper kettle** is cheaper: $32.19 + $4.99 shipping = **$37.18** (steel: $35.38 + $4.99  |
| compare-tabs | pass | 14 s | 8 | 0 | 79k / 1k | $0.001 | **Copper kettle** is cheaper: $34.45 + $12.50 shipping = **$46.95**. Steel is $37.54 + $9. |
| compare-tabs | pass | 14 s | 7 | 0 | 59k / 1k | $0.001 | **Steel kettle** is cheaper: **$25.49 total** ($25.49 + free shipping). - Steel: $25.49 +  |
| compare-tabs | **fail** | 25 s | 14 | 0 | 107k / 2k | $0.002 | Steel kettle — $37.48 + $12.50 shipping = **$49.98** (vs. copper: $37.68 + $12.50 = $50.18 |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 9 | 6690 | 743 | 0 |
| navigate | 12 | 4253 | 354 | 0 |
| get_page_text | 10 | 2999 | 300 | 0 |
| tabs_context_mcp | 5 | 1580 | 316 | 0 |
| tabs_create_mcp | 7 | 259 | 37 | 0 |
| read_network_requests | 2 | 237 | 119 | 0 |
| computer | 2 | 66 | 33 | 0 |
