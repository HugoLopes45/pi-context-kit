# pi-context-kit: long Pi sessions that stay sharp

English | [简体中文](https://github.com/HugoLopes45/pi-context-kit/blob/main/README.zh-CN.md)

[![CI](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-context-kit)](https://www.npmjs.com/package/pi-context-kit)
[![Pi package](https://img.shields.io/badge/pi.dev-package-blue)](https://pi.dev/packages/pi-context-kit)
[![Node.js](https://img.shields.io/node/v/pi-context-kit)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/pi-context-kit)](LICENSE)

Pi compaction and context management for the [Pi coding agent](https://github.com/earendil-works/pi). pi-context-kit clears stale file reads and old tool outputs out of the context window, writes the handoff summary in the background before Pi needs it, and keeps the original text of the current branch one `recall` search away.

```sh
pi install npm:pi-context-kit
```

Restart Pi. The defaults work without configuration.

## Why pi-context-kit

- **A cleaner context window.** Above the threshold, old copies of files and old tool outputs become one-line notices. The newest tool outputs stay.
- **Summaries written ahead of time.** The session model writes the handoff note in the background, while it continues to work. When a ready note still fits at the threshold, compaction does not wait for a new summary.
- **Nothing is deleted.** The session keeps the original text. The model searches and reads it again with the `recall` tool.
- **Free where possible.** Replacing old reads, pruning and shaking do not call the model.
- **Cache-friendly.** Context edits happen only above the threshold, in one batch. The provider's prompt cache breaks once per maintenance step, not at each turn.
- **Zero setup.** Install, restart, work. By default, maintenance starts at 75% of the context window, which for most models is before Pi's own limit.
- **Visible.** The footer shows how full the context is and when cleanup starts. A notice tells you what was freed. Type `/context-kit` to change the main settings in a panel, without editing a file.

## What the model sees

Above the threshold, large old content becomes a one-line notice. The full text stays in the session. Example (the sizes and IDs are illustrative; the last notice appears only when shaking runs, see [`strategy`](#main-settings)):

```diff
- <first read of src/app.ts, about 5,000 tokens>
+ [Superseded by a newer read of this file]

- <output of npm test from one hour ago, about 12,000 tokens>
+ [Output pruned: about 12000 tokens. Call recall with entryId "a1b2c3d4" to read it.]

- <a large code block in an old reply, about 2,000 tokens>
+ [Elided block: about 2000 tokens. Call recall with entryId "e5f6a7b8" to read it.]
```

These notices never change your messages or the model's tool calls. The model's reasoning also stays, with one exception for Anthropic. Compaction still replaces older messages with a summary. See [What maintenance preserves](#what-maintenance-preserves).

## Pi alone, and Pi with pi-context-kit

| In a long session | Pi alone | With pi-context-kit |
| --- | --- | --- |
| The model reads the same file again | Both copies stay in the context. | The old copy is replaced, above the threshold. |
| Old tool outputs fill the context | They stay until Pi summarizes. | They are replaced with a short notice. No model request. |
| The context reaches the limit | Pi writes a summary. | A handoff note can be ready, because it was written in the background. |
| The model needs a removed detail | The summary is all that remains in the context. | The model calls `recall` to read the original text. |

The original session entries never change. Only the context that Pi sends to the model becomes smaller.

pi-context-kit is for long Pi sessions: many file reads, long command outputs, or many compactions. In a short session, the context rarely reaches the threshold. Then the context does not change at the end of a turn. A background handoff note can still start near the threshold, and `/compact` tries a handoff note first, with Pi's summary as the fallback.

## Why long Pi sessions need context management

An AI model can read only a limited amount of text at one time. This limit is the **context window**. Text is measured in **tokens**. Pi counts approximately 4 characters as one token.

In a long session, the conversation fills the context window. File reads and command outputs are usually the largest parts. When the window is almost full, Pi does a **compaction**: it replaces the old conversation with a summary. A summary can lose details, and it costs time and money.

<details>
<summary>Words used in this document</summary>

| Word | Meaning |
| --- | --- |
| Token | A small piece of text. The model counts its memory in tokens. |
| Context window | The maximum number of tokens that the model can read at one time. |
| Context | All the text that Pi sends to the model now: instructions, messages, and tool outputs. |
| Turn | One cycle: the model replies, uses its tools, and stops. |
| Tool output | The result of a tool, for example the content of a file or the output of a command. |
| Threshold | The number of tokens at which maintenance starts. |
| Compaction | Pi replaces the old conversation with a summary. The newest messages stay. |
| Handoff note | A summary that pi-context-kit writes with the same model as your session. |
| Pi's summary | The summary that Pi writes when no handoff note is available. |

</details>

## Quick start

You need Pi 1.0.3 or later and Node.js 22.19 or later.

1. Install the package with the command above.
2. Restart Pi.
3. Look at the footer. It shows `Context 0% · cleanup at 75%` when the extension is active.
4. Work as usual. Type `/context-kit` to change the settings.

## Update, try or remove

```sh
pi update npm:pi-context-kit    # update, then restart Pi
pi -e npm:pi-context-kit        # try for one session without installing
pi remove npm:pi-context-kit    # remove, then restart Pi
```

After an update, Pi shows what changed, from [CHANGELOG.md](CHANGELOG.md).

## Use it

You do not need to configure anything. pi-context-kit shows its state in Pi's footer:

| Footer | Meaning |
| --- | --- |
| `Context 62% · cleanup at 75%` | The context is 62% full. Cleanup starts at 75%. |
| `Context 70% · cleanup at 75% · writing summary` | A handoff note is being written in the background. `summary ready` means that it is ready. |
| `Context 25% · no automatic cleanup` | Pi's automatic compaction is off, so cleanup runs only when you type `/compact`. |
| `Context cleanup off` | You turned automatic cleanup off. |

After pi-context-kit shortens old outputs, Pi shows a notice, for example: `pi-context-kit freed 17% of the context (34k tokens). The agent can still look up what was removed.`

To change the settings, type `/context-kit` and press Enter. Select a line with the arrow keys and press Enter to change its value. The change is saved at once and applies from the next turn. Press Escape to close the panel.

| Panel line | Choices | Setting in the file |
| --- | --- | --- |
| Automatic cleanup | On, Off | `enabled` |
| Clean up when the context is | 50% to 90% full, At Pi's limit | `threshold` |
| Cleanup method | Summary notes (recommended), Trim first, Pi's summary | `strategy`: `"balanced"`, `"frugal"`, `"pi-summary"` |

The panel does not show the Cleanup method line when `advanced.methodOrder` is in the file, because that setting replaces the method.

Outside the interactive mode, `/context-kit` shows the current settings in one line.

## How it works during a session

```text
 Every turn ends
       |
       v
 Context near the threshold? --yes--> Start a handoff note in the background
       |
       v
 Context above the threshold? --no--> continue to work
       |
      yes
       v
 Replace old file reads, and prune old tool outputs
       |
       v
 Small enough now? --yes--> continue to work
       |
       no
       v
 Try each method of the strategy, for example: handoff, shake, soft
```

### 1. Old file reads are replaced

Sometimes the model reads the same file two times. The first copy is then old.
pi-context-kit replaces the old copy with this text: `[Superseded by a newer read of this file]`.

It does this only when the newer read covers all of the old read. If the newer read was cut short, the old copy stays.
It does this only when the context is above the threshold, in the same change as pruning, shaking or compaction. Each change to old text makes the provider read all later text again without its cache. With Anthropic, it also removes the model's earlier reasoning from the request. One change near the threshold costs less than one change at each turn.

### 2. A handoff note is prepared in advance

Before the context reaches the threshold, the session model writes a handoff note in the background. Your work does not stop.
The note starts one eighth of the threshold early, with a maximum of 32,000 tokens. With a threshold of 150,000 tokens, it starts at approximately 131,250 tokens.

The note uses the same sections as Pi's summary. It also lists the files that were read and changed.

### 3. Old tool outputs are pruned

Above the threshold, old tool outputs are replaced with a short notice, for example:
`[Output pruned: about 5000 tokens. Call recall with entryId "abc123" to read it.]`

The newest 40,000 tokens of tool outputs always stay. pi-context-kit keeps this change only if the context becomes small enough. "Small enough" means 80% of the threshold or less.

### 4. Other methods, in order

If pruning is not sufficient, pi-context-kit tries the methods of the [strategy](#main-settings), one after the other:

| Method | What it does | Uses the model? |
| --- | --- | --- |
| `handoff` | Replaces the old conversation with the handoff note. The newest messages stay. | Yes |
| `shake` | Replaces large old code blocks, XML blocks, and images with a short notice. Your messages are never shaken. | No |
| `soft` | Replaces the old conversation with Pi's summary. The newest messages stay. Stops here. | Yes |

Your work continues during these steps. pi-context-kit never stops a running task to compact.

### The `recall` tool

The `recall` tool reads original session text, not the shortened context sent to the model. It can:

- search earlier conversation text on the current branch, including removed and summarized messages;
- read an entry's text by ID, with pagination for large entries.

Other branches and sessions are excluded. System prompt entries are not searched.
Images remain in the original session entries, but `recall` returns only their MIME types, not image content.
The model must call `recall` to retrieve a missing detail. Retrieval is not automatic.

## What maintenance preserves

File-read replacement, pruning, and shaking do not rewrite the original session entries.
In the model's context, these steps preserve:

- Your messages, including your instructions and images.
- The model's tool calls and reasoning. Anthropic can still drop the reasoning after an edited message (see [Old file reads are replaced](#1-old-file-reads-are-replaced)).
- Tool-call and tool-result pairs. Each tool call keeps its result, but the result content can be shortened.

Compaction is different: it replaces older context with a summary, including older user messages. The original entries remain in session history.

## Settings

This section is for users who edit the settings file. The panel changes the three main settings; the file also has the advanced settings.

### The settings files

| File | Applies to |
| --- | --- |
| `~/.pi/agent/context-kit.json` | All your projects. `~` is your home folder. |
| `.pi/context-kit.json` in a project folder | Only this project, and only when you trust the project in Pi. Its values replace the values of the global file. |

You do not need to set all settings. A missing setting uses its default. pi-context-kit reads the files again at each turn, so you do not need to restart Pi. The panel writes to the project file when that file sets the setting, otherwise to the global file.

Add the `$schema` line to get completion and checks in editors such as VS Code:

```json
{
  "$schema": "https://unpkg.com/pi-context-kit/context-kit.schema.json",
  "threshold": "70%",
  "strategy": "frugal"
}
```

### Main settings

| Setting | Allowed values | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `true`, `false` | `true` | `false` stops all maintenance and handoff notes. The `recall` tool stays available. |
| `threshold` | A whole number of tokens, a percentage such as `"75%"`, or `"pi"` | `"75%"` | Where maintenance starts. |
| `strategy` | `"balanced"`, `"frugal"`, `"pi-summary"` | `"balanced"` | What pi-context-kit does when pruning is not sufficient. |

**`threshold`.** A percentage applies to each model's context window, so `"75%"` is 150,000 tokens with a 200,000-token window and 750,000 tokens with a 1,000,000-token window. Decimals are allowed, for example `"72.5%"`. A number such as `150000` is the same for all models. Do not put spaces, dots or commas in a number of tokens. `"pi"` waits for Pi's own limit. pi-context-kit can start before Pi's limit, never after: if your value is larger, Pi's limit is used. See [Pi settings that also apply](#pi-settings-that-also-apply).

**`strategy`.**

| Strategy (panel name) | Above the threshold, after pruning | Background requests |
| --- | --- | --- |
| `"balanced"` (Summary notes) | A handoff note. If the note fails, shake. Then Pi's summary. | Yes: the note is written before the threshold. |
| `"frugal"` (Trim first) | Shake, because it does not call the model. If that is not sufficient, a handoff note. Then Pi's summary. | No |
| `"pi-summary"` (Pi's summary) | Pi's summary. No handoff note, no shaking. | No |

### Advanced settings

Put these settings in an `advanced` block. Most users never need them.

```json
{
  "advanced": {
    "methodOrder": ["handoff", "shake", "soft"],
    "background": true,
    "supersedeReads": true,
    "progressRatio": 0.8,
    "prune": { "enabled": true, "protectTokens": 40000, "minSavings": 20000, "minTokens": 50 },
    "shake": { "protectTokens": 16000, "minSavings": 4000, "blockMinTokens": 400 }
  }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `methodOrder` | From `strategy` | Replaces the method order of the strategy. Allowed values: `"handoff"`, `"shake"`, `"soft"`. Methods after `"soft"` never run. Without `"handoff"` before `"soft"`, no handoff note is written, also on `/compact`. An empty list `[]` only replaces old reads and prunes. |
| `background` | From `strategy` | `true` writes the handoff note in the background, one eighth of the threshold early (maximum 32,000 tokens). `false` writes it at the threshold, and your work waits for it. |
| `supersedeReads` | `true` | Replaces the old copy of a file that the model read again. |
| `progressRatio` | `0.8` | Each method must bring the context to this fraction of the threshold, otherwise its result is not used and the next method runs. Above 0, up to 1. |
| `prune.enabled` | `true` | `false` never prunes tool outputs. |
| `prune.protectTokens` | `40000` | The newest tool outputs, up to this number of tokens, are never pruned. |
| `prune.minSavings` | `20000` | Pruning occurs only if it removes at least this number of tokens. |
| `prune.minTokens` | `50` | Tool outputs smaller than this are never pruned. |
| `shake.protectTokens` | `16000` | The newest context, up to this number of tokens, is never shaken. Your own messages are never shaken. |
| `shake.minSavings` | `4000` | Shaking occurs only if it removes at least this number of tokens. |
| `shake.blockMinTokens` | `400` | Code and XML blocks smaller than this are never shaken. |

### When a setting is incorrect

pi-context-kit checks each value. If a value is incorrect, Pi shows a warning and the setting uses its default. The other settings still apply. Example: with `"threshold": "150000"` (a text in quotes, not a number), Pi shows:

```text
pi-context-kit settings need attention: threshold must be a positive integer (tokens), a percentage such as "75%", or "pi" (default used). Type /context-kit to see them.
```

Pi also warns about a setting name with a spelling mistake, a file that is not valid JSON, and settings that have no effect, for example `advanced.background` without a handoff note in the method order.

### Upgrade from 0.3

You do not need to do anything. Version 0.4 reads its own file. At the first start, it copies the `contextKit` block of Pi's `settings.json` to `~/.pi/agent/context-kit.json` (and the block of a trusted project to `.pi/context-kit.json`), with the same behavior, and shows a notice once. The project file gets only the settings that the project block changed, because 0.3 used the global block for the others. It does not change Pi's `settings.json`; you can delete the `contextKit` block, which is no longer used. If `context-kit.json` already exists, nothing is copied. If you had no `contextKit` block, 0.4 starts maintenance at the new default of `"75%"`; to wait for Pi's limit as before, set `"threshold": "pi"`. The table shows how the values are converted.

| 0.3 (`contextKit` in `settings.json`) | 0.4 (`context-kit.json`) |
| --- | --- |
| `thresholdTokens: 150000` | `threshold: 150000` |
| `thresholdPercent: 75` | `threshold: "75%"` |
| Both `thresholdTokens` and `thresholdPercent` | `threshold` with the number of tokens |
| No threshold (Pi's limit) | `threshold: "pi"`. The default for new users is `"75%"`. |
| `methodOrder: ["shake", "handoff", "soft"]` | `strategy: "frugal"`, with `advanced.background: true` unless `asyncEnabled` was `false` |
| `methodOrder: ["soft"]` | `strategy: "pi-summary"` |
| Other `methodOrder` values | `advanced.methodOrder`, without `"remote"` and `"snapcompact"`, which 0.3 already skipped. A list with an unknown method becomes the default order, as in 0.3. |
| `asyncEnabled` | `advanced.background`, when it differs from the strategy |
| `supersedeReads`, `progressRatio`, `prune`, `shake` | The same names in `advanced` |

### Pi settings that also apply

These settings belong to Pi, not to pi-context-kit. Put them in the `compaction` block of Pi's `settings.json`.

| Pi setting | Default | Effect on pi-context-kit |
| --- | --- | --- |
| `compaction.enabled` | `true` | `false` stops Pi's automatic compaction. Then pi-context-kit changes the context only on `/compact`, because there is no threshold. |
| `compaction.reserveTokens` | `16384` | Pi's limit is the context window minus this number. pi-context-kit always starts at this limit or before. |
| `compaction.keepRecentTokens` | `20000` | After a handoff note, approximately this number of the newest tokens stays unchanged. |
| `compaction.modelOverrides` | none | Changes `reserveTokens` and `keepRecentTokens` for one model. |

pi-context-kit has no setting per model. To start earlier for one model only, make Pi's limit smaller for this model with `compaction.modelOverrides`, for example `{ "compaction": { "modelOverrides": { "provider/model-id": { "reserveTokens": 80000 } } } }`. With a 200,000-token window, this model then starts at 120,000 tokens at the latest. The model key must be the exact `provider/modelId`. To see the IDs, type `pi --list-models`.

## Recipes

| I want to... | `context-kit.json` |
| --- | --- |
| Start later, at Pi's own limit | `{ "threshold": "pi" }` |
| Start at the same number of tokens on all models | `{ "threshold": 150000 }` |
| Avoid model requests when possible | `{ "strategy": "frugal" }` |
| Never write a handoff note | `{ "advanced": { "methodOrder": ["shake", "soft"] } }` |
| Keep more recent tool outputs | `{ "advanced": { "prune": { "protectTokens": 80000 } } }` |
| Keep all old file copies | `{ "advanced": { "supersedeReads": false } }` |
| Turn pi-context-kit off, but keep `recall` | `{ "enabled": false }`, or `/context-kit` |

## Limits

- **Pi still has its own limit.** Pi compacts when the context reaches the context window minus `compaction.reserveTokens` (default 16,384). pi-context-kit can only start earlier, not later. You set Pi's limit with `compaction.reserveTokens` and `compaction.modelOverrides`.
- **A threshold is not a guarantee.** At the threshold, pi-context-kit tries to make the context smaller. If one tool output is very large, or the summary request fails, the methods can fail. Then Pi compacts at its own limit.
- **Token counts are estimates.** pi-context-kit uses Pi's estimates. The real count of the provider can be different.
- **If Pi's compaction is off** (`compaction.enabled: false`), pi-context-kit changes the context only when you run `/compact`. Then it writes a handoff note, as with compaction on. `threshold` is ignored, because pi-context-kit edits the context automatically only at a threshold.
- **Manual compaction and errors.** When you type `/compact`, when the context is too large for the model, or when Pi compacts before a turn, `shake` cannot run. pi-context-kit uses a ready handoff note, or Pi's summary.
- **The method order stops at `soft`.** The methods after `soft` do not run.
- **Subagents** read the same settings files. They show no warnings and no status, because they have no screen.

## Troubleshooting

**No `Context` in the footer**: type `pi list` and check that it shows `npm:pi-context-kit`. Then restart Pi. Pi shows the footer only in the interactive mode.

**`pi-context-kit settings need attention`**: a value in a settings file is not valid. pi-context-kit uses the default for that value. Type `/context-kit` to see the problem, then correct the file or select a new value in the panel.

**`pi-context-kit moved its settings to ...`**: an earlier version kept the settings in Pi's `settings.json`. pi-context-kit copied them to its own file once. You can remove the `contextKit` entry from `settings.json`.

**`pi-context-kit: handoff note failed`**: the summary request failed. pi-context-kit uses the next method or Pi's summary, so your session continues. Check the model and your provider limits.

**The panel cannot save a value**: Pi shows `pi-context-kit:` and the file error. Check that you can write the settings file, then select the value again.

## FAQ

**Does it slow down my work?**
Usually not. The handoff note is written in the background, and pruning and shaking do not use the model.
If no note is ready at the threshold, pi-context-kit can postpone the handoff until the note in progress is ready. It can also write a new note, which adds one model request.

**Does it cost more?**
A handoff note is one extra model request. It uses the same model, thinking level, and tool choice as your session. With Anthropic, this lets the provider reuse the cached conversation. Caching is not guaranteed.

**What happens if the handoff note fails?**
Pi shows a warning that starts with `pi-context-kit: handoff note failed`. Then pi-context-kit uses the next method, or Pi's summary. After a failed note at the threshold, pi-context-kit does not try a new note at the threshold again before the next compaction.

**Can I give a focus to a summary?**
Yes. Type `/compact` and the focus, for example `/compact keep the database migration details`. If enough space is available, pi-context-kit writes a new note with this focus. If not, Pi writes its summary.

**The model forgot a detail. What can I do?**
Ask the model to use the `recall` tool, for example: "Use recall to find the error message from the first test run."

## Development

```sh
npm ci
npm run check
```

The tests run offline with Pi's faux provider. They do not call a real model.
Development uses Pi `1.5.2`. The oldest supported version is Pi `1.0.3`. CI checks the locked dependencies on Node 22 and 24, and Pi `1.0.3` and latest Pi on Node 24.
Host-provided peer dependencies use `"*"`, as required by Pi's package guide. This is not a guarantee that every Pi version works.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks, pull requests and releases. Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues.

## License

MIT
