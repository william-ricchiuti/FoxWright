# Agent evaluation: Codex CLI + Foxwright (synthetic, ask input)

2026-11-16T18:16:43.638Z · linux arm64 · model gpt-6.1-sol

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.


**1/1 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 19 s and 4 tool calls per task.

Foxwright was in "ask" mode: a scripted user approved 1 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| read-pdf | pass | 19 s | 4 | 0 | 92k / 0k | – | The document states **“Least Concern”** as the conservation status. The sentence is: “The  |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| tabs_context_mcp | 1 | 588 | 588 | 0 |
| get_page_text | 1 | 312 | 312 | 0 |
| navigate | 1 | 244 | 244 | 0 |
| tabs_create_mcp | 1 | 37 | 37 | 0 |
