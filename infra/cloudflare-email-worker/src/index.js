import PostalMime from 'postal-mime';
import { parseRoutes, routeFor, webhookBody } from './forward.js';

export default {
  /**
   * Cloudflare Email Routing hands every mail sent to the routed addresses to this handler.
   * The mail is posted to the shop's Salon OS inbound URL; when Salon OS cannot take it the
   * mail is rejected so the sender (SALON BOARD) sees a bounce instead of a silent loss.
   */
  async email(message, env) {
    const url = routeFor(parseRoutes(env.ROUTES), message.to);
    if (env.BACKUP_TO) await message.forward(env.BACKUP_TO);
    if (!url) {
      message.setReject('Unknown recipient');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(parsed, { from: message.from, to: message.to })),
    });
    if (!res.ok) {
      console.error(`Salon OS answered ${res.status} for mail to ${message.to}`);
      message.setReject(`Temporary failure (${res.status})`);
    }
  },
};
