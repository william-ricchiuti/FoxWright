# Agent evaluation: OpenCode + Kitsune (synthetic input)

> Run 2026-11-08 with OpenCode 1.18.25 and the fixed `rich-editor` check. An earlier full run passed 17/17 under the old check, but its transcript shows the editor task had actually failed (bold toggled on an empty selection), so across both runs DeepSeek v4-pro solved 33 of 34.

2026-11-09T00:14:54.694Z · darwin arm64 · model deepseek/deepseek-v4-pro


**17/17 tasks succeeded** (checked in the browser, not taken from the agent's word). Median 19 s and 6 tool calls per task; total cost $0.09.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 14 s | 4 | 0 | 46k / 0k | $0.002 | The site shows: **"You logged into a secure area!"** |
| checkout | pass | 25 s | 9 | 0 | 99k / 1k | $0.005 | The confirmation page says: - **Checkout: Complete!** - **Thank you for your order!** - ** |
| practice-form | pass | 22 s | 6 | 0 | 73k / 1k | $0.006 | The confirmation dialog title is **"Thanks for submitting the form"**. |
| todos | pass | 19 s | 6 | 0 | 72k / 1k | $0.005 | Done. Added all three todos and marked "feed the fox" as completed (checkbox now `[checked |
| wiki-facts | pass | 11 s | 3 | 0 | 38k / 0k | $0.003 | Scientific name: **Vulpes vulpes**. IUCN conservation status: **Least Concern**. |
| hn-top | pass | 10 s | 2 | 0 | 27k / 0k | $0.002 | The #1 story is "KetchUp – Open-source SketchUp alternative built with Rust and WebGPU". |
| docs-search | pass | 20 s | 7 | 0 | 94k / 1k | $0.008 | `useState` returns an array with exactly two values: the current state (initially matching |
| mui-autocomplete | pass | 27 s | 10 | 0 | 119k / 1k | $0.007 | Done. The "Movie" combo box now shows "The Godfather" selected. |
| radix-select | pass | 27 s | 11 | 0 | 132k / 1k | $0.008 | Done. The "Food" combobox now shows "Banana". |
| drag-drop | pass | 15 s | 4 | 0 | 46k / 1k | $0.003 | Boxes swapped: column A now reads "B", column B now reads "A". |
| confirm-dialog | pass | 15 s | 5 | 0 | 55k / 0k | $0.003 | You clicked: Ok |
| excalidraw | pass | 53 s | 11 | 0 | 139k / 4k | $0.013 | Rectangle drawn. The canvas now shows a selected shape (the "Selected shape actions" panel |
| rich-editor | pass | 29 s | 10 | 0 | 112k / 1k | $0.006 | Done. The editor now contains "**Kitsune** was here." with "Kitsune" bolded (`<strong>Kits |
| gov-uk | pass | 12 s | 3 | 0 | 37k / 0k | $0.002 | Renewing an adult UK passport online (from the UK) costs **£102** for a standard 34-page p |
| two-tabs | pass | 18 s | 8 | 0 | 66k / 1k | $0.007 | The red fox is heavier. - **Red fox**: 2.2–14 kg (4.9–30.9 lb) - **Arctic fox**: males ave |
| upload | pass | 14 s | 5 | 0 | 55k / 0k | $0.003 | The page says: **File Uploaded!** `kitsune-agent-upload.txt` |
| signup-wizard | pass | 37 s | 14 | 2 | 155k / 1k | $0.008 | Your membership code is **FOX-4BQCJR**. |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 21 | 63437 | 3021 | 0 |
| get_page_text | 10 | 31980 | 3198 | 0 |
| navigate | 18 | 20048 | 1114 | 0 |
| tabs_context_mcp | 17 | 8511 | 501 | 0 |
| computer | 35 | 6047 | 173 | 0 |
| browser_batch | 9 | 5321 | 591 | 0 |
| find | 3 | 3018 | 1006 | 0 |
| file_upload | 1 | 107 | 107 | 0 |
| handle_dialog | 1 | 95 | 95 | 0 |
| tabs_create_mcp | 2 | 72 | 36 | 0 |
| javascript_tool | 1 | 38 | 38 | 0 |
