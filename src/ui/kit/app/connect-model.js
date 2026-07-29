// The connect screen's one derivation, DOM-free so Node can pin it: the
// registration command per harness, against this server's real endpoint —
// never the design mock's hardcoded port.

/**
 * @param {string} origin e.g. `http://127.0.0.1:4242`
 * @returns {Record<string, string>}
 */
export function commandsFor(origin) {
  const endpoint = `${origin}/mcp`;
  return {
    'claude-code': `claude mcp add --transport http quorum ${endpoint}`,
    codex: `codex mcp add quorum --url ${endpoint}`,
    other: `# point any MCP client at the streamable-HTTP endpoint\n${endpoint}`,
  };
}
