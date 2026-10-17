/**
 * The Worker entry: the Astro app for requests, and a cron handler that sends
 * the alert mails after the daily run. wrangler.jsonc names this file as main.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { notifyDue } from './lib/watch';

export default {
  fetch: handle,
  async scheduled(_event: ScheduledController, _env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      notifyDue(200).then((r) => console.log(`watch mails: ${r.sent} sent, ${r.failed} failed`))
    );
  }
} satisfies ExportedHandler<Env>;
