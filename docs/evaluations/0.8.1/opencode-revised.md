# Agent evaluation: OpenCode + Foxwright (synthetic input, store build)

2026-11-17T02:43:52.712Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **94%** (17/18 runs). pass@3: 6/6 tasks. Passed every time: 5/6 tasks.

**17/18 runs succeeded** (checked in the browser, not taken from the agent's word). Median 23 s and 8 tool calls per task; total cost $0.02.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| checkout | pass | 25 s | 9 | 0 | 106k / 1k | $0.002 | Order complete. The confirmation page says: - **"Checkout: Complete!"** - **"Thank you for |
| signup-wizard | pass | 15 s | 5 | 0 | 63k / 1k | $0.001 | FOX-4BQCJR |
| compare-tabs | **fail** | 28 s | 13 | 0 | 109k / 2k | $0.002 | Both pages are static (no dynamic pricing or checkout step), and shipping is shown inline. |
| long-form | pass | 26 s | 13 | 0 | 157k / 1k | $0.002 | Submitted. Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 21 s | 8 | 0 | 88k / 1k | $0.001 | The top result is **Fennec fox plush, large — SKU FX-02906A**. |
| read-only-research | pass | 17 s | 5 | 0 | 60k / 1k | $0.001 | **Fennec fox — 8 years** in the wild, the longest among the five species listed (the "Load |
| checkout | pass | 23 s | 8 | 0 | 95k / 1k | $0.001 | Confirmation page (`/checkout-complete.html`) says: **"Checkout: Complete!"** **"Thank you |
| signup-wizard | pass | 23 s | 11 | 1 | 126k / 1k | $0.001 | Your membership code is **FOX-4BQCJR**. |
| compare-tabs | pass | 15 s | 8 | 0 | 70k / 1k | $0.001 | **Steel kettle — $24.85 total** (free shipping). - Steel: $24.85 + free shipping = **$24.8 |
| long-form | pass | 28 s | 15 | 0 | 177k / 1k | $0.002 | Submitted successfully. Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 19 s | 8 | 0 | 88k / 1k | $0.001 | The top result is **Fennec fox plush, large — SKU FX-B07281**. |
| read-only-research | pass | 11 s | 4 | 0 | 48k / 0k | $0.001 | **Gray fox** — 8 years in the wild (the longest of the five listed species). Tab left open |
| checkout | pass | 33 s | 15 | 0 | 172k / 1k | $0.002 | Done. The confirmation page says: **"Thank you for your order!"** — with the subtitle **"Y |
| signup-wizard | pass | 25 s | 12 | 0 | 137k / 1k | $0.002 | **FOX-4BQCJR** (Fixed email to `ada@example.com` and password to `kitsune2026!`; chose Fen |
| compare-tabs | pass | 17 s | 8 | 0 | 90k / 1k | $0.001 | The **Copper kettle** is cheaper: $31.69 + $9.99 shipping = **$41.68** total (Steel: $32.0 |
| long-form | pass | 23 s | 11 | 0 | 132k / 1k | $0.002 | Application submitted. Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 21 s | 8 | 0 | 88k / 1k | $0.001 | Top result: **Fennec fox plush, large — SKU FX-AC425A** |
| read-only-research | pass | 15 s | 5 | 0 | 60k / 1k | $0.001 | Kit fox — 6 years in the wild. |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 34 | 28960 | 852 | 0 |
| browser_batch | 26 | 14630 | 563 | 0 |
| computer | 28 | 7710 | 275 | 0 |
| get_page_text | 22 | 7194 | 327 | 0 |
| navigate | 20 | 7047 | 352 | 0 |
| tabs_context_mcp | 15 | 4744 | 316 | 0 |
| find | 2 | 820 | 410 | 0 |
| form_input | 10 | 532 | 53 | 0 |
| read_network_requests | 3 | 335 | 112 | 0 |
| tabs_create_mcp | 5 | 185 | 37 | 0 |
| read_console_messages | 1 | 20 | 20 | 0 |
