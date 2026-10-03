/**
 * Tells Bing (and every IndexNow partner) which server pages changed. Usage:
 *   INDEXNOW_KEY=<key> node --import tsx probe/indexnow.ts --changed data/latest/changed.json [--all data/latest/servers.json]
 * The key file must be served at https://mcp-pulse.ulehla.dev/<key>.txt (it lives in site/public).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { changed: { type: 'string' }, all: { type: 'string' }, host: { type: 'string', default: 'mcp-pulse.ulehla.dev' } } });
const key = process.env.INDEXNOW_KEY;
if (!key) {
  console.error('INDEXNOW_KEY is not set, skipping IndexNow.');
  process.exit(0);
}
let names: string[] = [];
if (args.changed) {
  const changed = JSON.parse(await readFile(args.changed, 'utf8')) as { changed: string[]; removed: string[] };
  names = [...changed.changed, ...changed.removed];
} else if (args.all) {
  names = (JSON.parse(await readFile(args.all, 'utf8')) as Array<{ name: string }>).map((s) => s.name);
}
const urls = [`https://${args.host}/`, `https://${args.host}/tokens`, `https://${args.host}/statistics`, ...names.map((n) => `https://${args.host}/s/${n}`)];
let sent = 0;
for (let i = 0; i < urls.length; i += 1_000) {
  const urlList = urls.slice(i, i + 1_000);
  const res = await fetch('https://www.bing.com/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: args.host, key, keyLocation: `https://${args.host}/${key}.txt`, urlList })
  });
  console.error(`IndexNow: ${urlList.length} URLs -> HTTP ${res.status}`);
  if (res.status >= 400) {
    console.error(await res.text().catch(() => ''));
    process.exit(0);
  }
  sent += urlList.length;
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`IndexNow: submitted ${sent} URLs.`);
