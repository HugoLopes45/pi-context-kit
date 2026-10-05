import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Same shape as the details of Pi's default compaction. */
export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

/**
 * Files read, written or edited on the whole branch, including calls made from codemode scripts.
 * The raw branch keeps compacted entries, so the lists stay cumulative across every compaction.
 */
export function fileLists(branch: readonly SessionEntry[]): FileLists {
  const read = new Set<string>();
  const modified = new Set<string>();
  const add = (name: string, args: Record<string, unknown> | undefined) => {
    const path = args?.path;
    if (typeof path !== "string" || path.length === 0) return;
    if (name === "read") read.add(path);
    else if (name === "write" || name === "edit") modified.add(path);
  };
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") add(block.name, block.arguments);
      }
    } else if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? [])
        add(call.name, call.arguments);
    }
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** The file sections Pi appends to its own compaction summaries. */
export function formatFileLists({
  readFiles,
  modifiedFiles,
}: FileLists): string {
  const sections: string[] = [];
  if (readFiles.length > 0)
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  return sections.join("\n\n");
}
