// Keyboard rules, kept away from the DOM so they can be tested in Node.
//
// There is one, and it is here rather than inline in the composer because the
// reason for it is invisible in the code and easy to delete as dead weight.

/**
 * Whether a keydown should send the draft.
 *
 * Enter sends and Shift+Enter is a newline — **except while an input method
 * editor is composing.** Typing Japanese, Chinese or Korean, Enter is how you
 * accept the candidate the IME is offering: it is part of writing the word,
 * not a request to post. Treating it as send would publish a half-composed
 * sentence into a room, permanently, for exactly the participants who cannot
 * type any other way. It is also silent for everyone testing in English, which
 * is why it needs a test rather than a reviewer.
 *
 * `isComposing` is the modern signal; keyCode 229 is what browsers reported
 * before it existed, and what some still report for the same keystroke.
 *
 * @param {{key: string, shiftKey?: boolean, isComposing?: boolean, keyCode?: number}} event
 * @returns {boolean}
 */
export function sendsOnEnter(event) {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  return !(event.isComposing || event.keyCode === 229);
}
