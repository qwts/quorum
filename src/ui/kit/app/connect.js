// Connect an agent (#20; design 0.4.0 `ConnectAgent`) — onboarding/ops.
//
// The command is the product surface here: one MCP endpoint, no
// harness-specific setup. The screen's one live element is step 2 — it waits
// on the feed for a real `participant_identified` and flips when one arrives,
// which is the product demonstrating its own promise instead of a mock
// simulating it.

import { h } from '../../lib/element.js';
import { api } from './api.js';
import { openFeed } from './feed.js';
import { commandsFor } from './connect-model.js';

/**
 * @param {object} options
 * @param {Document} [options.doc]
 * @param {Location} [options.where]
 */
export async function mountConnect({ doc = document, where = location } = {}) {
  const region = doc.getElementById('steps');

  /** @type {'claude-code'|'codex'|'other'} */
  let harness = 'claude-code';
  let copied = false;
  /** The identify that arrived while this page was open, if one has. @type {any} */
  let identified = null;
  /** @type {any[]} */
  let rooms = [];

  const commands = commandsFor(where.origin);

  const stepHead = (/** @type {number} */ n, /** @type {string} */ title, /** @type {boolean} */ done) =>
    h(
      'div',
      { class: 'step-head' },
      h('span', { class: `step-no${done ? ' done' : ''}` }, done ? '✓' : String(n)),
      h('span', { class: 'step-title' }, title),
    );

  const render = () => {
    const command = commands[harness] ?? '';
    region?.replaceChildren(
      h(
        'section',
        { class: 'step' },
        stepHead(1, 'Register the endpoint', copied),
        h(
          'div',
          { class: 'tabs' },
          ...Object.keys(commands).map((name) =>
            h(
              'button',
              {
                type: 'button',
                class: `tab${harness === name ? ' active' : ''}`,
                onclick: () => {
                  harness = /** @type {any} */ (name);
                  render();
                },
              },
              name,
            ),
          ),
        ),
        h(
          'pre',
          { class: 'command' },
          h('span', { class: 'prompt' }, '$ '),
          command,
          h(
            'button',
            {
              type: 'button',
              class: `copy${copied ? ' done' : ''}`,
              onclick: () => {
                void navigator.clipboard?.writeText(command);
                copied = true;
                render();
              },
            },
            copied ? 'COPIED' : 'COPY',
          ),
        ),
      ),
      h(
        'section',
        { class: 'step' },
        stepHead(2, 'Have the agent identify itself', Boolean(identified)),
        h(
          'p',
          { class: 'lede' },
          'From inside the session, one call: ',
          h('code', {}, 'identify'),
          ' with a name and a harness. Identity is that pair, not the connection — reuse the name and a ' +
            'reconnect resumes the same participant and hands back its claims.',
        ),
        identified
          ? h(
              'div',
              { class: 'watch done' },
              h('q-identity-chip', {
                name: identified.participant.name,
                harness: identified.participant.harness,
                kind: identified.participant.harness === 'human' ? 'human' : 'agent',
                repo: identified.participant.repo,
                branch: identified.participant.branch,
              }),
              h(
                'span',
                { class: 'watch-note' },
                `${identified.resumed ? 'resumed on' : 'joined'} the roster · seq ${identified.seq}`,
              ),
            )
          : h(
              'div',
              { class: 'watch' },
              h('span', { class: 'watch-dot' }),
              h('span', { class: 'quiet' }, `waiting for an identify call on ${where.host}…`),
            ),
      ),
      h(
        'section',
        { class: `step${identified ? '' : ' ahead'}` },
        stepHead(3, 'Put it in a room', false),
        h(
          'p',
          { class: 'lede' },
          'Rooms carry the decision rule, so the agent inherits the protocol the moment it joins: ',
          h('code', {}, 'join_room'),
          ', then ',
          h('code', {}, 'claim_scope'),
          ' before it touches files, then ',
          h('code', {}, 'wait_for_events'),
          ' instead of polling.',
        ),
        rooms.length
          ? h('div', { class: 'room-pills' }, ...rooms.map((room) => h('span', { class: 'room-pill' }, `#${room.name}`)))
          : h('div', { class: 'quiet' }, 'No rooms yet — the room view creates one, or an agent can create_room.'),
      ),
    );
  };

  const painted = await api.rooms();
  rooms = painted.rooms;
  render();

  const feed = openFeed({
    after: painted.seq,
    onEvent: (/** @type {any} */ event) => {
      if (event.kind === 'participant_identified') {
        identified = { ...event.payload, seq: event.seq };
        render();
        return;
      }
      if (event.kind === 'room_created') {
        rooms = [...rooms, event.payload.room];
        render();
      }
    },
    onStatus: () => {},
  });

  return {
    close: () => feed.close(),
    get identified() {
      return identified;
    },
  };
}
