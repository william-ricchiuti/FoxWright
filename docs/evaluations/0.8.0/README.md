# Foxwright 0.8.0 agent evaluation

The evaluation used Firefox 160.0 on Linux arm64 in Docker, with the Full extension, synthetic input, and the Foxwright `--ask` policy. The scripted user granted one-time approvals when prompted. The new tasks use local fixtures, and the verifier checks both browser state and tool use. The follow-up harness starts a fresh Firefox profile and helper for each repetition and asks agents to leave their tabs open for verification. The initial DeepSeek baseline used the release harness, which reused a profile across repetitions.

## Results on the release tool descriptions

| Model | Suite | Browser passes | Provider blocks | Reported API cost |
| --- | --- | ---: | ---: | ---: |
| OpenCode · `deepseek/deepseek-flash` | 17 baseline tasks × 3 | 50/51 (98.0%) | 0 | $0.060700 |
| Codex CLI · `gpt-6.1-sol` | 17 baseline tasks × 3 scheduled | 1/1 | 50 | Unreported (ChatGPT sign-in) |
| OpenCode · `deepseek/deepseek-flash` | 4 new tasks × 3 | 11/12 (91.7%) | 0 | $0.007701 |
| OpenCode · `deepseek/deepseek-flash` | Rich editor follow-up | 3/3 | 0 | $0.005764 |

DeepSeek passed every baseline task at least once and 16/17 tasks on all three runs. The one editor failure occurred after the agent closed its tab before verification. With the leave-tabs-open instruction, the three independent follow-up attempts all passed. OpenCode reported $0.013465 for the combined feature and editor follow-up.

All 50 blocked Codex transcripts show the ChatGPT usage-limit error and have zero Foxwright tool calls. The login was the only attempt that reached Firefox and it passed. The raw report counts provider blocks in the scheduled denominator (1/51).

| New task | DeepSeek passes | What the verifier checked |
| --- | ---: | --- |
| Read-only inventory | 3/3 | Correct live count and audit code, unchanged fixture and no write attempts |
| Firefox PDF | 3/3 | Correct PDF facts and use of `get_page_text` |
| Delayed report | 3/3 | Correct live delivery code and use of `wait_for` in a page read |
| Long inventory diff | 2/3 | One refresh, correct live code and stock, and a matching `read_page` diff |

In the failed long-page attempt, the agent added `visible_only: true` on its diff request. Foxwright returned the full scoped outline and explained that the prior read used different options. The agent reported the correct values, but the attempt failed the diff check. The updated `read_page` descriptions name the arguments that must match and explain that `max_chars` can change.

All three DeepSeek diff reruns passed with the revised descriptions ($0.004904). The original 2/3 result remains in the release-description report. OpenCode reported $0.079069 across all DeepSeek runs.

The Codex PDF probe passed after the usage limit cleared. Using the revised descriptions, Codex then passed all 12 feature attempts (100%, 3/3 for each task) with no provider blocks. The baseline was left as recorded.

## Reports

- DeepSeek baseline [summary](deepseek-baseline.md) and [JSON](deepseek-baseline.json)
- Codex baseline [summary](codex-baseline.md) and [JSON](codex-baseline.json)
- DeepSeek features and editor [summary](deepseek-features.md) and [JSON](deepseek-features.json)
- DeepSeek diff rerun [summary](deepseek-diff-rerun.md) and [JSON](deepseek-diff-rerun.json)
- Codex PDF probe [summary](codex-feature-probe.md) and [JSON](codex-feature-probe.json)
- Codex features [summary](codex-features.md) and [JSON](codex-features.json)
