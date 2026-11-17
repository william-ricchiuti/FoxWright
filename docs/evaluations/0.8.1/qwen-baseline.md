# Agent evaluation: Qwen Code + Foxwright (synthetic input, store build)

2026-11-17T02:38:01.554Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 2 times. pass@1: **96%** (48/50 runs). pass@2: 24/25 tasks. Passed every time: 24/25 tasks.

**48/50 runs succeeded** (checked in the browser, not taken from the agent's word). Median 18 s and 7 tool calls per task.



| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 14 s | 5 | 0 | 166k / 1k | – | Logged in successfully. The site redirected to `/secure` and shows the flash message: **"Y |
| checkout | pass | 24 s | 10 | 1 | 330k / 1k | – | Order completed. The confirmation page says: **"Checkout: Complete!"** / **"Thank you for  |
| practice-form | pass | 17 s | 6 | 0 | 199k / 1k | – | Form submitted successfully — all values match (Ada Lovelace, ada@example.com, Female, 555 |
| todos | pass | 18 s | 8 | 0 | 276k / 1k | – | Done — three todos added and "feed the fox" marked completed (counter shows "2 items left! |
| wiki-facts | pass | 11 s | 3 | 0 | 107k / 0k | – | **Red fox** - **Scientific name:** *Vulpes vulpes* (genus *Vulpes*, species *V. vulpes*; f |
| hn-top | pass | 10 s | 4 | 0 | 137k / 0k | – | **"Carnegie Mellon is putting computer science courses on YouTube for free"** (cmu.edu, 76 |
| docs-search | pass | 23 s | 9 | 0 | 304k / 1k | – | From the react.dev reference page (opened via the site search): **`useState(initialState)` |
| mui-autocomplete | pass | 26 s | 10 | 0 | 340k / 1k | – | The first "Movie" combo box now shows "The Godfather". Tab 10 is left open for verificatio |
| radix-select | pass | 23 s | 10 | 0 | 358k / 1k | – | The demo fruit select now shows "Banana" in the trigger. Tab 11 remains open on the Select |
| drag-drop | pass | 23 s | 9 | 0 | 294k / 2k | – | Done — box A and box B have swapped places. - Before: left column `#column-a` = "A", right |
| confirm-dialog | pass | 13 s | 5 | 0 | 164k / 0k | – | The page shows: **"You clicked: Ok"** |
| excalidraw | pass | 36 s | 12 | 0 | 412k / 3k | – | Rectangle drawn and left selected on the Excalidraw canvas. Verification from the page: th |
| rich-editor | pass | 61 s | 18 | 0 | 679k / 6k | – | Done — the Quill (snow theme) playground editor in tab 15 now contains: - `<p><strong>Kits |
| gov-uk | pass | 14 s | 5 | 0 | 168k / 1k | – | **£102** — renewing an adult (16+) standard 34-page passport online from the UK. For compa |
| two-tabs | pass | 17 s | 7 | 0 | 241k / 1k | – | The red fox is the heavier species. **Red fox** (Wikipedia, "Description → Dimensions"): t |
| upload | pass | 12 s | 5 | 0 | 164k / 0k | – | The upload succeeded. The page says: - **Heading:** "File Uploaded!" - **Filename shown:** |
| signup-wizard | pass | 18 s | 8 | 0 | 267k / 1k | – | Your membership code is **FOX-4BQCJR**. Notes on what happened: - Step 1 initially rejecte |
| read-only-site | pass | 8 s | 3 | 0 | 105k / 0k | – | **Stock count:** 17 **Audit code:** AUDIT-f84867ec Read-only page, nothing clicked or chan |
| read-pdf | pass | 8 s | 2 | 0 | 76k / 0k | – | Read in Firefox (`/pdf/simple.pdf`): - **Conservation status:** Least Concern - **Quick br |
| late-page | pass | 18 s | 4 | 0 | 134k / 0k | – | Confirmed on the page: **DELIVERY-9141db0c** (from "Report ready. Delivery code: DELIVERY- |
| long-page-diff | pass | 13 s | 5 | 0 | 185k / 1k | – | Done — the only change was the status line. - **Shipment code:** SHIP-90e2737b - **Stock c |
| compare-tabs | **fail** | 135 s | 46 | 3 | 1576k / 13k | – | **Copper kettle — $30.29 total** (incl. free shipping). - Copper: now $30.29, "Free shippi |
| long-form | pass | 34 s | 18 | 1 | 605k / 2k | – | Application submitted successfully. - **Reference number: APP-E5VJZ0** - Name: Ada Lovelac |
| slow-results | pass | 23 s | 11 | 0 | 350k / 1k | – | Searched the catalog for "fennec" — 3 results returned, top result is **Fennec fox plush,  |
| read-only-research | pass | 43 s | 15 | 1 | 513k / 3k | – | According to the field guide (the table currently showing, no clicks made): **Gray fox — 8 |
| login | pass | 12 s | 4 | 0 | 136k / 0k | – | Login succeeded — the site landed on `/secure` and showed: **"You logged into a secure are |
| checkout | pass | 24 s | 10 | 0 | 330k / 1k | – | The confirmation page says: **Checkout: Complete!** **Thank you for your order!** "Your or |
| practice-form | pass | 17 s | 6 | 0 | 199k / 1k | – | Form submitted successfully. The confirmation dialog title says: **"Thanks for submitting  |
| todos | pass | 23 s | 11 | 0 | 374k / 1k | – | Done — tab 6 left open at the TodoMVC React demo with three todos added and "feed the fox" |
| wiki-facts | pass | 11 s | 3 | 0 | 107k / 0k | – | **Red fox** — Wikipedia ([Red fox](https://en.wikipedia.org/wiki/Red_fox)): - **Scientific |
| hn-top | pass | 9 s | 3 | 0 | 107k / 0k | – | The #1 story on Hacker News right now is: **"Carnegie Mellon is putting computer science c |
| docs-search | pass | 35 s | 15 | 1 | 622k / 2k | – | The useState reference page is open in tab 9, reached via the react.dev search. **`useStat |
| mui-autocomplete | pass | 25 s | 10 | 0 | 333k / 1k | – | Done — the first "Movie" combo box on the MUI Autocomplete page has "The Godfather" select |
| radix-select | pass | 21 s | 8 | 0 | 272k / 1k | – | The demo fruit select now shows **Banana**. Tab 11 is left open for the verifier. |
| drag-drop | pass | 25 s | 9 | 0 | 297k / 2k | – | Done — dragged A onto B; the page's two columns now read **B** (left) and **A** (right), c |
| confirm-dialog | pass | 12 s | 5 | 0 | 164k / 0k | – | The page shows: **`You clicked: Ok`** Tab 14 is left open on the page for the verifier. |
| excalidraw | pass | 39 s | 13 | 2 | 482k / 3k | – | Done. In tab 15 (excalidraw.com) I selected the Rectangle tool and dragged a rectangle rou |
| rich-editor | pass | 27 s | 10 | 0 | 323k / 1k | – | Done. The editor at https://quilljs.com/playground/snow now contains "Kitsune was here." w |
| gov-uk | pass | 16 s | 6 | 0 | 200k / 1k | – | **£102** — the online fee for a standard 34-page adult (16+) passport from the UK (paper a |
| two-tabs | pass | 24 s | 9 | 0 | 223k / 1k | – | **Red fox is the heavier species.** - **Red fox** (*Vulpes vulpes*) — largest of the true  |
| upload | pass | 13 s | 5 | 0 | 164k / 0k | – | The page says: > **File Uploaded!** > foxwright-agent-upload.txt (The tab is left open at  |
| signup-wizard | pass | 17 s | 6 | 0 | 202k / 1k | – | Your membership code: **FOX-4BQCJR** The form rejected the first email/password, so I used |
| read-only-site | pass | 11 s | 4 | 0 | 134k / 0k | – | - **Stock count:** 17 - **Audit code:** AUDIT-b0d3dbe8 The page is still open in its tab f |
| read-pdf | pass | 10 s | 3 | 0 | 105k / 0k | – | Read from the PDF (`simple.pdf`, 1 page): - **Conservation status:** "Conservation status: |
| late-page | pass | 16 s | 2 | 0 | 76k / 0k | – | The delivery code is **DELIVERY-0c62a94e**. |
| long-page-diff | pass | 13 s | 5 | 0 | 185k / 0k | – | Done. - Shipment code: **SHIP-949f4e31** - Stock count: **23** (was 17) Tab 25 (Long inven |
| compare-tabs | **fail** | 68 s | 33 | 1 | 980k / 5k | – | **Steel kettle** is cheaper. Both pages list "Free shipping," so shipping adds nothing: /  |
| long-form | pass | 34 s | 19 | 0 | 631k / 2k | – | Submitted successfully — your reference number is **APP-E5VJZ0**. Details recorded: Ada Lo |
| slow-results | pass | 18 s | 5 | 0 | 164k / 0k | – | Top result: **Fennec fox plush, large — SKU FX-51D3B3** (3 results for "fennec"). Tab left |
| read-only-research | pass | 14 s | 4 | 0 | 136k / 1k | – | **Gray fox — 7 years** in the wild (the longest of the five species listed: Red fox 2, Arc |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 78 | 153246 | 1965 | 0 |
| get_page_text | 58 | 64061 | 1105 | 0 |
| navigate | 73 | 53067 | 727 | 0 |
| browser_batch | 36 | 27673 | 769 | 0 |
| computer | 91 | 16310 | 179 | 0 |
| tabs_context_mcp | 50 | 16032 | 321 | 0 |
| find | 20 | 9382 | 469 | 0 |
| read_network_requests | 7 | 938 | 134 | 0 |
| form_input | 12 | 606 | 51 | 0 |
| read_console_messages | 4 | 592 | 148 | 0 |
| tabs_create_mcp | 7 | 266 | 38 | 0 |
| file_upload | 2 | 222 | 111 | 0 |
| handle_dialog | 2 | 190 | 95 | 0 |
| run_shell_command | 1 | 132 | 132 | 0 |
| resize_window | 2 | 53 | 27 | 0 |
| tabs_close_mcp | 3 | 42 | 14 | 0 |
