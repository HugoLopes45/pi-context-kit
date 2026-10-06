# Changelog

## Unreleased

- Send handoff note requests with the session's thinking level and tool choice, so Anthropic reuses the cached conversation instead of re-billing it; reject notes that call a tool.

## 0.2.0

- Keep older read results when a newer full or ranged read is truncated, count the replaced read in the stale suffix budget, and preserve user-role messages during shaking.
- Bound recall regex searches in a worker and propagate cancellation; keep regex syntax errors and result paging.
- Reject length-truncated or oversized handoff notes, validate retained-context budgets, and use only ready background notes during native, manual, and overflow compaction.
- Apply the configured strategy order at both custom and Pi thresholds, including while a background note is unfinished; scale the background-note lead with small thresholds.
- Preserve projected retained history after earlier compactions and context edits; keep Pi's token estimate when maintenance makes no edits.
- Clarify measured provider behavior, fallback paths, and metadata-only image recall.

- `contextKit` settings, named after the `compaction.*` settings of oh-my-pi: `enabled`, `thresholdTokens`, `thresholdPercent`, `methodOrder`, `asyncEnabled`, `supersedeReads`, and the prune and shake budgets.
- An earlier threshold compacts at the end of a turn, without interrupting the run.
- The background note starts one eighth of the threshold early, capped at 32,000 tokens.
- By default, a handoff note is tried before shaking.
- A failed threshold note is not retried until the next compaction.

## 0.1.0

- Superseded read replacement at the end of each turn.
- Pruning of old tool outputs and elision of old blocks and images above the compaction threshold.
- Handoff compaction from the live context, with a background note near the threshold.
- `recall` tool for the full session history.
