# pi-context-kit：让 Pi 长会话始终保持清晰

[English](README.md) | 简体中文

[![CI](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HugoLopes45/pi-context-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-context-kit)](https://www.npmjs.com/package/pi-context-kit)
[![Pi package](https://img.shields.io/badge/pi.dev-package-blue)](https://pi.dev/packages/pi-context-kit)
[![Node.js](https://img.shields.io/node/v/pi-context-kit)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/pi-context-kit)](LICENSE)

为 [Pi 编程智能体](https://github.com/earendil-works/pi)提供压缩（compaction）和上下文管理。pi-context-kit 会把过时的文件读取和旧的工具输出从上下文窗口中清理出去，在 Pi 需要之前于后台写好交接摘要，并让当前分支的原始文本只需一次 `recall` 搜索即可找回。

```sh
pi install npm:pi-context-kit
```

重启 Pi。默认设置无需任何配置即可使用。

## 为什么选择 pi-context-kit

- **更干净的上下文窗口。** 超过阈值后，文件的旧副本和旧的工具输出会变成一行提示。最新的工具输出保持不变。
- **提前写好的摘要。** 会话模型在后台写交接笔记，同时继续工作。到达阈值时，如果已准备好的笔记仍能放进上下文，压缩就不必等待新的摘要。
- **不删除任何内容。** 会话保留原始文本。模型可以用 `recall` 工具搜索并重新读取它。
- **尽量免费。** 替换旧的读取、修剪（prune）和精简（shake）都不调用模型。
- **对缓存友好。** 上下文只在超过阈值后才被修改，并且一次完成。提供商的提示词缓存在每个维护步骤中只失效一次，而不是每个轮次都失效。
- **零配置。** 安装、重启、开始工作。默认情况下，维护从上下文窗口的 75% 开始，对大多数模型来说，这早于 Pi 自身的限制。
- **状态可见。** 底部状态栏显示上下文的占用程度以及清理何时开始。一条提示会告诉你释放了多少空间。输入 `/context-kit` 即可在面板中修改主要设置，无需编辑文件。

## 模型看到的内容

超过阈值后，大段的旧内容会变成一行提示。完整文本仍保留在会话中。示例（大小和 ID 仅为示意；最后一条提示只在精简运行时出现，参见 [`strategy`](#主要设置)）：

```diff
- <first read of src/app.ts, about 5,000 tokens>
+ [Superseded by a newer read of this file]

- <output of npm test from one hour ago, about 12,000 tokens>
+ [Output pruned: about 12000 tokens. Call recall with entryId "a1b2c3d4" to read it.]

- <a large code block in an old reply, about 2,000 tokens>
+ [Elided block: about 2000 tokens. Call recall with entryId "e5f6a7b8" to read it.]
```

这些提示永远不会改变你的消息或模型的工具调用。模型的推理内容也会保留，Anthropic 有一个例外。压缩仍然会用摘要替换较早的消息。参见[维护会保留什么](#维护会保留什么)。

## 单独使用 Pi，与搭配 pi-context-kit 使用 Pi

| 在长会话中 | 单独使用 Pi | 搭配 pi-context-kit |
| --- | --- | --- |
| 模型再次读取同一个文件 | 两个副本都留在上下文中。 | 超过阈值后，旧副本被替换。 |
| 旧的工具输出占满上下文 | 它们一直保留，直到 Pi 生成摘要。 | 它们被替换为一条简短提示。不需要模型请求。 |
| 上下文达到限制 | Pi 写一份摘要。 | 交接笔记可能已经准备好，因为它是在后台写的。 |
| 模型需要一个已移除的细节 | 上下文中只剩下摘要。 | 模型调用 `recall` 读取原始文本。 |

原始的会话条目永远不会改变。只有 Pi 发送给模型的上下文会变小。

pi-context-kit 适用于 Pi 长会话：大量文件读取、很长的命令输出，或多次压缩。在短会话中，上下文很少达到阈值，因此在轮次结束时上下文不会改变。接近阈值时，后台交接笔记仍可能开始编写；`/compact` 会先尝试交接笔记，失败时回退到 Pi 的摘要。

## 为什么 Pi 长会话需要上下文管理

AI 模型一次只能读取有限的文本。这个限制就是**上下文窗口**。文本以 **token** 计量。Pi 大约把 4 个字符算作一个 token。

在长会话中，对话会逐渐占满上下文窗口。文件读取和命令输出通常是最大的部分。当窗口快满时，Pi 会进行**压缩**：用一份摘要替换旧的对话。摘要可能丢失细节，而且需要时间和费用。

<details>
<summary>本文档中使用的术语</summary>

| 术语 | 含义 |
| --- | --- |
| Token | 一小段文本。模型以 token 计算它的记忆容量。 |
| 上下文窗口 | 模型一次能读取的最大 token 数。 |
| 上下文 | Pi 当前发送给模型的全部文本：指令、消息和工具输出。 |
| 轮次 | 一个循环：模型回复、使用工具，然后停止。 |
| 工具输出 | 工具的结果，例如文件内容或命令输出。 |
| 阈值 | 维护开始时的 token 数。 |
| 压缩 | Pi 用一份摘要替换旧的对话。最新的消息保留。 |
| 交接笔记 | pi-context-kit 使用与你的会话相同的模型写的摘要。 |
| Pi 的摘要 | 没有可用的交接笔记时，Pi 写的摘要。 |

</details>

## 快速开始

你需要 Pi 1.0.3 或更高版本，以及 Node.js 22.19 或更高版本。

1. 用上面的命令安装本包。
2. 重启 Pi。
3. 查看底部状态栏。扩展生效时，它显示 `Context 0% · cleanup at 75%`。
4. 照常工作。输入 `/context-kit` 修改设置。

## 更新、试用或移除

```sh
pi update npm:pi-context-kit    # 更新，然后重启 Pi
pi -e npm:pi-context-kit        # 不安装，只试用一个会话
pi remove npm:pi-context-kit    # 移除，然后重启 Pi
```

更新后，Pi 会根据 [CHANGELOG.md](CHANGELOG.md)（英文）显示变更内容。

## 使用方法

你不需要做任何配置。pi-context-kit 在 Pi 的底部状态栏中显示它的状态：

| 底部状态栏 | 含义 |
| --- | --- |
| `Context 62% · cleanup at 75%` | 上下文已占用 62%。清理从 75% 开始。 |
| `Context 70% · cleanup at 75% · writing summary` | 正在后台编写交接笔记。`summary ready` 表示笔记已准备好。 |
| `Context 25% · no automatic cleanup` | Pi 的自动压缩已关闭，因此只有在你输入 `/compact` 时才会清理。 |
| `Context cleanup off` | 你关闭了自动清理。 |

pi-context-kit 缩短旧输出后，Pi 会显示一条提示，例如：`pi-context-kit freed 17% of the context (34k tokens). The agent can still look up what was removed.`

要修改设置，输入 `/context-kit` 并按 Enter。用方向键选择一行，按 Enter 修改它的值。修改会立即保存，并从下一个轮次开始生效。按 Escape 关闭面板。

面板使用英文界面：

| 面板行 | 选项 | 文件中的设置 |
| --- | --- | --- |
| Automatic cleanup（自动清理） | On、Off | `enabled` |
| Clean up when the context is（何时清理） | 50% full 到 90% full、At Pi's limit | `threshold` |
| Cleanup method（清理方式） | Summary notes (recommended)、Trim first、Pi's summary | `strategy`：`"balanced"`、`"frugal"`、`"pi-summary"` |

当文件中有 `advanced.methodOrder` 时，面板不显示 Cleanup method 这一行，因为该设置会取代清理方式。

在非交互模式下，`/context-kit` 用一行文字显示当前设置。

## 会话中的工作方式

```text
 每个轮次结束
       |
       v
 上下文接近阈值？ --是--> 在后台开始编写交接笔记
       |
       v
 上下文超过阈值？ --否--> 继续工作
       |
       是
       v
 替换旧的文件读取，并修剪旧的工具输出
       |
       v
 现在足够小了？ --是--> 继续工作
       |
       否
       v
 依次尝试策略中的每个方法，例如：handoff、shake、soft
```

### 1. 旧的文件读取会被替换

有时模型会把同一个文件读取两次，这时第一个副本就过时了。
pi-context-kit 会把旧副本替换为这段文本：`[Superseded by a newer read of this file]`。

只有当新的读取完全覆盖旧的读取时，才会这样做。如果新的读取被截断，旧副本会保留。
只有当上下文超过阈值时才会这样做，并且与修剪、精简或压缩在同一次修改中完成。每次修改旧文本，都会让提供商在没有缓存的情况下重新读取之后的全部文本。对于 Anthropic，它还会从请求中移除模型之前的推理内容。在接近阈值时修改一次，比每个轮次都修改的成本更低。

### 2. 提前准备交接笔记

在上下文达到阈值之前，会话模型会在后台写交接笔记。你的工作不会中断。
笔记提前阈值的八分之一开始编写，最多提前 32,000 个 token。阈值为 150,000 个 token 时，它大约在 131,250 个 token 时开始。

笔记使用与 Pi 的摘要相同的章节。它还会列出读取过和修改过的文件。

### 3. 修剪旧的工具输出

超过阈值后，旧的工具输出会被替换为一条简短提示，例如：
`[Output pruned: about 5000 tokens. Call recall with entryId "abc123" to read it.]`

最新的 40,000 个 token 的工具输出始终保留。只有当上下文变得足够小时，pi-context-kit 才会保留这次修改。“足够小”指阈值的 80% 或更少。

### 4. 依次使用其他方法

如果修剪不够，pi-context-kit 会依次尝试[策略](#主要设置)中的方法：

| 方法 | 作用 | 是否使用模型 |
| --- | --- | --- |
| `handoff` | 用交接笔记替换旧的对话。最新的消息保留。 | 是 |
| `shake` | 把较大的旧代码块、XML 块和图片替换为一条简短提示。你的消息永远不会被精简。 | 否 |
| `soft` | 用 Pi 的摘要替换旧的对话。最新的消息保留。到此为止。 | 是 |

在这些步骤中，你的工作会继续进行。pi-context-kit 永远不会为了压缩而中断正在运行的任务。

### `recall` 工具

`recall` 工具读取原始会话文本，而不是发送给模型的缩短后的上下文。它可以：

- 搜索当前分支上较早的对话文本，包括已移除和已被摘要的消息；
- 按 ID 读取一个条目的文本，较大的条目支持分页。

其他分支和会话不包括在内。系统提示词条目不会被搜索。
图片保留在原始会话条目中，但 `recall` 只返回它们的 MIME 类型，不返回图片内容。
模型必须调用 `recall` 才能找回缺失的细节。找回不会自动进行。

## 维护会保留什么

文件读取替换、修剪和精简不会改写原始会话条目。
在模型的上下文中，这些步骤会保留：

- 你的消息，包括你的指令和图片。
- 模型的工具调用和推理内容。在被修改的消息之后，Anthropic 仍可能丢弃推理内容（参见[旧的文件读取会被替换](#1-旧的文件读取会被替换)）。
- 工具调用与工具结果的配对。每个工具调用都保留它的结果，但结果内容可能被缩短。

压缩则不同：它会用摘要替换较早的上下文，包括较早的用户消息。原始条目仍保留在会话历史中。

## 设置

本节面向需要编辑设置文件的用户。面板可以修改三个主要设置；文件中还包含高级设置。

### 设置文件

| 文件 | 适用范围 |
| --- | --- |
| `~/.pi/agent/context-kit.json` | 你的所有项目。`~` 是你的主目录。 |
| 项目文件夹中的 `.pi/context-kit.json` | 仅限该项目，并且只有在你于 Pi 中信任该项目时才生效。它的值会取代全局文件中的值。 |

你不需要设置所有选项。未设置的选项使用默认值。pi-context-kit 在每个轮次都会重新读取这些文件，所以你不需要重启 Pi。如果项目文件设置了某个选项，面板会写入项目文件，否则写入全局文件。

添加 `$schema` 这一行，即可在 VS Code 等编辑器中获得补全和检查：

```json
{
  "$schema": "https://unpkg.com/pi-context-kit/context-kit.schema.json",
  "threshold": "70%",
  "strategy": "frugal"
}
```

### 主要设置

| 设置 | 允许的值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `enabled` | `true`、`false` | `true` | `false` 停止所有维护和交接笔记。`recall` 工具仍然可用。 |
| `threshold` | token 数（整数）、百分比（例如 `"75%"`）或 `"pi"` | `"75%"` | 维护开始的位置。 |
| `strategy` | `"balanced"`、`"frugal"`、`"pi-summary"` | `"balanced"` | 修剪不够时，pi-context-kit 采取的做法。 |

**`threshold`。** 百分比按每个模型的上下文窗口计算，因此对于 200,000 token 的窗口，`"75%"` 是 150,000 个 token；对于 1,000,000 token 的窗口，则是 750,000 个 token。允许使用小数，例如 `"72.5%"`。`150000` 这样的数字对所有模型都相同。token 数中不要使用空格、点或逗号。`"pi"` 表示等到 Pi 自身的限制。pi-context-kit 只能在 Pi 的限制之前开始，不能在之后：如果你设置的值更大，则使用 Pi 的限制。参见[同样生效的 Pi 设置](#同样生效的-pi-设置)。

**`strategy`。**

| 策略（面板名称） | 超过阈值并修剪之后 | 后台请求 |
| --- | --- | --- |
| `"balanced"`（Summary notes） | 交接笔记。如果笔记失败，则精简。然后是 Pi 的摘要。 | 是：笔记在达到阈值之前写好。 |
| `"frugal"`（Trim first） | 先精简，因为它不调用模型。如果不够，再写交接笔记。然后是 Pi 的摘要。 | 否 |
| `"pi-summary"`（Pi's summary） | Pi 的摘要。不写交接笔记，也不精简。 | 否 |

### 高级设置

把这些设置放在 `advanced` 块中。大多数用户永远不需要它们。

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

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `methodOrder` | 由 `strategy` 决定 | 取代策略的方法顺序。允许的值：`"handoff"`、`"shake"`、`"soft"`。`"soft"` 之后的方法永远不会运行。如果 `"soft"` 之前没有 `"handoff"`，就不会写交接笔记，`/compact` 时也一样。空列表 `[]` 只替换旧的读取并进行修剪。 |
| `background` | 由 `strategy` 决定 | `true` 在后台写交接笔记，提前阈值的八分之一开始（最多 32,000 个 token）。`false` 在达到阈值时才写，你的工作需要等待它完成。 |
| `supersedeReads` | `true` | 替换模型再次读取的文件的旧副本。 |
| `progressRatio` | `0.8` | 每个方法都必须把上下文降到阈值的这个比例，否则不使用它的结果，并运行下一个方法。大于 0，最大为 1。 |
| `prune.enabled` | `true` | `false` 表示从不修剪工具输出。 |
| `prune.protectTokens` | `40000` | 最新的工具输出，在这个 token 数以内，永远不会被修剪。 |
| `prune.minSavings` | `20000` | 只有当修剪至少移除这么多 token 时才会进行。 |
| `prune.minTokens` | `50` | 小于这个大小的工具输出永远不会被修剪。 |
| `shake.protectTokens` | `16000` | 最新的上下文，在这个 token 数以内，永远不会被精简。你自己的消息永远不会被精简。 |
| `shake.minSavings` | `4000` | 只有当精简至少移除这么多 token 时才会进行。 |
| `shake.blockMinTokens` | `400` | 小于这个大小的代码块和 XML 块永远不会被精简。 |

### 设置有误时

pi-context-kit 会检查每个值。如果某个值有误，Pi 会显示警告，并且该设置使用默认值。其他设置仍然生效。例如，使用 `"threshold": "150000"`（带引号的文本，而不是数字）时，Pi 显示：

```text
pi-context-kit settings need attention: threshold must be a positive integer (tokens), a percentage such as "75%", or "pi" (default used). Type /context-kit to see them.
```

对于拼写错误的设置名称、不是有效 JSON 的文件，以及不起作用的设置，Pi 也会发出警告，例如方法顺序中没有交接笔记时设置了 `advanced.background`。

### 从 0.3 升级

你不需要做任何事。0.4 版本读取它自己的文件。首次启动时，它会把 Pi 的 `settings.json` 中的 `contextKit` 块复制到 `~/.pi/agent/context-kit.json`（受信任项目中的块则复制到 `.pi/context-kit.json`），行为保持不变，并显示一次提示。项目文件只获得项目块修改过的设置，因为 0.3 的其他设置使用的是全局块。它不会修改 Pi 的 `settings.json`；你可以删除不再使用的 `contextKit` 块。如果 `context-kit.json` 已经存在，则不会复制任何内容。如果你之前没有 `contextKit` 块，0.4 会从新的默认值 `"75%"` 开始维护；如果想像以前一样等到 Pi 的限制，请设置 `"threshold": "pi"`。下表说明了这些值如何转换。

| 0.3（`settings.json` 中的 `contextKit`） | 0.4（`context-kit.json`） |
| --- | --- |
| `thresholdTokens: 150000` | `threshold: 150000` |
| `thresholdPercent: 75` | `threshold: "75%"` |
| 同时设置了 `thresholdTokens` 和 `thresholdPercent` | 使用 token 数的 `threshold` |
| 没有阈值（Pi 的限制） | `threshold: "pi"`。新用户的默认值是 `"75%"`。 |
| `methodOrder: ["shake", "handoff", "soft"]` | `strategy: "frugal"`，并且除非 `asyncEnabled` 为 `false`，否则带有 `advanced.background: true` |
| `methodOrder: ["soft"]` | `strategy: "pi-summary"` |
| 其他 `methodOrder` 值 | `advanced.methodOrder`，去掉 0.3 已经跳过的 `"remote"` 和 `"snapcompact"`。包含未知方法的列表会变为默认顺序，与 0.3 相同。 |
| `asyncEnabled` | `advanced.background`（仅当它与该策略的默认值不同时） |
| `supersedeReads`、`progressRatio`、`prune`、`shake` | `advanced` 中的同名设置 |

### 同样生效的 Pi 设置

这些设置属于 Pi，而不属于 pi-context-kit。请把它们放在 Pi 的 `settings.json` 的 `compaction` 块中。

| Pi 设置 | 默认值 | 对 pi-context-kit 的影响 |
| --- | --- | --- |
| `compaction.enabled` | `true` | `false` 停止 Pi 的自动压缩。此时 pi-context-kit 只在 `/compact` 时修改上下文，因为没有阈值。 |
| `compaction.reserveTokens` | `16384` | Pi 的限制等于上下文窗口减去这个数。pi-context-kit 总是在这个限制处或之前开始。 |
| `compaction.keepRecentTokens` | `20000` | 交接笔记之后，大约这么多的最新 token 保持不变。 |
| `compaction.modelOverrides` | 无 | 为某一个模型修改 `reserveTokens` 和 `keepRecentTokens`。 |

pi-context-kit 没有针对单个模型的设置。如果只想让某个模型更早开始，请用 `compaction.modelOverrides` 为这个模型缩小 Pi 的限制，例如 `{ "compaction": { "modelOverrides": { "provider/model-id": { "reserveTokens": 80000 } } } }`。对于 200,000 token 的窗口，这个模型最晚在 120,000 个 token 时开始。模型键必须是准确的 `provider/modelId`。要查看这些 ID，请输入 `pi --list-models`。

## 常用配置

| 我想要…… | `context-kit.json` |
| --- | --- |
| 更晚开始，等到 Pi 自身的限制 | `{ "threshold": "pi" }` |
| 在所有模型上以相同的 token 数开始 | `{ "threshold": 150000 }` |
| 尽可能避免模型请求 | `{ "strategy": "frugal" }` |
| 从不写交接笔记 | `{ "advanced": { "methodOrder": ["shake", "soft"] } }` |
| 保留更多最近的工具输出 | `{ "advanced": { "prune": { "protectTokens": 80000 } } }` |
| 保留所有旧的文件副本 | `{ "advanced": { "supersedeReads": false } }` |
| 关闭 pi-context-kit，但保留 `recall` | `{ "enabled": false }`，或使用 `/context-kit` |

## 限制

- **Pi 仍有自己的限制。** 当上下文达到上下文窗口减去 `compaction.reserveTokens`（默认 16,384）时，Pi 会进行压缩。pi-context-kit 只能更早开始，不能更晚。你可以用 `compaction.reserveTokens` 和 `compaction.modelOverrides` 设置 Pi 的限制。
- **阈值不是保证。** 到达阈值时，pi-context-kit 会尝试缩小上下文。如果某个工具输出非常大，或者摘要请求失败，这些方法可能会失败。此时 Pi 会在自身的限制处进行压缩。
- **token 数是估算值。** pi-context-kit 使用 Pi 的估算。提供商的实际计数可能不同。
- **如果 Pi 的压缩已关闭**（`compaction.enabled: false`），pi-context-kit 只在你运行 `/compact` 时修改上下文。这时它会写交接笔记，与压缩开启时相同。`threshold` 会被忽略，因为 pi-context-kit 只在阈值处自动修改上下文。
- **手动压缩和错误。** 当你输入 `/compact`、上下文对模型来说过大，或 Pi 在轮次开始前进行压缩时，`shake` 无法运行。pi-context-kit 会使用已准备好的交接笔记，或 Pi 的摘要。
- **方法顺序在 `soft` 处停止。** `soft` 之后的方法不会运行。
- **子智能体**读取相同的设置文件。它们不显示警告和状态，因为它们没有界面。

## 故障排除

**底部状态栏没有 `Context`**：输入 `pi list`，确认列表中有 `npm:pi-context-kit`。然后重启 Pi。Pi 只在交互模式下显示底部状态栏。

**`pi-context-kit settings need attention`**：某个设置文件中的值无效。pi-context-kit 对该值使用默认值。输入 `/context-kit` 查看问题，然后修正文件，或在面板中选择新的值。

**`pi-context-kit moved its settings to ...`**：较早的版本把设置保存在 Pi 的 `settings.json` 中。pi-context-kit 已把它们复制到自己的文件中，只复制一次。你可以从 `settings.json` 中删除 `contextKit` 条目。

**`pi-context-kit: handoff note failed`**：摘要请求失败。pi-context-kit 会使用下一个方法或 Pi 的摘要，所以你的会话会继续。请检查模型和提供商的限额。

**面板无法保存某个值**：Pi 显示 `pi-context-kit:` 和文件错误。确认你可以写入该设置文件，然后再次选择这个值。

## 常见问题

**它会拖慢我的工作吗？**
通常不会。交接笔记在后台编写，修剪和精简不使用模型。
如果到达阈值时没有准备好的笔记，pi-context-kit 可以推迟交接，直到正在编写的笔记准备好。它也可以写一份新的笔记，这会增加一次模型请求。

**它会增加费用吗？**
一份交接笔记就是一次额外的模型请求。它使用与你的会话相同的模型、思考级别和工具选择。对于 Anthropic，这样可以让提供商复用已缓存的对话。缓存不能保证。

**交接笔记失败会怎样？**
Pi 会显示一条以 `pi-context-kit: handoff note failed` 开头的警告。然后 pi-context-kit 使用下一个方法，或 Pi 的摘要。在阈值处的笔记失败后，pi-context-kit 在下一次压缩之前不会再在阈值处尝试新的笔记。

**我可以为摘要指定重点吗？**
可以。输入 `/compact` 加上重点，例如 `/compact keep the database migration details`。如果空间足够，pi-context-kit 会按照这个重点写一份新的笔记。否则，由 Pi 写它的摘要。

**模型忘记了一个细节，我该怎么办？**
让模型使用 `recall` 工具，例如：“Use recall to find the error message from the first test run.”

## 开发

```sh
npm ci
npm run check
```

测试使用 Pi 的模拟（faux）提供商离线运行。它们不会调用真实模型。
开发使用 Pi `1.5.2`。最早支持的版本是 Pi `1.0.3`。CI 在 Node 22 和 24 上检查锁定的依赖，并在 Node 24 上检查 Pi `1.0.3` 和最新版 Pi。
由宿主提供的 peer 依赖使用 `"*"`，这是 Pi 包指南的要求。这并不保证每个 Pi 版本都能正常工作。

## 参与贡献与发布

关于本地检查、pull request 和发布流程，请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。请通过 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 报告安全漏洞，不要使用公开 issue。

## 许可证

MIT
