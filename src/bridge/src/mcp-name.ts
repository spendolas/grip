// Which MCP server name the installer registers under, and when it must refuse.
// Pure (no I/O, no side effects) so tests can import it; install.ts is an entry script.
//
// A flavour registers under its own name (FLAVOUR.mcpName). Replacing an entry of that
// name that points at something else would silently repoint another install's agents,
// so that is refused unless the user chose a name with --mcp-name.

export interface McpTarget { command?: string; url?: string; args?: string[] }

function sameTarget(a: McpTarget, b: McpTarget): boolean {
  if (a.url || b.url) return a.url === b.url;
  if (a.command !== b.command) return false;
  return JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
}

export function chooseMcpName(
  flavourName: string,
  flag: string | undefined,
  existing: McpTarget | undefined,
  ours: McpTarget,
): { name: string } | { refuse: string } {
  const name = flag && flag.trim() ? flag.trim() : flavourName;
  if (!existing || sameTarget(existing, ours)) return { name };
  const where = existing.url ?? [existing.command, ...(existing.args ?? [])].filter(Boolean).join(' ');
  return {
    refuse: `an MCP server named "${name}" is already registered and points somewhere else (${where || 'unknown target'}); ` +
      `registering would repoint it. Re-run with --mcp-name <name> to register under a different name.`,
  };
}
