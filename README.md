# pi-context-kit

Context maintenance for [Pi](https://github.com/earendil-works/pi). It works with any model, inside subagents too, and needs no configuration.

## Install

```sh
pi install npm:pi-context-kit
```

## What it does

| When | Action |
| --- | --- |
| End of each turn | Replaces older reads of a file that a newer read covers. Only the newest 8,000 tokens are edited, so the cached prompt prefix stays valid. |
| End of a turn above the threshold | Prunes old tool outputs. It keeps the edits only if they bring the context to 80% of the threshold or less. Otherwise the methods in `methodOrder` run. |
| Before the threshold | Writes a handoff note in the background with the session model, from the live context. The prompt cache is reused. The lead is one eighth of the threshold, from 8,192 to 32,000 tokens. |
| Compaction | Uses the background note if it is ready, else writes a new note. If the note fails, Pi's own summary is used and a warning is shown. |
| Any time | The `recall` tool searches or reads the full session history, including pruned outputs and compacted messages. |

Compaction never interrupts work in progress:

- At Pi's threshold, Pi compacts between two model requests and the run continues.
- At an earlier `thresholdTokens` or `thresholdPercent`, the extension appends the compaction at the end of a turn and the run continues. It never calls `ctx.compact()`, which aborts the run.
- The kept part always holds the latest messages and tool results.
- If the background note is still being written, compaction waits for a later turn. Pi's threshold still applies.

Notes:

- The handoff note uses the same sections as Pi's summary. It also gets Pi's `<read-files>` and `<modified-files>` sections, which cover the whole branch.
- `/compact <focus>` writes a new note for that focus.
- After a context overflow, a ready background note is used. Otherwise Pi's summary runs, because the live context no longer fits the model.
- Tool calls and thinking blocks are never edited. Each tool call keeps its result, and signed reasoning stays valid.
- With Pi's compaction disabled, only superseded reads are replaced.
- The note request disables tool use (`toolChoice: "none"`). A provider that rejects this gets Pi's summary and a warning.
- Subagents run the extension in their own sessions with their own settings. Without a UI, warnings are not shown.

## Settings

Add a `contextKit` object to `~/.pi/agent/settings.json` or `.pi/settings.json`. Project settings override global settings. Changes apply after `/reload` or a restart. An invalid value shows a warning and keeps its default. The names follow the `compaction.*` settings of oh-my-pi.

```json
{
  "contextKit": {
    "thresholdTokens": 150000,
    "methodOrder": ["handoff", "shake", "soft"]
  }
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Turns off maintenance and handoff compaction. `recall` stays available. |
| `thresholdTokens` | `-1` | Compacts above this many tokens. Overrides `thresholdPercent`. `-1` uses `thresholdPercent`. |
| `thresholdPercent` | `-1` | Compacts above this percentage of the context window, at most 99%. `-1` uses Pi's threshold only. |
| `methodOrder` | `["handoff", "shake", "soft"]` | What runs, in order, when pruning is not enough. `handoff`: a note by the session model. `shake`: elides large old code or XML blocks and images, without a model call. `soft`: Pi's own summary. `remote` and `snapcompact` are accepted and skipped, because Pi lacks them. |
| `asyncEnabled` | `true` | Writes the handoff note in the background before the threshold. |
| `supersedeReads` | `true` | Replaces older reads of a file that was read again. |
| `staleSuffixTokens` | `8000` | Replaces superseded reads only within this many newest tokens. |
| `progressRatio` | `0.8` | Pruning and shaking must reach this fraction of the threshold, or compaction runs. |
| `prune.enabled` | `true` | Prunes old tool outputs above the threshold. |
| `prune.protectTokens` | `40000` | Newest tool-output tokens that are never pruned. |
| `prune.minSavings` | `20000` | Prunes nothing unless the savings reach this many tokens. |
| `prune.minTokens` | `50` | Outputs smaller than this are never pruned. |
| `shake.protectTokens` | `16000` | Newest context tokens that are never shaken. |
| `shake.minSavings` | `4000` | Shakes nothing unless the savings reach this many tokens. |
| `shake.blockMinTokens` | `400` | Blocks smaller than this stay. |

Pi still compacts at its own threshold (`compaction.reserveTokens`, `compaction.modelOverrides`), so `thresholdTokens` and `thresholdPercent` can only make compaction earlier.

## Development

```sh
npm install
npm run check
```

The tests run offline with Pi's faux provider.

## Contributing and releases

1. Open a pull request. CI runs `npm run check` on Node 22 and 24.
2. Add user-visible changes under `## Unreleased` in `CHANGELOG.md`.
3. To release, run `npm run release -- <patch|minor|major|x.y.z>` from an up-to-date, clean `main`. The script names the `Unreleased` section after the version, updates `package.json`, runs the checks, and opens a release pull request.
4. Merge the release pull request. The `Release` workflow publishes the package to npm with provenance and creates the GitHub release from the CHANGELOG section.

The workflow publishes through npm trusted publishing, so the repository stores no npm token.

## License

MIT
