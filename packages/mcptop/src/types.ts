export type RemoteTransport = 'streamable-http' | 'sse';
export type ProbeTransport = RemoteTransport | 'stdio';

export interface RegistryRemote {
  type: RemoteTransport;
  url: string;
  headers?: Array<{ name: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport?: { type: string; url?: string };
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
  | 'error';

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
  error?: string;
}
