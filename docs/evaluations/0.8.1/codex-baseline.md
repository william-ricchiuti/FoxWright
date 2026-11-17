# Agent evaluation: Codex CLI + Foxwright (synthetic input, store build)

2026-11-17T02:16:12.559Z · linux arm64

Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.

Each task ran 2 times. pass@1: **88%** (44/50 runs). pass@2: 25/25 tasks. Passed every time: 19/25 tasks.

**44/50 runs succeeded** (checked in the browser, not taken from the agent's word). Median 30 s and 5 tool calls per task.


| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |
|---|---|---|---|---|---|---|---|
| login | pass | 26 s | 5 | 0 | 120k / 0k | – | The site shows: “You logged into a secure area!” I left the logged-in tab open for verific |
| checkout | pass | 42 s | 10 | 0 | 241k / 1k | – | The order is complete. The confirmation page says: “Thank you for your order!” “Your order |
| practice-form | pass | 26 s | 5 | 0 | 149k / 0k | – | Submitted successfully. The confirmation dialog title says: **“Thanks for submitting the f |
| todos | pass | 36 s | 6 | 0 | 152k / 0k | – | Added all three todos and verified “feed the fox” is completed. The other two remain activ |
| wiki-facts | pass | 21 s | 4 | 0 | 122k / 0k | – | According to [Wikipedia](https://en.wikipedia.org/wiki/Red_fox), the red fox’s scientific  |
| hn-top | pass | 28 s | 3 | 0 | 94k / 0k | – | The current #1 story is “Carnegie Mellon is putting computer science courses on YouTube fo |
| docs-search | pass | 52 s | 11 | 0 | 273k / 1k | – | According to the [useState reference](https://react.dev/reference/react/useState#returns), |
| mui-autocomplete | **fail** | 3 s | 0 | 0 | 0k / 0k | – |  |
| radix-select | **fail** | 4 s | 0 | 0 | 0k / 0k | – |  |
| drag-drop | pass | 25 s | 5 | 0 | 121k / 0k | – | Swapped successfully: B is on the left and A is on the right. Left the tab open for verifi |
| confirm-dialog | pass | 24 s | 6 | 0 | 122k / 0k | – | The page shows: **You clicked: Ok** |
| excalidraw | pass | 31 s | 7 | 0 | 123k / 0k | – | Drew a rectangle on Excalidraw and verified it on the canvas. Left the tab open. |
| rich-editor | pass | 49 s | 9 | 0 | 122k / 0k | – | Done: the editor contains “**Kitsune** was here.” The tab is left open for verification. |
| gov-uk | **fail** | 11 s | 0 | 0 | 0k / 0k | – | I’ll check the current fee on GOV.UK using the browser. |
| two-tabs | pass | 83 s | 8 | 0 | 210k / 0k | – | The **red fox is generally heavier**. - [Red fox](https://en.wikipedia.org/wiki/Red_fox):  |
| upload | pass | 33 s | 6 | 0 | 146k / 0k | – | The page says **“File Uploaded!”** and displays `foxwright-agent-upload.txt`. I left the t |
| signup-wizard | pass | 57 s | 8 | 0 | 209k / 1k | – | Your membership code is **FOX-4BQCJR**. The completed signup tab is open for verification. |
| read-only-site | pass | 36 s | 4 | 0 | 133k / 0k | – | Stock count: **17** Audit code: **AUDIT-a9e69a51** Left the tab open without clicking, typ |
| read-pdf | pass | 20 s | 3 | 0 | 92k / 0k | – | The document states **“Conservation status: Least Concern.”** The sentence is: **“The quic |
| late-page | pass | 33 s | 4 | 0 | 118k / 0k | – | The delivery code is **DELIVERY-5a42b948**. |
| long-page-diff | pass | 30 s | 5 | 0 | 127k / 0k | – | New shipment code: **SHIP-e402d0be** Stock count: **23** Read only the outline changes aft |
| compare-tabs | pass | 28 s | 6 | 0 | 119k / 0k | – | The **steel kettle is cheaper at $27.14 total**, with free shipping. The copper kettle tot |
| long-form | **fail** | 9 s | 0 | 0 | 0k / 0k | – | I’ll fill out and submit the library card application, correcting any format errors the fo |
| slow-results | pass | 48 s | 7 | 1 | 146k / 0k | – | The top result is “Fennec fox plush, large” — SKU **FX-9E228E**. |
| read-only-research | pass | 23 s | 3 | 0 | 92k / 0k | – | The **kit fox** lives longest among the species listed in the [field guide](http://localho |
| login | pass | 34 s | 5 | 0 | 146k / 0k | – | The site shows: “You logged into a secure area!” I left the logged-in tab open for verific |
| checkout | pass | 49 s | 10 | 0 | 241k / 1k | – | The order is complete. The confirmation page says: “Thank you for your order!” “Your order |
| practice-form | pass | 36 s | 5 | 0 | 149k / 0k | – | Submitted successfully. The confirmation dialog title says: **“Thanks for submitting the f |
| todos | pass | 35 s | 6 | 0 | 152k / 0k | – | Added all three todos and marked “feed the fox” completed. Verified two items remain activ |
| wiki-facts | pass | 37 s | 3 | 0 | 94k / 0k | – | According to [Wikipedia](https://en.wikipedia.org/wiki/Red_fox), the red fox’s scientific  |
| hn-top | pass | 19 s | 3 | 0 | 94k / 0k | – | The current #1 story is “Carnegie Mellon is putting computer science courses on YouTube fo |
| docs-search | pass | 97 s | 14 | 1 | 343k / 1k | – | According to the [useState reference](https://react.dev/reference/react/useState#returns), |
| mui-autocomplete | pass | 28 s | 8 | 0 | 147k / 0k | – | Selected “The Godfather” in the first “Movie” combo box and verified the value. The tab re |
| radix-select | pass | 33 s | 8 | 0 | 180k / 0k | – | Selected Banana in the top demo fruit select and verified it displays “Banana.” Left the t |
| drag-drop | pass | 41 s | 5 | 0 | 121k / 0k | – | Done—B is now on the left and A on the right. The tab remains open for verification. |
| confirm-dialog | pass | 22 s | 6 | 0 | 122k / 0k | – | The page shows: **You clicked: Ok** |
| excalidraw | pass | 29 s | 7 | 0 | 152k / 0k | – | Drew a rectangle on the Excalidraw canvas and left the tab open for verification. |
| rich-editor | pass | 26 s | 9 | 0 | 122k / 0k | – | Done: the editor contains “**Kitsune** was here.” The tab is left open for verification. |
| gov-uk | pass | 18 s | 3 | 0 | 93k / 0k | – | It costs **£102** to renew an adult UK passport online from within the UK, according to [G |
| two-tabs | pass | 43 s | 8 | 0 | 188k / 0k | – | The **red fox is generally heavier**. - [Red fox](https://en.wikipedia.org/wiki/Red_fox):  |
| upload | pass | 32 s | 7 | 0 | 172k / 0k | – | The page says **“File Uploaded!”** and displays `foxwright-agent-upload.txt`. I left the t |
| signup-wizard | **fail** | 4 s | 0 | 0 | 0k / 0k | – |  |
| read-only-site | pass | 22 s | 3 | 0 | 92k / 0k | – | Stock count: **17** Audit code: **AUDIT-27750680** Read only; no controls used. Tab left o |
| read-pdf | pass | 17 s | 3 | 0 | 92k / 0k | – | The conservation status is **Least Concern**. The sentence is: “The quick brown fox jumps  |
| late-page | pass | 30 s | 4 | 0 | 118k / 0k | – | The delivery code is `DELIVERY-c5f0c8fd`. |
| long-page-diff | **fail** | 4 s | 0 | 0 | 0k / 0k | – |  |
| compare-tabs | pass | 24 s | 6 | 0 | 119k / 0k | – | The **copper kettle is cheaper**, totaling **$35.90** with shipping ($23.40 + $12.50). The |
| long-form | pass | 41 s | 9 | 0 | 231k / 1k | – | Application submitted. Your reference number is **APP-E5VJZ0**. |
| slow-results | pass | 32 s | 7 | 0 | 172k / 0k | – | The top result is “Fennec fox plush, large” — SKU **FX-5630B4**. |
| read-only-research | pass | 21 s | 3 | 0 | 92k / 0k | – | The Arctic fox lives longest among the species listed in the [field guide](http://localhos |

## What the tools cost in context

| Tool | Calls | Result text (chars) | Avg per call | Screenshots |
|---|---|---|---|---|
| read_page | 60 | 130969 | 2183 | 0 |
| get_page_text | 23 | 64454 | 2802 | 0 |
| browser_batch | 19 | 54050 | 2845 | 0 |
| navigate | 48 | 40079 | 835 | 0 |
| tabs_context_mcp | 44 | 13849 | 315 | 0 |
| computer | 43 | 10163 | 236 | 6 |
| find | 6 | 3262 | 544 | 0 |
| tabs_create_mcp | 14 | 529 | 38 | 0 |
| form_input | 6 | 318 | 53 | 0 |
| file_upload | 2 | 222 | 111 | 0 |
| handle_dialog | 2 | 190 | 95 | 0 |
