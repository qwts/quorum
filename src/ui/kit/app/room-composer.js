// Wire the room composer's two lifecycles without making room.js own either.

import { api } from './api.js';
import { ensureIdentified, forget, isStaleIdentity } from './me.js';
import { createSender } from './posting.js';
import { createProposer } from './proposing.js';

/**
 * @param {object} ports
 * @param {Window} ports.win
 * @param {() => string} ports.room
 * @param {() => {id: string, name: string}|null} ports.me
 * @param {(who: {id: string, name: string}|null) => void} ports.setMe
 * @param {() => string} ports.draft
 * @param {(value: string) => void} ports.setDraft
 * @param {(message: string|null) => void} ports.setNotice
 * @param {() => void} ports.settled
 */
export function createRoomComposerActions(ports) {
  // Native prompts are the Q12/Q14 platform-chrome seam. This module is the
  // only room-composer code that needs to know they exist.
  const identify = () => ensureIdentified({ ask: (message) => ports.win.prompt(message), identify: api.identify });

  return {
    send: createSender({
      room: ports.room,
      me: ports.me,
      setMe: ports.setMe,
      draft: ports.draft,
      setDraft: ports.setDraft,
      setNotice: ports.setNotice,
      settled: ports.settled,
      identify,
      join: api.join,
      post: api.post,
      isStaleIdentity,
      forget,
    }),
    propose: createProposer({
      room: ports.room,
      me: ports.me,
      setMe: ports.setMe,
      setNotice: ports.setNotice,
      settled: ports.settled,
      identify,
      join: api.join,
      propose: api.propose,
      ask: (message) => ports.win.prompt(message),
      isStaleIdentity,
      forget,
    }),
  };
}
