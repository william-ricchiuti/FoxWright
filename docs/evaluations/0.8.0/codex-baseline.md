# Agent evaluation: Codex CLI + Foxwright (synthetic, ask input)

2026-11-16T05:09:09.771Z · linux arm64 · model gpt-6.1-sol

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **2%** (1/51 runs). pass@3: 1/17 tasks. Passed every time: 0/17 tasks.

**1/51 runs succeeded** (checked in the browser, not taken from the agent's word). Median 2 s and 0 tool calls per task.

Foxwright was in "ask" mode: a scripted user approved 1 permission window(s).

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 20 s | 5 | 0 | 94k / 0k | – | The site shows: “You logged into a secure area!” I left the logged-in tab open for verific |
| checkout | **fail** | 6 s | 0 | 0 | 0k / 0k | – | I’ll use the browser to place the order and read the confirmation page. |
| practice-form | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| todos | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| wiki-facts | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| hn-top | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| docs-search | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| mui-autocomplete | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| radix-select | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| drag-drop | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| confirm-dialog | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| excalidraw | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| rich-editor | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| gov-uk | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| two-tabs | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| upload | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| signup-wizard | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| login | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| checkout | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| practice-form | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| todos | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| wiki-facts | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| hn-top | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| docs-search | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| mui-autocomplete | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| radix-select | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| drag-drop | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| confirm-dialog | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| excalidraw | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| rich-editor | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| gov-uk | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| two-tabs | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| upload | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| signup-wizard | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| login | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| checkout | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| practice-form | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| todos | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| wiki-facts | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| hn-top | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| docs-search | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| mui-autocomplete | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| radix-select | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| drag-drop | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| confirm-dialog | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| excalidraw | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| rich-editor | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| gov-uk | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| two-tabs | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |
| upload | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| signup-wizard | **fail** | 2 s | 0 | 0 | 0k / 0k | – |  |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 2 | 2571 | 1286 | 0 |
| browser_batch | 1 | 788 | 788 | 0 |
| navigate | 1 | 649 | 649 | 0 |
| tabs_context_mcp | 1 | 588 | 588 | 0 |
