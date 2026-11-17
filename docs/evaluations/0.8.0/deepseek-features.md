# Agent evaluation: OpenCode + Foxwright (synthetic, ask input)

2026-11-16T18:15:14.696Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **93%** (14/15 runs). pass@3: 5/5 tasks. Passed every time: 4/5 tasks.

**14/15 runs succeeded** (checked in the browser, not taken from the agent's word). Median 10 s and 4 tool calls per task; total cost $0.01.

Foxwright was in "ask" mode: a scripted user approved 9 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| rich-editor | pass | 29 s | 13 | 0 | 163k / 2k | $0.002 | Done. The snow playground editor now contains "<strong>Kitsune</strong> was here." with "K |
| read-only-site | pass | 9 s | 4 | 0 | 52k / 0k | $0.000 | Stock count: 17 Audit code: AUDIT-f63e25f1 Page tab (tab 6) is left open for the verifier. |
| read-pdf | pass | 8 s | 3 | 0 | 41k / 0k | $0.000 | Conservation status: **Least Concern**. Quick brown fox sentence: "The quick brown fox jum |
| late-page | pass | 15 s | 3 | 0 | 41k / 0k | $0.000 | Delivery code: **DELIVERY-e615d5a8** |
| long-page-diff | **fail** | 13 s | 5 | 0 | 76k / 1k | $0.002 | Refreshed. Changed outline line only: - Before: `Stock count: 17. Shipment code: PENDING`  |
| rich-editor | pass | 32 s | 14 | 0 | 182k / 2k | $0.002 | Done. The editor now contains "Kitsune was here." with Kitsune bold (`<strong>`) — confirm |
| read-only-site | pass | 9 s | 4 | 0 | 52k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-20c4ffaa** Read-only page reviewed without interac |
| read-pdf | pass | 8 s | 3 | 0 | 41k / 0k | $0.000 | - Conservation status: **Least Concern** - Sentence: "The quick brown fox jumps over the l |
| late-page | pass | 16 s | 3 | 0 | 41k / 0k | $0.000 | The delivery code is **DELIVERY-cde278ec**. The report tab remains open for the verifier. |
| long-page-diff | pass | 10 s | 5 | 0 | 76k / 0k | $0.001 | Shipment code: **SHIP-3f368a23**; stock count: **23**. |
| rich-editor | pass | 23 s | 10 | 0 | 124k / 1k | $0.002 | Done. The editor now contains "Kitsune was here." with "Kitsune" in bold, and tab 3 is lef |
| read-only-site | pass | 7 s | 4 | 0 | 41k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-bef0cec8** Read-only; nothing was clicked or chang |
| read-pdf | pass | 9 s | 3 | 0 | 41k / 0k | $0.000 | **Conservation status:** Least Concern. **Fox sentence:** "The quick brown fox jumps over  |
| late-page | pass | 15 s | 3 | 0 | 41k / 0k | $0.000 | Delivery code: **DELIVERY-add57ddc** |
| long-page-diff | pass | 10 s | 5 | 0 | 76k / 0k | $0.001 | New shipment code: **SHIP-f649f2c0**, stock count: **23** (previously 17, PENDING). |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 18 | 70372 | 3910 | 0 |
| tabs_context_mcp | 15 | 8853 | 590 | 0 |
| navigate | 15 | 5529 | 369 | 0 |
| computer | 27 | 2129 | 79 | 0 |
| get_page_text | 6 | 1425 | 238 | 0 |
| javascript_tool | 1 | 10 | 10 | 0 |
