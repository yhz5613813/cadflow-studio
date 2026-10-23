import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../shared/types';
import { groupMessages } from '../src/chat/message-groups';
const message = (id: string, role: Message['role'], text = id): Message => ({id, role, text, timestamp: 1});

test('consecutive commands form one transcript without crossing conversation boundaries', () => {
  const input = [message('u','user'), message('a','tool'), message('b','tool'), message('c','assistant'), message('d','tool'), message('e','system'), message('f','tool')];
  const groups = groupMessages(input);
  assert.deepEqual(groups.map(g => g.kind === 'tools' ? g.messages.map(m => m.id) : g.message.id), ['u',['a','b'],'c',['d'],'e',['f']]);
  assert.deepEqual(groups.flatMap(g => g.kind === 'tools' ? g.messages : [g.message]), input);
});

test('stream updates and appended commands retain group identity and preserve errors', () => {
  const first = message('tool-1','tool','arguments');
  const before = groupMessages([first]);
  const updated = {...first, text: 'failed output', error: true};
  const after = groupMessages([updated, message('tool-2','tool')]);
  assert.equal(after[0].key, before[0].key);
  assert.equal(after[0].kind, 'tools');
  if(after[0].kind === 'tools') {
    assert.equal(after[0].messages[0].text, 'failed output');
    assert.equal(after[0].messages[0].error, true);
    assert.equal(after[0].messages.length, 2);
  }
  assert.equal(first.text, 'arguments');
});

test('empty history and single tool remain valid without mutating input', () => {
  assert.deepEqual(groupMessages([]), []);
  const input = Object.freeze([Object.freeze(message('one','tool'))]);
  const groups = groupMessages([...input]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'one');
});
