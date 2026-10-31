// Connector "email" for the calendar: turns an approved entry into a campaign at the provider named in the campaign's email target
// (campaign channel set email provider=resend segmentId=... from="Name <a@b.c>"), then sends it. Retries reuse the draft
// (one send per entry), so a failure after creating never produces a second campaign.
import type { Connector } from "../publish.ts";
import type { EmailProvider, EmailStore } from "./domain/ports.ts";
import { renderEmail } from "./domain/render.ts";

export function emailConnector(providers: EmailProvider[], store: EmailStore): Connector {
  const find = (id: string | undefined) => {
    const p = id ? providers.find((x) => x.id === id) : providers.length === 1 ? providers[0] : undefined;
    if (!p?.sender) throw new Error(id ? `E-mail provider "${id}" is not configured (has no credentials)` : `Say which e-mail provider the campaign uses: provider=${providers.map((x) => x.id).join("|")}`);
    return p as EmailProvider & { sender: NonNullable<EmailProvider["sender"]> };
  };
  return {
    id: "email",
    channels: ["email"],
    targetHint: "bb brandwise campaign channel set email provider=resend segmentId=<segment id> from=\"Name <news@yourdomain>\" [replyTo=<address>]",
    async publish({ entry, target }) {
      const t = target ?? {};
      let send = await store.sendForEntry(entry.id);
      const provider = find(send?.provider ?? t.provider);
      if (!send) {
        if (!t.from) throw new Error("The campaign's email target has no from=");
        const { html, text } = renderEmail({ body: entry.body || entry.title, link: entry.link, entryId: entry.id, unsubscribeTag: provider.sender.unsubscribeTag });
        const { externalId } = await provider.sender.createCampaign({
          name: `${entry.campaignName}: ${entry.title}`.slice(0, 200), subject: entry.title, html, text: text || undefined,
          from: t.from, replyTo: t.replyTo || undefined, target: t, tags: { bw_entry: entry.id },
        });
        send = await store.recordSend({ entryId: entry.id, provider: provider.id, externalId, capabilities: provider.capabilities });
      }
      // a retry after a failure that came late: if the provider already took it, do not send twice
      const status = await provider.sender.status?.(send.externalId);
      if (status !== "sent" && status !== "scheduled") await provider.sender.send(send.externalId);
      return { externalId: `${provider.id}:${send.externalId}` };
    },
  };
}
