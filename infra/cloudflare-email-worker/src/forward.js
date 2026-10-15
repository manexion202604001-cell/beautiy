/**
 * Pure part of the worker (unit tested with node --test): pick the Salon OS inbound URL for the
 * recipient address and build the JSON body the API's inbound_email webhook understands
 * (apps/api/src/modules/integrations/mail/inbound.ts).
 */

/** "hpb-omotesando@in.example.jp" → routes["hpb-omotesando"] (case-insensitive, "+tag" ignored) */
export function routeFor(routes, recipient) {
  const local = String(recipient ?? '')
    .trim()
    .toLowerCase()
    .split('@')[0]
    .split('+')[0];
  for (const [key, url] of Object.entries(routes ?? {})) {
    if (key.toLowerCase() === local) return url;
  }
  return null;
}

export function parseRoutes(json) {
  if (!json) return {};
  const routes = JSON.parse(json);
  for (const [key, url] of Object.entries(routes)) {
    if (typeof url !== 'string' || !/^https:\/\/[^/]+\/v1\/webhooks\/inbound_email\/[A-Za-z0-9_-]{16,100}$/.test(url)) {
      throw new Error(`ROUTES["${key}"] is not a Salon OS inbound URL`);
    }
  }
  return routes;
}

const address = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '');

/** postal-mime result → webhook body */
export function webhookBody(parsed, envelope) {
  return {
    from: address(parsed.from) || envelope.from || '',
    to: envelope.to || (parsed.to ?? []).map(address).join(', '),
    subject: parsed.subject ?? '',
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    messageId: parsed.messageId ?? null,
    date: parsed.date ?? null,
  };
}
