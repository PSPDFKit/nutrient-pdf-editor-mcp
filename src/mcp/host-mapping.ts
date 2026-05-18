// Maps an MCP client identity (the `clientInfo` advertised at the `initialize`
// handshake) to the host identifier passed as `appName` to `NutrientSDK.load`.
//
// Adding a new host: capture the `clientInfo.name` value the host advertises
// (visible in the `viewer.resource.read` log line) and add a row to the
// HOST_RULES table below.

const CLAUDE_DESKTOP_APP_NAME = "com.anthropic.claude.desktop";

// Each rule maps a set of client name signals to a host identifier. Matching
// is case-insensitive against `clientInfo.name`. Evaluation order: rules are
// checked top to bottom; the first match wins. Within a rule, a name matches
// if it starts with `namePrefix` or contains any `nameSubstrings` entry.
//
// Patterns are intentionally loose so a future Anthropic rename of the
// underlying MCP client (e.g. `custom3p-main` → something else) keeps
// resolving as long as the new name still embeds "claude" or "custom3p", or
// preserves the `local-agent-mode-` prefix.
interface HostRule {
  /** clientInfo.name prefix (lowercase), e.g. "local-agent-mode-". */
  namePrefix?: string;
  /** Substrings (lowercase) to match anywhere in clientInfo.name. */
  nameSubstrings?: ReadonlyArray<string>;
  /** Resolved host identifier passed as SDK appName. */
  appName: string;
  /** Human-readable note about this host entry. */
  note: string;
}

const HOST_RULES: HostRule[] = [
  {
    namePrefix: "local-agent-mode-",
    nameSubstrings: ["custom3p", "claude"],
    appName: CLAUDE_DESKTOP_APP_NAME,
    note: "Claude Desktop — Local Agent Mode (Cowork), custom3p Connector path, or any *claude* identifier"
  }
];

export function resolveHostAppName(clientInfo: { name?: string } | undefined): string | null {
  const name = clientInfo?.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const lower = name.toLowerCase();

  for (const rule of HOST_RULES) {
    if (rule.namePrefix && lower.startsWith(rule.namePrefix)) return rule.appName;
    if (rule.nameSubstrings?.some((sub) => lower.includes(sub))) return rule.appName;
  }

  // Unknown client: return null so `appName` is omitted and the SDK uses
  // its default behavior (any resulting licensing error surfaces clearly).
  return null;
}
