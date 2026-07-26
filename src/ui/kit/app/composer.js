// What the composer should show, given the state.
//
// A pure function of the model returning plain props, deliberately away from
// the DOM so it can be tested in Node — the same treatment the other two rules
// that matter get. What it encodes is small and easy to get quietly wrong: a
// field that is disabled without saying why reads as broken rather than as
// closed, which is this component's one real failure mode.

/**
 * @param {any} room                            the open room, or null
 * @param {{id: string, name: string}|null} me  who this browser is, if it has said
 * @param {string|null} notice                  a refusal returned to this person alone
 */
export function composerProps(room, me, notice) {
  if (!room) {
    return {
      placeholder: 'Message',
      notice,
      disabled: true,
      // Always paired with `disabled`, and it ends in the next action.
      disabledReason: 'Open a room from the left to post in it.',
      hint: null,
    };
  }

  return {
    placeholder: `Message #${room.name}`,
    notice,
    disabled: false,
    disabledReason: null,
    // Not a rule the component enforces — the honest description of what
    // pressing send will do, which is to ask for a name first. Once named, the
    // component's own keyboard hint is the right thing to show.
    hint: me ? null : 'Enter to send · you will be asked for a name once',
  };
}
