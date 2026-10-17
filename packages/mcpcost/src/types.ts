export type RemoteTransport = 'streamable-http' | 'sse';
export type ProbeTransport = RemoteTransport | 'stdio';

export interface RegistryRemote {
  type: RemoteTransport;
  url: string;
  headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
}

export interface RegistryArgument {
  type: 'positional' | 'named' | 'flag' | string;
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  isRequired?: boolean;
  isRepeated?: boolean;
  description?: string;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string; url?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean; default?: string }>;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string };
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
}

export interface RegistryEntry {
  server: RegistryServer;
  meta: {
    status: 'active' | 'deprecated' | 'deleted' | string;
    publishedAt: string;
    updatedAt: string;
    isLatest: boolean;
  };
}

export type ProbeStatus =
  | 'ok'
  | 'auth'
  | 'payment'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'protocol_error'
  | 'newer_protocol'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'refused'
  | 'error'
  // package (stdio) servers only
  | 'install_failed'
  | 'no_bin'
  | 'needs_env'
  | 'needs_args'
  | 'needs_network'
  | 'crashed';

/** Reachable but not usable without something from the user: credentials, arguments, a network, or a newer SDK. */
export const GATED_STATUSES: ReadonlySet<string> = new Set(['auth', 'payment', 'newer_protocol', 'needs_env', 'needs_args', 'needs_network']);

export interface ToolCost {
  name: string;
  /** Tokens of the tool definition as a model would see it (name, description, input schema). */
  tokens: number;
  /** Bytes of the compact JSON of the same definition. */
  bytes: number;
  descriptionChars: number;
}

export interface ProbeResult {
  /** The endpoint URL, or `stdio:<command>` for a local server. */
  url: string;
  transport: ProbeTransport;
  probedAt: string;
  status: ProbeStatus;
  httpStatus?: number;
  /** Scheme from the WWW-Authenticate header, for example "Bearer". */
  authScheme?: string;
  /** Whether the server advertises OAuth protected-resource metadata in WWW-Authenticate. */
  authResourceMetadata?: string;
  latencyMs: {
    initialize?: number;
    toolsList?: number;
  };
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string; title?: string };
  capabilities?: string[];
  instructionsChars?: number;
  toolCount?: number;
  /** Sum of tokens over all tool definitions. */
  toolsTokens?: number;
  toolsBytes?: number;
  tools?: ToolCost[];
  /** Exact count from the Anthropic count_tokens endpoint, when a key was available. */
  claude?: ClaudeTokens;
  /** Exact count from the Gemini countTokens endpoint, when a key was available. */
  gemini?: GeminiTokens;
  error?: string;
}

export interface GeminiTokens {
  /** Model id the count was made for, for example gemini-3.8-flash. */
  model: string;
  /** Tokens the tool definitions add, from the Gemini countTokens endpoint. */
  tokens?: number;
  measuredAt: string;
  /** Why the count failed, for example a schema the API does not accept. */
  error?: string;
}

export interface ClaudeTokens {
  /** Model id the count was made for, for example claude-opus-5-5. */
  model: string;
  /** Tokens the tool definitions add, with the tool names as the server publishes them. */
  tokens?: number;
  /** The same with Claude Code's mcp__<server>__ prefix on every tool name. */
  tokensClaudeCode?: number;
  measuredAt: string;
  /** Why the count failed, for example a schema the API does not accept. */
  error?: string;
}
