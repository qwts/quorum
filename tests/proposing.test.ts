import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectProposal, createProposer } from '../src/ui/kit/app/proposing.js';

test('the room composer convenes a deliberation without inventing a form (1.1 #9)', async () => {
  const answers = ['Ship the beta?', 'Now', 'After the acceptance walk', null];
  const calls = { joined: [] as string[], proposed: [] as any[], notice: null as string|null, settled: 0 };
  let room = 'protocol';
  let me: any = null;
  const propose = createProposer({
    room: () => room,
    me: () => me,
    setMe: (who) => { me = who; },
    setNotice: (message) => { calls.notice = message; },
    settled: () => { calls.settled += 1; },
    identify: async () => {
      room = 'elsewhere'; // a click in the sidebar while identity is in flight
      return { id: 'p-human', name: 'Dana' };
    },
    join: async (name, participantId) => { calls.joined.push(`${name}/${participantId}`); },
    propose: async (name, participantId, question, options) => {
      calls.proposed.push({ room: name, participantId, question, options });
    },
    ask: () => answers.shift() ?? null,
    isStaleIdentity: () => false,
    forget: () => {},
  });

  await propose();

  assert.deepEqual(calls.joined, ['protocol/p-human']);
  assert.deepEqual(calls.proposed, [{
    room: 'protocol', participantId: 'p-human', question: 'Ship the beta?',
    options: ['Now', 'After the acceptance walk'],
  }]);
  assert.equal(calls.notice, null);
  assert.equal(calls.settled, 1);

  assert.equal(collectProposal(() => null), null, 'canceling the question abandons the action');
  const incomplete = ['Question?', 'Only one', null];
  assert.throws(() => collectProposal(() => incomplete.shift() ?? null), /at least two options/);
});

test('a late proposal refusal stays with the room where it began', async () => {
  const answers = ['Question?', 'A', 'B', null];
  let room = 'protocol';
  let notice: string|null = null;
  let fail: (error: Error) => void = () => {};
  let started: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const propose = createProposer({
    room: () => room,
    me: () => ({ id: 'p-human', name: 'Dana' }),
    setMe: () => {},
    setNotice: (message) => { notice = message; },
    settled: () => {},
    identify: async () => ({ id: 'p-human', name: 'Dana' }),
    join: async () => {},
    propose: async () => new Promise((_resolve, reject) => {
      fail = reject;
      started();
    }),
    ask: () => answers.shift() ?? null,
    isStaleIdentity: () => false,
    forget: () => {},
  });

  const pending = propose();
  await requestStarted;
  room = 'elsewhere';
  fail(new Error('options must be distinct'));
  await pending;

  assert.equal(notice, null, 'the old-room refusal is not painted beneath the new room');
});
