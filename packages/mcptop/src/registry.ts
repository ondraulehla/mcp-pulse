import type { RegistryEntry, RegistryRemote } from './types.js';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

interface RawPage {
  servers: Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
  metadata: { nextCursor?: string; count: number };
}

export interface FetchRegistryOptions {
  /** Only the latest version of each server. Default true. */
  latest?: boolean;
  /** Page size, max 100. */
  limit?: number;
  /** Stop after this many entries (for tests and samples). */
  max?: number;
  fetch?: typeof fetch;
  onPage?: (loaded: number) => void;
}

/** Downloads the registry listing page by page. */
export async function fetchRegistry(options: FetchRegistryOptions = {}): Promise<RegistryEntry[]> {
  const { latest = true, limit = 100, max = Infinity, onPage } = options;
  const doFetch = options.fetch ?? fetch;
  const entries: RegistryEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = new URL(REGISTRY_URL);
    url.searchParams.set('limit', String(limit));
    if (latest) url.searchParams.set('version', 'latest');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`registry ${url} responded ${res.status}`);
    const page = (await res.json()) as RawPage;
    for (const item of page.servers) {
      entries.push({ server: item.server, meta: item._meta[OFFICIAL_META] });
      if (entries.length >= max) return entries;
    }
    onPage?.(entries.length);
    cursor = page.metadata.nextCursor;
    if (!cursor) return entries;
  }
}

/** Picks the remote endpoint to probe: streamable-http first, then sse. */
export function primaryRemote(entry: RegistryEntry): RegistryRemote | undefined {
  const remotes = entry.server.remotes ?? [];
  return remotes.find((r) => r.type === 'streamable-http') ?? remotes.find((r) => r.type === 'sse');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
