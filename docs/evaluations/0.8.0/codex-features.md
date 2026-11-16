# Agent evaluation: Codex CLI + Foxwright (synthetic, ask input)

2026-11-16T18:20:52.412Z · linux arm64 · model gpt-6.1-sol

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **100%** (12/12 runs). pass@3: 4/4 tasks. Passed every time: 4/4 tasks.

**12/12 runs succeeded** (checked in the browser, not taken from the agent's word). Median 18 s and 3 tool calls per task.

Foxwright was in "ask" mode: a scripted user approved 3 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| read-only-site | pass | 12 s | 3 | 0 | 71k / 0k | – | Stock count: **17** Audit code: **AUDIT-a72741c2** Left the tab open without changing anyt |
| read-pdf | pass | 13 s | 3 | 0 | 90k / 0k | – | The document states **“Least Concern”** as the conservation status. The sentence is: **“Th |
| late-page | pass | 24 s | 3 | 0 | 89k / 0k | – | The delivery code is **DELIVERY-526beb67**. |
| long-page-diff | pass | 16 s | 5 | 0 | 123k / 0k | – | New shipment code: **SHIP-d1852fdd** Stock count: **23** Read only the outline changes aft |
| read-only-site | pass | 12 s | 3 | 0 | 89k / 0k | – | Stock count: **17** Audit code: **AUDIT-993c9687** The tab remains open. No page controls  |
| read-pdf | pass | 19 s | 4 | 0 | 113k / 0k | – | The document states **“Least Concern”** as the conservation status. The sentence is: “The  |
| late-page | pass | 24 s | 4 | 0 | 139k / 0k | – | The delivery code is `DELIVERY-793d9104`. |
| long-page-diff | pass | 18 s | 6 | 0 | 156k / 0k | – | Shipment code: **SHIP-1af2d772** Stock count: **23** Read only the outline changes after r |
| read-only-site | pass | 16 s | 3 | 0 | 72k / 0k | – | Stock count: **17** Audit code: **AUDIT-9cd29489** Left the tab open. No page controls wer |
| read-pdf | pass | 17 s | 3 | 0 | 71k / 0k | – | The document states **Least Concern**. The sentence is: “The quick brown fox jumps over th |
| late-page | pass | 24 s | 3 | 0 | 71k / 0k | – | The delivery code is **DELIVERY-8275b357**. |
| long-page-diff | pass | 18 s | 5 | 0 | 109k / 0k | – | New shipment code: **SHIP-6c9fc1e3** Stock count: **23** Read only the outline changes aft |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 12 | 125127 | 10427 | 0 |
| tabs_context_mcp | 12 | 7056 | 588 | 0 |
| navigate | 12 | 2447 | 204 | 0 |
| get_page_text | 3 | 936 | 312 | 0 |
| tabs_create_mcp | 3 | 112 | 37 | 0 |
| computer | 3 | 111 | 37 | 0 |
