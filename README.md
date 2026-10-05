# pi-context-kit

Context maintenance for [Pi](https://github.com/earendil-works/pi). It uses the active session model for handoff notes; if that request fails or cannot fit, Pi's summary remains the fallback. Offline integration tests use Pi's faux provider.

## Install

```sh
pi install npm:pi-context-kit
```

## What it does

| When | Action |
| --- | --- |
| End of each turn | Replaces older reads only when a newer successful read covers them. Truncated whole-file reads do not cover older ranges. Replacements are limited by `staleSuffixTokens`; this is not a guarantee about provider prompt caching. |
| End of a turn above the threshold | Prunes old tool outputs. It keeps the edits only if they bring the context to 80% of the threshold or less. Otherwise the methods in `methodOrder` run. |
| Before the threshold | Can write a handoff note in the background from the live context. Its lead is one eighth of the threshold, capped at 32,000 tokens. |
| Compaction | Uses a ready background note without waiting. Otherwise it may write a fresh note when the retained context can fit the target. Failed, truncated, oversized, or unavailable notes fall back to Pi's summary. |
| Any time | `recall` searches or reads raw entries on the current branch, including compacted and context-edited messages. Images are represented by MIME metadata, not recovered image pixels. Regex searches run in a worker with a deadline. |

Automatic maintenance runs between model requests:

- At Pi's threshold, Pi compacts between two model requests and the run continues.
- At an earlier `thresholdTokens` or `thresholdPercent`, a handoff is appended only when the retained context and note fit the progress target. Otherwise maintenance continues in the configured order. The extension never calls `ctx.compact()`, which aborts the run.
- The kept part always holds the latest messages and tool results.
- An early automatic handoff can defer while a relevant background note is still being written. Native, manual, and overflow compaction never wait for an unfinished note.

Notes:

- The handoff note uses the same sections as Pi's summary. It also gets Pi's `<read-files>` and `<modified-files>` sections, which cover the whole branch.
- `/compact <focus>` requests a fresh note for that focus when the retained context leaves enough room. Otherwise Pi handles the request.
- After a context overflow, a ready background note is used. Otherwise Pi's summary runs, because the live context no longer fits the model.
- User-role messages are never shaken, preserving instructions and images. Tool calls and thinking blocks are never edited; each tool call keeps its result, and signed reasoning stays valid. Images removed from eligible tool outputs can only be recalled as metadata.
- With Pi's compaction disabled, only superseded reads are replaced.
- The note request disables tool use (`toolChoice: "none"`) and caps output to the available budget. Providers can differ; failures use Pi's summary. Prompt-cache reuse is provider-dependent and is not guaranteed.
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
| `enabled` | `true` | Set to `false` to disable maintenance and handoff compaction. `recall` stays available. |
| `thresholdTokens` | `-1` | Starts automatic maintenance above this token count. Overrides `thresholdPercent`. `-1` uses `thresholdPercent`. |
| `thresholdPercent` | `-1` | Starts automatic maintenance above this percentage of the context window, at most 99%. `-1` uses Pi's threshold only. |
| `methodOrder` | `["handoff", "shake", "soft"]` | What runs, in order, when pruning is not enough. `handoff`: a note by the session model. `shake`: elides large old code or XML blocks and images, without a model call. `soft`: Pi's own summary. `remote` and `snapcompact` are accepted and skipped, because Pi lacks them. |
| `asyncEnabled` | `true` | Writes the handoff note in the background before the threshold. |
| `supersedeReads` | `true` | Replaces older reads of a file that was read again. |
| `staleSuffixTokens` | `8000` | Replaces superseded reads only when the entire replaced entry and newer suffix fit this many tokens. |
| `progressRatio` | `0.8` | Pruning, shaking, and handoff notes must reduce the estimated context to this fraction of the threshold. |
| `prune.enabled` | `true` | Prunes old tool outputs above the threshold. |
| `prune.protectTokens` | `40000` | Newest tool-output tokens that are never pruned. |
| `prune.minSavings` | `20000` | Prunes nothing unless the savings reach this many tokens. |
| `prune.minTokens` | `50` | Outputs smaller than this are never pruned. |
| `shake.protectTokens` | `16000` | Newest context tokens that are never shaken; user-role messages are always protected. |
| `shake.minSavings` | `4000` | Shakes nothing unless the savings reach this many tokens. |
| `shake.blockMinTokens` | `400` | Blocks smaller than this stay. |

`methodOrder` controls end-of-turn maintenance. `soft` ends that sequence and leaves compaction to Pi at its own threshold; methods after `soft` do not run. A failed or unavailable handoff can fall back to `shake` before `soft`.

Pi's compaction hook cannot append context edits. Manual compaction, overflow recovery, and compaction triggered before a turn can use a handoff note or Pi's summary, but cannot run `shake` there.

Pi still compacts at its own threshold (`compaction.reserveTokens`, `compaction.modelOverrides`). Earlier thresholds request maintenance, not guaranteed compaction: an oversized retained tool result may leave no room for a useful note. Budget checks use Pi's token estimates; actual provider token counts and cache behavior can differ.

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
