# pi-context-kit

[![npm version](https://img.shields.io/npm/v/pi-context-kit)](https://www.npmjs.com/package/pi-context-kit) [![CI](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml) [![Node.js](https://img.shields.io/node/v/pi-context-kit)](https://nodejs.org) [![License: MIT](https://img.shields.io/npm/l/pi-context-kit)](LICENSE)

**Long Pi sessions that stay sharp.**

Pi compaction and context management for the [Pi coding agent](https://github.com/earendil-works/pi). pi-context-kit clears stale file reads and old tool outputs out of the context window, writes the handoff summary in the background before Pi needs it, and keeps the original text of the current branch one `recall` search away.

```sh
pi install npm:pi-context-kit
```

Restart Pi. That is all: the defaults work without configuration. Requirements: Pi 1.0.3 or later, Node.js 22.19 or later.

## Why pi-context-kit

- **A cleaner context window.** Above the threshold, old copies of files and old tool outputs become one-line notices. The newest tool outputs stay.
- **Summaries written ahead of time.** The session model writes the handoff note in the background, while it continues to work. When a ready note still fits at the threshold, compaction does not wait for a new summary.
- **Nothing is deleted.** The session keeps the original text. The model searches and reads it again with the `recall` tool.
- **Free where possible.** Replacing old reads, pruning and shaking do not call the model.
- **Cache-friendly.** Context edits happen only above the threshold, in one batch. The provider's prompt cache breaks once per maintenance step, not at each turn.
- **Zero setup.** Install, restart, work. Tune it later if you want.

## What the model sees

Above the threshold, large old content becomes a one-line notice. The full text stays in the session. Example (the sizes and IDs are illustrative; the last notice appears only when shaking runs, see [`methodOrder`](#methodorder)):

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

## Install

1. Open a terminal.
2. Type this command and press Enter:

   ```sh
   pi install npm:pi-context-kit
   ```

3. Restart Pi.

To check the installation, type `pi list`. The list must show `npm:pi-context-kit`.

To update, type `pi update npm:pi-context-kit` and restart Pi.

To remove it, type `pi remove npm:pi-context-kit` and restart Pi.

## Recommended setup

The default setup works without changes. By default, maintenance starts at the same time as Pi's compaction.
For large context windows, start maintenance earlier. This example starts at 150,000 tokens:

1. Open the file `~/.pi/agent/settings.json` in a text editor. `~` is your home folder.
2. Add the `contextKit` block inside the outer `{ }`. Put a comma between this block and the other settings.

   ```json
   {
     "contextKit": {
       "thresholdTokens": 150000
     }
   }
   ```

3. Save the file.
4. In Pi, type `/reload`, or restart Pi.

If a value is incorrect, Pi shows a warning that starts with `pi-context-kit: invalid settings`. The incorrect value is ignored and its default is used.

To use a setting only in one project, put the same block in the file `.pi/settings.json` in that project folder. Project settings replace global settings.

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
 Try each method in "methodOrder": handoff, shake, soft
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

If pruning is not sufficient, pi-context-kit tries the methods in `methodOrder`, one after the other:

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

This section lists every setting. Each setting has its allowed values, its default, and an example.

### Where to put the settings

Put all settings in a `contextKit` block, in one of these files:

| File | Applies to |
| --- | --- |
| `~/.pi/agent/settings.json` | All your projects. `~` is your home folder. |
| `.pi/settings.json` in a project folder | Only this project. These values replace the values of the global file. |

You do not need to set all settings. A missing setting uses its default.
After a change, type `/reload` in Pi, or restart Pi.

### All settings with their defaults

This block sets every setting to its default. It has the same effect as no `contextKit` block.
Copy only the lines that you want to change.

```json
{
  "contextKit": {
    "enabled": true,
    "thresholdTokens": -1,
    "thresholdPercent": -1,
    "methodOrder": ["handoff", "shake", "soft"],
    "asyncEnabled": true,
    "supersedeReads": true,
    "progressRatio": 0.8,
    "prune": {
      "enabled": true,
      "protectTokens": 40000,
      "minSavings": 20000,
      "minTokens": 50
    },
    "shake": {
      "protectTokens": 16000,
      "minSavings": 4000,
      "blockMinTokens": 400
    }
  }
}
```

### Summary table

| Setting | Allowed values | Default | Short description |
| --- | --- | --- | --- |
| [`enabled`](#enabled) | `true`, `false` | `true` | Turns all maintenance on or off. |
| [`thresholdTokens`](#thresholdtokens) | `-1`, or a whole number above 0 | `-1` | Starts maintenance at this number of tokens. |
| [`thresholdPercent`](#thresholdpercent) | `-1`, or a number above 0, up to 100 | `-1` | Starts maintenance at this percentage of the context window. |
| [`methodOrder`](#methodorder) | A list of `"handoff"`, `"shake"`, `"soft"` | `["handoff", "shake", "soft"]` | The methods to try, and their order. |
| [`asyncEnabled`](#asyncenabled) | `true`, `false` | `true` | Prepares the handoff note in the background. |
| [`supersedeReads`](#supersedereads) | `true`, `false` | `true` | Replaces old copies of a file that was read again. |
| [`progressRatio`](#progressratio) | A number above 0, up to 1 | `0.8` | How small the context must become. |
| [`prune.enabled`](#pruneenabled) | `true`, `false` | `true` | Turns pruning of old tool outputs on or off. |
| [`prune.protectTokens`](#pruneprotecttokens) | A whole number, 0 or more | `40000` | The newest tool outputs that are never pruned. |
| [`prune.minSavings`](#pruneminsavings) | A whole number, 0 or more | `20000` | The minimum gain for pruning. |
| [`prune.minTokens`](#prunemintokens) | A whole number, 0 or more | `50` | Tool outputs smaller than this are never pruned. |
| [`shake.protectTokens`](#shakeprotecttokens) | A whole number, 0 or more | `16000` | The newest context that is never shaken. |
| [`shake.minSavings`](#shakeminsavings) | A whole number, 0 or more | `4000` | The minimum gain for shaking. |
| [`shake.blockMinTokens`](#shakeblockmintokens) | A whole number, 0 or more | `400` | Blocks smaller than this are never shaken. |

"Whole number" means a number without decimals, for example `150000`. Do not put spaces, dots, or commas in numbers: write `150000`, not `150,000`.

### When a setting is incorrect

pi-context-kit checks each value. If a value is incorrect, Pi shows a warning, and the setting uses its default. The other settings still apply.

Example: with `"thresholdTokens": "150000"` (a text in quotes, not a number), Pi shows:

```text
pi-context-kit: invalid settings, defaults used (contextKit.thresholdTokens must be -1 or a positive integer).
```

A setting name with a spelling mistake also shows a warning, for example `contextKit.treshold is not a setting`.

### `enabled`

Turns all maintenance on or off.

- `true` (default): pi-context-kit works as described in this document.
- `false`: pi-context-kit does nothing. Pi uses only its own summary. The `recall` tool stays available.

```json
{ "contextKit": { "enabled": false } }
```

### `thresholdTokens`

Maintenance starts when the context is larger than this number of tokens.

- `-1` (default): use `thresholdPercent`. If `thresholdPercent` is also `-1`, use Pi's limit.
- A whole number above 0: start at this number of tokens.

This setting has priority over `thresholdPercent`.
pi-context-kit can start before Pi's limit, never after. If your value is larger than Pi's limit, Pi's limit is used. See [Pi settings that also apply](#pi-settings-that-also-apply).

Example: start at 150,000 tokens.

```json
{ "contextKit": { "thresholdTokens": 150000 } }
```

| Model context window | Pi's limit (default reserve) | Threshold used |
| --- | --- | --- |
| 1,000,000 | 983,616 | 150,000 |
| 200,000 | 183,616 | 150,000 |
| 128,000 | 111,616 | 111,616 (Pi's limit is smaller) |

### `thresholdPercent`

Maintenance starts when the context is larger than this percentage of the model's context window.

- `-1` (default): no percentage. If `thresholdTokens` is also `-1`, use Pi's limit.
- A number above 0, up to 100: start at this percentage. Decimals are allowed, for example `72.5`. Values above 99 are used as 99.

pi-context-kit ignores this setting when `thresholdTokens` is not `-1`.

Example: start at 75% of the context window.

```json
{ "contextKit": { "thresholdPercent": 75 } }
```

| Model context window | Threshold used |
| --- | --- |
| 1,000,000 | 750,000 |
| 200,000 | 150,000 |
| 128,000 | 96,000 |

Use `thresholdPercent` if you use models with different context windows and you want the same proportion for all of them. Use `thresholdTokens` if you want the same number for all of them.

### `methodOrder`

The methods that pi-context-kit tries when pruning is not sufficient, in this order.

Allowed values in the list:

| Value | What it does | Calls the model? |
| --- | --- | --- |
| `"handoff"` | Replaces the old conversation with a handoff note. The newest messages stay. | Yes, the session model |
| `"shake"` | Replaces large old code blocks, XML blocks, and images with a short notice. | No |
| `"soft"` | Replaces the old conversation with Pi's summary. The newest messages stay. Stops the list. | Yes, the session model |
| `"remote"`, `"snapcompact"` | Accepted for oh-my-pi compatibility, but skipped. Pi does not have these methods. | No |

Rules:

- The order is important. pi-context-kit tries the first method, then the next one.
- `"soft"` ends the list. Methods after `"soft"` never run.
- If `"handoff"` is not in the list before `"soft"`, pi-context-kit writes no handoff note at all. This also applies to `/compact` and to background notes. Pi writes its own summary.
- If `"shake"` is not in the list before `"soft"`, nothing is shaken.
- A value that appears two times is used one time.
- An empty list `[]` is allowed. Then pi-context-kit only replaces old file reads and prunes old tool outputs.

Common choices:

| `methodOrder` | What happens above the threshold |
| --- | --- |
| `["handoff", "shake", "soft"]` (default) | Prune. Then a handoff note. If the note fails, shake. Then Pi's summary. |
| `["shake", "handoff", "soft"]` | Prune and shake together. If that is not sufficient, a handoff note. Then Pi's summary. |
| `["handoff", "soft"]` | Prune. Then a handoff note. Never shake. |
| `["shake", "soft"]` | Prune and shake. Then Pi's summary. No handoff note. |
| `["soft"]` | Prune. Then Pi's summary. |
| `[]` | Prune only. Pi writes its summary when the context reaches Pi's limit. |

Example: try shaking first, because it does not call the model.

```json
{ "contextKit": { "methodOrder": ["shake", "handoff", "soft"] } }
```

### `asyncEnabled`

Prepares the handoff note in the background, before the threshold.

- `true` (default): the note starts one eighth of the threshold early, with a maximum of 32,000 tokens. If the note is ready at the threshold, compaction is fast.
- `false`: no background note. At the threshold, pi-context-kit writes a new note. Your work waits for this note.

This setting has an effect only if `"handoff"` is in `methodOrder` before `"soft"`.

Example: no background requests.

```json
{ "contextKit": { "asyncEnabled": false } }
```

### `supersedeReads`

Replaces the old copy of a file when the model reads the same file again.

- `true` (default): the old copy becomes `[Superseded by a newer read of this file]`.
- `false`: all copies stay.

This works only above the threshold, together with pruning and shaking.

```json
{ "contextKit": { "supersedeReads": false } }
```

### `progressRatio`

How small the context must become after a method, as a fraction of the threshold.
If a method cannot make the context this small, pi-context-kit does not use its result and tries the next method.

- `0.8` (default): the context must become 80% of the threshold or less. With a threshold of 150,000 tokens, this is 120,000 tokens.
- A smaller value, for example `0.6`, gives more free space after maintenance. But each method must remove more, so it fails more often.
- A larger value, for example `0.95`, makes each method succeed more easily. But maintenance can start again soon after.

The value must be above 0 and not more than 1.

```json
{ "contextKit": { "progressRatio": 0.7 } }
```

### `prune.enabled`

Turns pruning on or off. Pruning replaces old tool outputs with a notice, for example `[Output pruned: about 5000 tokens. Call recall with entryId "abc123" to read it.]`.

- `true` (default).
- `false`: tool outputs are never pruned.

```json
{ "contextKit": { "prune": { "enabled": false } } }
```

### `prune.protectTokens`

The newest tool outputs, up to this number of tokens, are never pruned. Thus the model keeps its most recent results.

- `40000` (default).
- A larger value keeps more recent outputs, but removes less.

```json
{ "contextKit": { "prune": { "protectTokens": 60000 } } }
```

### `prune.minSavings`

Pruning occurs only if it removes at least this number of tokens. This prevents small changes with little gain.

- `20000` (default).

```json
{ "contextKit": { "prune": { "minSavings": 10000 } } }
```

### `prune.minTokens`

Tool outputs smaller than this number of tokens are never pruned. A notice would not be much smaller than these outputs.

- `50` (default).

```json
{ "contextKit": { "prune": { "minTokens": 200 } } }
```

### `shake.protectTokens`

The newest part of the context, up to this number of tokens, is never shaken. Your own messages are never shaken, also when they are old.

- `16000` (default).

```json
{ "contextKit": { "shake": { "protectTokens": 32000 } } }
```

### `shake.minSavings`

Shaking occurs only if it removes at least this number of tokens.

- `4000` (default).

```json
{ "contextKit": { "shake": { "minSavings": 8000 } } }
```

### `shake.blockMinTokens`

Code blocks and XML blocks smaller than this number of tokens are never shaken.

- `400` (default).

```json
{ "contextKit": { "shake": { "blockMinTokens": 1000 } } }
```

There is no `shake.enabled` setting. To stop shaking, remove `"shake"` from `methodOrder`.

### Pi settings that also apply

These settings belong to Pi, not to pi-context-kit. Put them in the `compaction` block, next to the `contextKit` block.

| Pi setting | Default | Effect on pi-context-kit |
| --- | --- | --- |
| `compaction.enabled` | `true` | `false` stops Pi's automatic compaction. Then pi-context-kit changes the context only on `/compact`, because there is no threshold. |
| `compaction.reserveTokens` | `16384` | Pi's limit is the context window minus this number. pi-context-kit always starts at this limit or before. |
| `compaction.keepRecentTokens` | `20000` | After a handoff note, approximately this number of the newest tokens stays unchanged. |
| `compaction.modelOverrides` | none | Changes `reserveTokens` and `keepRecentTokens` for one model. |

pi-context-kit has no setting per model. To start earlier for one model only, make Pi's limit smaller for this model with `compaction.modelOverrides`. pi-context-kit always starts at Pi's limit or before, so it also starts earlier for this model.

Example: all models start at 150,000 tokens. One model with a 200,000-token window starts at 200,000 − 80,000 = 120,000 tokens. Replace `provider/model-id` with the ID of your model.

```json
{
  "compaction": {
    "modelOverrides": {
      "provider/model-id": { "reserveTokens": 80000 }
    }
  },
  "contextKit": {
    "thresholdTokens": 150000
  }
}
```

Pi also uses `reserveTokens` to limit the length of its own summary. See the Pi documentation about compaction.

The model key must be the exact `provider/modelId`. To see the IDs, type `pi --list-models`.

## Recipes

| I want to... | Settings |
| --- | --- |
| Start earlier with large models | `{ "contextKit": { "thresholdTokens": 150000 } }` |
| Use the same proportion for all models | `{ "contextKit": { "thresholdPercent": 75 } }` |
| Never write a handoff note | `{ "contextKit": { "methodOrder": ["shake", "soft"] } }` |
| Try the free method first, then a handoff note | `{ "contextKit": { "methodOrder": ["shake", "handoff", "soft"] } }` |
| Keep more recent tool outputs | `{ "contextKit": { "prune": { "protectTokens": 80000 } } }` |
| Keep all old file copies | `{ "contextKit": { "supersedeReads": false } }` |
| Use other settings in one project | Put the `contextKit` block in `.pi/settings.json` in that project. |
| Turn pi-context-kit off, but keep `recall` | `{ "contextKit": { "enabled": false } }` |

To combine recipes, put all the settings in one `contextKit` block:

```json
{
  "contextKit": {
    "thresholdTokens": 150000,
    "methodOrder": ["shake", "handoff", "soft"],
    "prune": { "protectTokens": 80000 }
  }
}
```

## Limits

- **Pi still has its own limit.** Pi compacts when the context reaches the context window minus `compaction.reserveTokens` (default 16,384). pi-context-kit can only start earlier, not later. You set Pi's limit with `compaction.reserveTokens` and `compaction.modelOverrides`.
- **A threshold is not a guarantee.** At the threshold, pi-context-kit tries to make the context smaller. If one tool output is very large, or the summary request fails, the methods can fail. Then Pi compacts at its own limit.
- **Token counts are estimates.** pi-context-kit uses Pi's estimates. The real count of the provider can be different.
- **If Pi's compaction is off** (`compaction.enabled: false`), pi-context-kit changes the context only when you run `/compact`. Then it writes a handoff note, as with compaction on. `thresholdTokens` and `thresholdPercent` are ignored, because pi-context-kit edits the context automatically only at a threshold.
- **Manual compaction and errors.** When you type `/compact`, when the context is too large for the model, or when Pi compacts before a turn, `shake` cannot run. pi-context-kit uses a ready handoff note, or Pi's summary.
- **`methodOrder` stops at `soft`.** The methods after `soft` do not run.
- **Subagents** use their own settings. They show no warnings, because they have no screen.

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
