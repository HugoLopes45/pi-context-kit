# Changelog

## 0.2.0

- `contextKit` settings, named after the `compaction.*` settings of oh-my-pi: `enabled`, `thresholdTokens`, `thresholdPercent`, `methodOrder`, `asyncEnabled`, `supersedeReads`, and the prune and shake budgets.
- An earlier threshold compacts at the end of a turn, without interrupting the run.
- The background note starts one eighth of the threshold early, from 8,192 to 32,000 tokens.
- By default, a handoff note is tried before shaking.
- A failed threshold note is not retried until the next compaction.

## 0.1.0

- Superseded read replacement at the end of each turn.
- Pruning of old tool outputs and elision of old blocks and images above the compaction threshold.
- Handoff compaction from the live context, with a background note near the threshold.
- `recall` tool for the full session history.
