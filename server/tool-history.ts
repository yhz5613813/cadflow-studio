import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseSessionEntries } from '@earendil-works/pi-coding-agent';
import type { Message } from '../shared/types.js';

/** Recover inputs omitted by older Studio transcripts from the owning Pi log, without rewriting it. */
export async function restoreToolArguments(messages: Message[], sessionDir: string): Promise<Message[]> {
  const missing = new Map(messages.filter(message => message.role === 'tool' && message.args === undefined).map(message => [message.id, message]));
  if (!missing.size) return messages;
  const files = await fs.readdir(sessionDir, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const recovered = new Map<string, unknown>();
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const entries = parseSessionEntries(await fs.readFile(path.join(sessionDir, file.name), 'utf8'));
    for (const entry of entries) {
      if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      for (const block of entry.message.content) {
        if (block.type !== 'toolCall') continue;
        const message = missing.get(block.id);
        if (message && message.toolName === block.name) recovered.set(block.id, block.arguments);
      }
    }
  }
  return messages.map(message => recovered.has(message.id) ? { ...message, args: recovered.get(message.id) } : message);
}
