# Agent evaluation: Claude Code + Kitsune (synthetic input)

2026-09-23T23:04:07.050Z · linux x64 · max turns 40

**16/16 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 17 s and 7 tool calls per task; total cost $1.57.

| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 14 s | 7 | 1 | 256k / 1k | $0.070 | Login succeeded. The site shows: **"You logged into a secure area!"** on the Secure Area p |
| checkout | pass | 20 s | 9 | 0 | 361k / 1k | $0.116 | Order completed. The confirmation page reads: **"Checkout: Complete!"** "Thank you for you |
| practice-form | pass | 17 s | 6 | 0 | 225k / 1k | $0.070 | The form was submitted successfully and the confirmation dialog title reads: **"Thanks for |
| todos | pass | 24 s | 14 | 0 | 538k / 2k | $0.162 | All three todos ("buy tofu", "feed the fox", "ship kitsune") were added, and "feed the fox |
| wiki-facts | pass | 10 s | 3 | 0 | 130k / 0k | $0.051 | According to Wikipedia's Red fox article: - **Scientific (binomial) name:** *Vulpes vulpes |
| hn-top | pass | 8 s | 2 | 0 | 94k / 0k | $0.030 | The current #1 story on Hacker News is: **"Claude discovers a novel enzyme system with CRI |
| docs-search | pass | 32 s | 15 | 0 | 748k / 2k | $0.334 | `useState` returns an array with exactly two values: 1. **The current state** — on the fir |
| mui-autocomplete | pass | 23 s | 9 | 0 | 338k / 1k | $0.100 | "The Godfather" has been selected in the first Movie combo box demo on the MUI Autocomplet |
| radix-select | pass | 15 s | 7 | 0 | 274k / 1k | $0.086 | "Banana" is now selected in the demo select. |
| drag-drop | pass | 17 s | 7 | 0 | 266k / 1k | $0.088 | Done — the left box now shows "B" and the right box shows "A", confirming they swapped pla |
| confirm-dialog | pass | 12 s | 7 | 0 | 254k / 1k | $0.067 | The page shows: **"You clicked: Ok"** |
| excalidraw | pass | 14 s | 6 | 0 | 240k / 1k | $0.079 | A rectangle has been drawn on the Excalidraw canvas. |
| rich-editor | pass | 20 s | 10 | 0 | 368k / 1k | $0.110 | Done. The editor now shows "**Kitsune** was here." with "Kitsune" bolded (the Bold toolbar |
| gov-uk | pass | 8 s | 3 | 0 | 125k / 0k | $0.035 | According to GOV.UK, renewing an adult UK passport online costs **£102** (compared to £115 |
| two-tabs | pass | 17 s | 8 | 0 | 254k / 1k | $0.109 | The **red fox is heavier on average**. - **Red fox** (*Vulpes vulpes*): weight ranges 2.2– |
| upload | pass | 11 s | 6 | 0 | 229k / 1k | $0.065 | The upload succeeded. The page now shows: **"File Uploaded!"** **kitsune-agent-upload.txt* |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 6 | 94122 | 15687 | 0 |
| get_page_text | 12 | 31334 | 2611 | 0 |
| navigate | 18 | 30277 | 1682 | 0 |
| read_network_requests | 1 | 8159 | 8159 | 0 |
| tabs_context_mcp | 16 | 4968 | 311 | 0 |
| browser_batch | 6 | 4368 | 728 | 0 |
| computer | 40 | 4037 | 101 | 9 |
| find | 6 | 3883 | 647 | 0 |
| form_input | 2 | 186 | 93 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 1 | 36 | 36 | 0 |
| ToolSearch | 9 | 0 | 0 | 0 |
