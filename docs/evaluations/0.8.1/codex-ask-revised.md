# Agent evaluation: Codex CLI + Foxwright (synthetic, ask input, store build)

2026-11-17T02:50:26.442Z · linux arm64

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**5/5 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 22 s and 6 tool calls per task.


Foxwright was in "ask" mode: a scripted user answered 2 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| compare-tabs | pass | 22 s | 6 | 0 | 119k / 0k | – | The **Copper kettle is cheaper**, totaling **$32.95** ($27.96 + $4.99 shipping). The Steel |
| long-form | pass | 32 s | 9 | 0 | 205k / 1k | – | Application submitted successfully. Your reference number is **APP-E5VJZ0**. The confirmat |
| slow-results | pass | 29 s | 7 | 1 | 146k / 0k | – | The top result is “Fennec fox plush, large” — SKU **FX-514A23**. |
| read-only-research | pass | 15 s | 3 | 0 | 93k / 0k | – | The **Arctic fox** lives longest in the wild among the species listed: **7 years**, accord |
| denied-site | pass | 17 s | 3 | 1 | 92k / 0k | – | Foxwright reported that access to the site was denied, so I couldn’t check the Den members |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 9 | 6517 | 724 | 0 |
| browser_batch | 3 | 4368 | 1456 | 0 |
| navigate | 6 | 2009 | 335 | 0 |
| tabs_context_mcp | 5 | 1571 | 314 | 0 |
| tabs_create_mcp | 2 | 74 | 37 | 0 |
| computer | 2 | 64 | 32 | 0 |
| form_input | 1 | 43 | 43 | 0 |
