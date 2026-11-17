# Agent evaluation: OpenCode + Foxwright (trusted input, full build)

2026-11-17T02:44:46.312Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 2 times. pass@1: **50%** (1/2 runs). pass@2: 1/1 tasks. Passed every time: 0/1 tasks.

**1/2 runs succeeded** (checked in the browser, not taken from the agent's word). Median 21 s and 9 tool calls per task; total cost $0.00.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | pass | 16 s | 8 | 0 | 82k / 1k | $0.001 | **Copper kettle** is cheaper: **$30.00** total ($25.01 + $4.99 shipping) vs. steel at $41. |
| compare-tabs | **fail** | 21 s | 9 | 0 | 84k / 1k | $0.001 | **Steel kettle** is cheaper. Total: **$37.33** (free shipping). - Steel: $37.33 + $0 shipp |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 5 | 2930 | 586 | 0 |
| navigate | 4 | 1408 | 352 | 0 |
| tabs_context_mcp | 2 | 632 | 316 | 0 |
| get_page_text | 2 | 598 | 299 | 0 |
| computer | 2 | 184 | 92 | 0 |
| tabs_create_mcp | 2 | 74 | 37 | 0 |
