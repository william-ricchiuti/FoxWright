# Agent evaluation: OpenCode + Foxwright (synthetic input, store build)

2026-11-17T02:17:51.546Z · linux arm64 · model deepseek/deepseek-flash

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 3 times. pass@1: **99%** (74/75 runs). pass@3: 25/25 tasks. Passed every time: 24/25 tasks.

**74/75 runs succeeded** (checked in the browser, not taken from the agent's word). Median 19 s and 6 tool calls per task; total cost $0.09.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 14 s | 3 | 0 | 38k / 0k | $0.000 | Logged in. The site shows: **"You logged into a secure area!"** (and "Logged in as tomsmit |
| checkout | pass | 37 s | 16 | 3 | 195k / 2k | $0.002 | The confirmation page (Checkout: Complete!) says: **"Thank you for your order!"** — "Your  |
| practice-form | pass | 19 s | 6 | 0 | 70k / 1k | $0.001 | Submitted. The confirmation dialog title says **"Thanks for submitting the form"**. |
| todos | pass | 25 s | 12 | 0 | 139k / 1k | $0.002 | Done. All three todos added and "feed the fox" is checked completed. |
| wiki-facts | pass | 10 s | 3 | 0 | 39k / 0k | $0.001 | - **Scientific name:** *Vulpes vulpes* - **IUCN status:** Least Concern (IUCN 3.1) Source: |
| hn-top | pass | 8 s | 2 | 0 | 28k / 0k | $0.000 | The current #1 story is: **"Carnegie Mellon is putting computer science courses on YouTube |
| docs-search | pass | 24 s | 9 | 0 | 104k / 1k | $0.001 | From https://react.dev/reference/react/useState (found via the react.dev search): `useStat |
| mui-autocomplete | pass | 23 s | 9 | 0 | 109k / 1k | $0.001 | Done. The first "Movie" combo box demo now has "The Godfather" selected. |
| radix-select | pass | 25 s | 11 | 0 | 134k / 1k | $0.002 | Selected "Banana" in the demo fruit select at the top of the page (combobox now reads `Ban |
| drag-drop | pass | 19 s | 6 | 0 | 70k / 1k | $0.001 | Boxes swapped: A is now on the right, B on the left. Leaving the tab open. |
| confirm-dialog | pass | 16 s | 5 | 0 | 57k / 0k | $0.001 | You clicked: Ok |
| excalidraw | pass | 15 s | 5 | 0 | 59k / 0k | $0.001 | Rectangle drawn and selected on the canvas. Leaving the tab open for the verifier. |
| rich-editor | pass | 26 s | 9 | 0 | 102k / 1k | $0.001 | Done. The editor now reads "Kitsune was here." with **Kitsune** bold, and the tab is left  |
| gov-uk | pass | 12 s | 3 | 0 | 38k / 0k | $0.000 | It costs **£102** to renew an adult UK passport online (paper form is £115.50). Source: go |
| two-tabs | pass | 18 s | 7 | 0 | 77k / 1k | $0.003 | The **red fox** is heavier. Red foxes weigh **2.2–14 kg (4.9–30.9 lb)**, with vixens typic |
| upload | pass | 13 s | 5 | 0 | 57k / 0k | $0.001 | The page says: "File Uploaded!" followed by the filename "foxwright-agent-upload.txt". |
| signup-wizard | pass | 21 s | 8 | 0 | 95k / 1k | $0.001 | Membership code: **FOX-4BQCJR** |
| read-only-site | pass | 11 s | 3 | 0 | 37k / 0k | $0.000 | Stock count: **17** Audit code: **AUDIT-3c56a214** |
| read-pdf | pass | 9 s | 2 | 0 | 28k / 0k | $0.000 | Conservation status: **Least Concern**. The fox sentence: "The quick brown fox jumps over  |
| late-page | pass | 18 s | 3 | 0 | 37k / 0k | $0.000 | Delivery code: **DELIVERY-c51b91cc** |
| long-page-diff | pass | 15 s | 5 | 0 | 70k / 1k | $0.001 | New shipment code: **SHIP-ab2b105b**, stock count: **23** (was 17). |
| compare-tabs | **fail** | 35 s | 15 | 0 | 173k / 2k | $0.002 | **Copper kettle** — total **$38.61** ($28.62 + $9.99 shipping), vs. steel at **$47.84** ($ |
| long-form | pass | 25 s | 11 | 0 | 130k / 1k | $0.002 | Reference number: **APP-E5VJZ0**. |
| slow-results | pass | 27 s | 6 | 0 | 68k / 0k | $0.001 | Top result: **Fennec fox plush, large — SKU FX-AD3DAD** |
| read-only-research | pass | 23 s | 4 | 0 | 48k / 1k | $0.001 | The **Kit fox** lives longest — **6 years** in the wild (per the table on http://localhost |
| login | pass | 32 s | 4 | 0 | 48k / 0k | $0.001 | The site shows: **"You logged into a secure area!"** (a green flash banner, with "Welcome  |
| checkout | pass | 37 s | 8 | 0 | 94k / 1k | $0.001 | The confirmation page says: **"Checkout: Complete!"** / **"Thank you for your order!"** /  |
| practice-form | pass | 41 s | 7 | 0 | 84k / 1k | $0.001 | Submitted. The confirmation dialog title says: **"Thanks for submitting the form"** — all  |
| todos | pass | 19 s | 6 | 0 | 73k / 1k | $0.001 | Done. Three todos added; "feed the fox" is now checked/completed. Tab left open for verifi |
| wiki-facts | pass | 13 s | 3 | 0 | 39k / 0k | $0.000 | Red fox (*Vulpes vulpes*) — IUCN status: Least Concern (IUCN 3.1). The Wikipedia tab (tab  |
| hn-top | pass | 10 s | 2 | 0 | 28k / 0k | $0.000 | The #1 story is: **Carnegie Mellon is putting computer science courses on YouTube for free |
| docs-search | pass | 30 s | 10 | 0 | 145k / 1k | $0.003 | The useState reference page is open at https://react.dev/reference/react/useState. **useSt |
| mui-autocomplete | pass | 33 s | 10 | 1 | 106k / 1k | $0.001 | Done. The first Movie combobox now shows "The Godfather". |
| radix-select | pass | 21 s | 8 | 0 | 99k / 1k | $0.001 | Done. The demo fruit select now shows "Banana" (tab 12 left open for verification). |
| drag-drop | pass | 18 s | 6 | 0 | 71k / 1k | $0.001 | Swapped — box A is now in the right column and B in the left. Tab 13 left open for verific |
| confirm-dialog | pass | 13 s | 5 | 0 | 57k / 0k | $0.001 | The page shows: **You clicked: Ok** |
| excalidraw | pass | 27 s | 9 | 0 | 114k / 1k | $0.002 | Rectangle drawn on the Excalidraw canvas; the tab is left open for verification. |
| rich-editor | pass | 72 s | 28 | 0 | 393k / 5k | $0.006 | Done. The editor now reads **Kitsune** was here., with the word "Kitsune" bold (toolbar B  |
| gov-uk | pass | 17 s | 6 | 0 | 70k / 1k | $0.001 | £102 (standard 34-page adult passport, applying online). Both pages confirm: £102 online f |
| two-tabs | pass | 23 s | 7 | 0 | 75k / 1k | $0.001 | **Red fox** is heavier on average. - **Red fox** (*Vulpes vulpes*): adults weigh **2.2–14  |
| upload | pass | 17 s | 5 | 0 | 58k / 0k | $0.001 | Page says: **"File Uploaded!"** with the filename **"foxwright-agent-upload.txt"**. |
| signup-wizard | pass | 26 s | 12 | 2 | 139k / 1k | $0.002 | FOX-4BQCJR |
| read-only-site | pass | 11 s | 3 | 0 | 37k / 0k | $0.000 | Stock count: **17** — Audit code: **AUDIT-42ce1fa7** |
| read-pdf | pass | 11 s | 3 | 0 | 37k / 0k | $0.000 | The document states **Least Concern** as the conservation status, and the sentence about t |
| late-page | pass | 20 s | 3 | 0 | 38k / 0k | $0.000 | Delivery code: `DELIVERY-fded9271` |
| long-page-diff | pass | 14 s | 5 | 0 | 89k / 0k | $0.002 | New shipment code: **SHIP-5c1ac839**, stock count: **23**. |
| compare-tabs | pass | 15 s | 6 | 0 | 67k / 0k | $0.001 | The **Copper kettle** is cheaper — $23.48 + $9.99 shipping = **$33.47** total (steel: $27. |
| long-form | pass | 36 s | 19 | 1 | 235k / 2k | $0.003 | Submitted successfully. Reference number: **APP-E5VJZ0**. Fixes needed: phone entered as ` |
| slow-results | pass | 21 s | 8 | 0 | 87k / 1k | $0.001 | The top result is **Fennec fox plush, large** — SKU **FX-44C597**. |
| read-only-research | pass | 19 s | 7 | 1 | 82k / 1k | $0.001 | gray fox — 8 years in the wild. (Longest of the five species listed: red 2, Arctic 5, fenn |
| login | pass | 14 s | 4 | 0 | 48k / 0k | $0.001 | Logged in at `/secure`. The message shown: > "You logged into a secure area!" (with a × cl |
| checkout | pass | 25 s | 10 | 1 | 116k / 1k | $0.001 | The confirmation page says: **Checkout: Complete!** **Thank you for your order!** "Your or |
| practice-form | pass | 20 s | 5 | 0 | 59k / 1k | $0.001 | Submitted successfully. The confirmation dialog title says **"Thanks for submitting the fo |
| todos | pass | 21 s | 10 | 0 | 123k / 1k | $0.002 | Done. All three todos added ("buy tofu", "feed the fox", "ship kitsune"), and "feed the fo |
| wiki-facts | pass | 12 s | 3 | 0 | 40k / 0k | $0.001 | Red fox on Wikipedia: - **Scientific name:** *Vulpes vulpes* (Linnaeus, 1758) - **IUCN con |
| hn-top | pass | 12 s | 2 | 0 | 28k / 0k | $0.000 | The #1 story on Hacker News is **"Carnegie Mellon is putting computer science courses on Y |
| docs-search | pass | 27 s | 8 | 0 | 121k / 1k | $0.002 | `useState` returns an array with exactly two values: the current state (initially matching |
| mui-autocomplete | pass | 34 s | 11 | 0 | 133k / 1k | $0.002 | Selected "The Godfather" in the first Movie combo box demo. The tab is left open for verif |
| radix-select | pass | 27 s | 11 | 0 | 131k / 1k | $0.002 | Done. The demo fruit select now shows **Banana**. Tab 12 is left open for the verifier. |
| drag-drop | pass | 18 s | 6 | 0 | 71k / 1k | $0.001 | Swapped: box B is now on the left, box A on the right. Tab left open for the verifier. |
| confirm-dialog | pass | 15 s | 5 | 0 | 57k / 0k | $0.001 | The page shows: **You clicked: Ok** |
| excalidraw | pass | 19 s | 6 | 0 | 75k / 1k | $0.001 | Rectangle drawn on the canvas at excalidraw.com (tab left open). |
| rich-editor | pass | 43 s | 19 | 0 | 228k / 2k | $0.003 | Done. The editor now contains "Kitsune was here." with only **Kitsune** in bold; the tab i |
| gov-uk | pass | 13 s | 4 | 0 | 49k / 0k | $0.001 | £102 to renew an adult UK passport online (from the UK). |
| two-tabs | pass | 24 s | 9 | 0 | 113k / 1k | $0.003 | Red fox is heavier. - **Red fox** (en.wikipedia.org/wiki/Red_fox): weights range 2.2–14 kg |
| upload | pass | 18 s | 6 | 0 | 69k / 0k | $0.001 | The page says **"File Uploaded!"** with **foxwright-agent-upload.txt** listed below it. |
| signup-wizard | pass | 35 s | 19 | 0 | 218k / 2k | $0.002 | Your membership code is **FOX-4BQCJR**. |
| read-only-site | pass | 9 s | 3 | 0 | 37k / 0k | $0.000 | **Stock count:** 17 **Audit code:** AUDIT-0fb788db |
| read-pdf | pass | 9 s | 3 | 0 | 37k / 0k | $0.000 | The document states **Conservation status: Least Concern**, and the sentence is: **"The qu |
| late-page | pass | 18 s | 4 | 0 | 47k / 0k | $0.000 | DELIVERY-08e41ce6 |
| long-page-diff | pass | 12 s | 5 | 0 | 70k / 0k | $0.001 | Shipment code: **SHIP-4de1aeec**; stock count: **23**. |
| compare-tabs | pass | 63 s | 23 | 1 | 266k / 5k | $0.005 | Steel kettle is cheaper: **$24.96 + $12.50 shipping = $37.46 total** (copper: $36.45 + $4. |
| long-form | pass | 31 s | 16 | 2 | 195k / 2k | $0.002 | Submitted successfully. **Reference number: APP-E5VJZ0** (Only fix needed: postcode entere |
| slow-results | pass | 18 s | 7 | 1 | 77k / 0k | $0.001 | Top result: **Fennec fox plush, large — SKU FX-E21CB1** |
| read-only-research | pass | 16 s | 4 | 0 | 49k / 1k | $0.001 | **Kit fox — 8 years** (the longest lifespan in the wild among the five species listed). |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 89 | 216461 | 2432 | 0 |
| get_page_text | 63 | 138172 | 2193 | 0 |
| navigate | 92 | 71299 | 775 | 0 |
| browser_batch | 43 | 25720 | 598 | 0 |
| tabs_context_mcp | 73 | 23122 | 317 | 0 |
| computer | 148 | 22249 | 150 | 0 |
| find | 20 | 14243 | 712 | 0 |
| form_input | 16 | 824 | 52 | 0 |
| read_network_requests | 3 | 657 | 219 | 0 |
| file_upload | 3 | 333 | 111 | 0 |
| tabs_create_mcp | 8 | 304 | 38 | 0 |
| handle_dialog | 3 | 285 | 95 | 0 |
