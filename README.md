# pi-context-kit

Context maintenance for [Pi](https://github.com/earendil-works/pi). It works with any model and needs no configuration.

## Install

```sh
pi install npm:pi-context-kit
```

## What it does

| When | Action |
| --- | --- |
| End of each turn | Replaces older reads of a file that a newer read covers. Only the last 8,000 tokens are edited, so the cached prompt prefix stays valid. |
| End of a turn above Pi's compaction threshold | Prunes old tool outputs and elides large old code or XML blocks and images. It keeps the edits only if they bring the context to 80% of the threshold or less. Otherwise Pi compacts. |
| Within 32,768 tokens of the threshold | Writes a handoff note in the background with the session model, from the live context. The prompt cache is reused. |
| Compaction | Uses the background note if it is ready, else writes a fresh note. If the note fails, Pi's own summary is used and a warning is shown. |
| Any time | The `recall` tool searches or reads the full session history, including pruned outputs and compacted messages. |

Notes:

- The handoff note uses the same sections as Pi's summary. It also gets Pi's `<read-files>` and `<modified-files>` sections, which cover the whole branch.
- `/compact <focus>` writes a fresh note for that focus.
- After a context overflow, a ready background note is used. Otherwise Pi's summary runs, because the live context no longer fits the model.
- Tool calls and thinking blocks are never edited. Each tool call keeps its result, and signed reasoning stays valid.
- Pi's compaction settings (`enabled`, `reserveTokens`, `modelOverrides`) set the threshold. With compaction disabled, only superseded reads are replaced.
- The note request disables tool use (`toolChoice: "none"`). A provider that rejects this gets Pi's summary and a warning.

## Development

```sh
npm install
npm run check
```

The tests run offline with Pi's faux provider.

## License

MIT
