export const STATUS_LABEL: Record<string, string> = {
  ok: 'alive',
  auth: 'needs auth',
  payment: 'paid (402)',
  not_found: 'not found',
  rate_limited: 'rate limited',
  server_error: 'server error',
  protocol_error: 'not MCP',
  timeout: 'timeout',
  dns: 'no DNS',
  tls: 'TLS error',
  refused: 'refused',
  error: 'error'
};

/** Three buckets for colours and filters. */
export function bucket(status: string): 'up' | 'gated' | 'down' {
  if (status === 'ok') return 'up';
  if (status === 'auth' || status === 'payment') return 'gated';
  return 'down';
}

export function label(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)} %` : '';
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/** Share of a 200k context window, as text. */
export function windowShare(tokensCount: number | null | undefined, window = 200_000): string {
  if (!tokensCount) return '';
  const share = (tokensCount / window) * 100;
  return share < 0.1 ? '<0.1 %' : `${share.toFixed(1)} %`;
}
