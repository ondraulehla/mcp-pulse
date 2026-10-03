import type { APIRoute } from 'astro';
import { getServer } from '../../lib/db';
import { bucket, label, tokens } from '../../lib/format';

const COLORS = { up: '#2ea44f', gated: '#2d5bd1', down: '#c43a2f', unknown: '#8a8f98' } as const;

/** Approximate text width for Verdana 11px, the same rule shields.io used for years. */
function width(text: string): number {
  return Math.round(text.length * 6.4 + 10);
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function badge(left: string, right: string, color: string): string {
  const lw = width(left);
  const rw = width(right);
  const w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escape(left)}: ${escape(right)}">
<title>${escape(left)}: ${escape(right)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${escape(left)}</text><text x="${lw / 2}" y="14">${escape(left)}</text>
<text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${escape(right)}</text><text x="${lw + rw / 2}" y="14">${escape(right)}</text>
</g></svg>`;
}

export const GET: APIRoute = async ({ params }) => {
  const name = (params.name ?? '').replace(/\.svg$/, '');
  const server = name ? await getServer(name) : null;
  let text = 'unknown server';
  let color: string = COLORS.unknown;
  if (server) {
    const b = bucket(server.status);
    color = COLORS[b];
    if (server.status === 'ok') {
      text = `alive · ${server.tool_count} tools · ${tokens(server.tools_tokens)} tokens`;
    } else {
      text = label(server.status);
    }
  }
  return new Response(badge('mcp-pulse', text, color), {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': server ? 'public, max-age=3600, s-maxage=21600' : 'public, max-age=300',
      'access-control-allow-origin': '*'
    }
  });
};
