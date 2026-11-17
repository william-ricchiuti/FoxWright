# Agent evaluation: OpenCode + Foxwright (synthetic, ask input, store build)

2026-11-17T02:48:31.429Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 2 times. pass@1: **100%** (8/8 runs). pass@2: 4/4 tasks. Passed every time: 4/4 tasks.

**8/8 runs succeeded** (checked in the browser, not taken from the agent's word). Median 11 s and 4 tool calls per task; total cost $0.00.


Foxwright was in "ask" mode: a scripted user answered 5 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| read-only-site | pass | 10 s | 3 | 0 | 38k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-d5ddf539** Read-only page, nothing was clicked or  |
| compare-tabs | pass | 16 s | 7 | 0 | 69k / 0k | $0.001 | The **Copper kettle** is cheaper: $25.49 + $12.50 shipping = **$37.99** total. Steel comes |
| read-only-research | pass | 10 s | 3 | 0 | 38k / 0k | $0.000 | **Gray fox** — 6 years in the wild. (Longest of the five listed: Red 3, Arctic 2, Fennec 4 |
| denied-site | pass | 11 s | 2 | 1 | 28k / 0k | $0.000 | The permission window for `http://b.test:8765` was denied, so I can't load the page or loo |
| read-only-site | pass | 10 s | 3 | 0 | 38k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-66586fd8** Tab left open for the verifier. |
| compare-tabs | pass | 136 s | 11 | 4 | 112k / 1k | $0.001 | **Steel kettle — $39.80 total** ($34.81 + $4.99 shipping). The copper kettle comes to $42. |
| read-only-research | pass | 14 s | 5 | 1 | 58k / 0k | $0.001 | **Gray fox — 7 years** in the wild (the longest of the five species listed; Red 2, Kit 3,  |
| denied-site | pass | 11 s | 4 | 2 | 47k / 0k | $0.000 | Foxwright's permission window for `http://b.test:8765` was denied, so I can't load the pri |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| navigate | 13 | 3161 | 243 | 0 |
| tabs_context_mcp | 11 | 3057 | 278 | 0 |
| get_page_text | 8 | 2649 | 331 | 0 |
| read_page | 2 | 330 | 165 | 0 |
| computer | 1 | 151 | 151 | 0 |
| tabs_create_mcp | 3 | 109 | 36 | 0 |
