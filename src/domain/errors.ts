// Domain errors reach agents as text. Any participant- or caller-authored
// value interpolated into one is JSON-quoted at the throw site, so a room
// named with a newline and a directive cannot read as guidance downstream.
//
// Lives alone so every domain module can throw it without importing the
// module that composes them — quorum.ts re-exports it for consumers.
export class QuorumError extends Error {}
