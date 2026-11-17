# Agent evaluation: OpenCode + Foxwright (synthetic, ask input)

2026-11-16T18:16:09.185Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **100%** (3/3 runs). pass@3: 1/1 tasks. Passed every time: 1/1 tasks.

**3/3 runs succeeded** (checked in the browser, not taken from the agent's word). Median 12 s and 5 tool calls per task; total cost $0.00.

Foxwright was in "ask" mode: a scripted user approved 3 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| long-page-diff | pass | 13 s | 5 | 0 | 76k / 1k | $0.002 | Stock count: **23**, shipment code: **SHIP-a2c9b025**. |
| long-page-diff | pass | 12 s | 5 | 0 | 82k / 1k | $0.002 | Refreshed. New values: **Shipment code `SHIP-77daea79`**, **stock count 23** (was 17). |
| long-page-diff | pass | 12 s | 5 | 0 | 76k / 1k | $0.001 | Refreshed and read only the diff. New values: - **Shipment code:** SHIP-e7ac12e2 - **Stock |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 6 | 72449 | 12075 | 0 |
| tabs_context_mcp | 3 | 1770 | 590 | 0 |
| navigate | 3 | 582 | 194 | 0 |
| computer | 3 | 111 | 37 | 0 |
