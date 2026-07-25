// Requirement 8: drift between the Design project and this library must be
// detectable rather than discovered.
//
// The receipt is `DESIGN_VERSION.md`, vendored verbatim from the handoff — it
// is the design system's own statement of what it is. `design-version.json`
// is the library's statement of what it implements. When those two disagree,
// somebody re-exported the design and nobody re-read it, and that must be a
// visible state rather than something a reviewer happens to notice.
//
// The sync procedure asks for a mechanical diff against `_ds_manifest.json`
// (components, cards, tokens). That file is not in the handoff — see
// QUESTIONS.md Q7 — so this check compares versions, which is the strongest
// check the shipped material supports. It is deliberately not more clever
// than the data it has.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Drift =
  | { ok: true; version: string }
  | { ok: false; version: string; implemented: string; message: string };

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The `design_version:` line inside DESIGN_VERSION.md's fenced block. */
export function designVersion(text: string): string {
  const match = /^design_version:\s*(\S+)\s*$/m.exec(text);
  if (!match?.[1]) {
    throw new Error(
      'DESIGN_VERSION.md carries no `design_version:` line. It is vendored from the design handoff verbatim — ' +
        'if the format changed, the sync procedure changed with it, and that is a conversation, not a parse fix.',
    );
  }
  return match[1];
}

/** Compare what the design package says against what this library claims to implement. */
export function checkDesignDrift(root: string = HERE): Drift {
  const declared = designVersion(readFileSync(`${root}/DESIGN_VERSION.md`, 'utf8'));
  const implemented = JSON.parse(readFileSync(`${root}/design-version.json`, 'utf8')).implements as string;
  if (declared === implemented) return { ok: true, version: declared };
  return {
    ok: false,
    version: declared,
    implemented,
    message:
      `The design system is at ${declared}; src/ui implements ${implemented}. ` +
      'Triage the delta before bumping: implement each changed token or prop, or record it as a question in ' +
      'src/ui/QUESTIONS.md. Never close the gap by editing a value locally — the library implements the design, ' +
      'it never extends it.',
  };
}
