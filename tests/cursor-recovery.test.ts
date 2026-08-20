import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openQuorum } from '../src/domain/quorum.ts';

test('identify repairs a persisted cursor past a restored feed head', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-cursor-repair-'));
  const path = join(dir, 'quorum.db');
  try {
    const first = openQuorum({ path });
    const ada = first.identify({ name: 'ada', harness: 'test' });
    first.createRoom({ name: 'platform', by: ada.participant.id });
    first.close();

    // Simulate durable state left by the old implementation after a feed
    // restore: the participant row survived with an unreachable cursor.
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE participants SET cursor = ? WHERE id = ?').run(999_999, ada.participant.id);
    raw.close();

    const second = openQuorum({ path });
    const back = second.identify({ name: 'ada', harness: 'test' });
    assert.equal(back.cursor, 0, 'the poisoned cursor resets to replay-safe history');
    assert.equal(second.cursorFor(back.participant.id).cursor, 0, 'the repair is persisted');
    assert.ok(
      (await second.waitForEvents({ afterSeq: back.cursor, timeoutMs: 0, participantId: back.participant.id })).length >
        0,
      'the participant can consume the restored feed normally',
    );
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
