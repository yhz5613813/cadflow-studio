import type { Message } from '../../shared/types';

export type MessageGroup =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'tools'; key: string; messages: Message[] };

// Keep the first tool id as the React key so streamed output or another tool
// does not reset the user's expanded/collapsed state.
export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const previous = groups[groups.length - 1];
    if (message.role !== 'tool') {
      groups.push({ kind: 'message', key: message.id, message });
    } else if (previous?.kind === 'tools') {
      previous.messages.push(message);
    } else {
      groups.push({ kind: 'tools', key: message.id, messages: [message] });
    }
  }
  return groups;
}
