// Postgres implementation of the domain's EmailStore.
// shortcut: eventsFor loads every event of the given sends and counts in memory; fine for newsletters of thousands, move the
// counting into SQL (count distinct per send and recipient) when a send has hundreds of thousands of events.
import type pg from "pg";
import type { CountableEvent, EmailStore, SendRecord } from "./domain/ports.ts";
import type { Capabilities } from "./domain/types.ts";

const sendFrom = (r: any): SendRecord => ({ id: r.id, entryId: r.entry_id, provider: r.provider, externalId: r.external_id, capabilities: r.capabilities as Capabilities, createdAt: new Date(r.created_at).toISOString() });

export function pgEmailStore(pool: pg.Pool): EmailStore {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  return {
    async resolveSend(provider, ref) {
      if (ref.sendId) return (await q("select id from email_send where id = $1", [ref.sendId]))[0]?.id ?? null;
      if (ref.externalId) return (await q("select id from email_send where provider = $1 and external_id = $2", [provider, ref.externalId]))[0]?.id ?? null;
      return null;
    },
    async insertEvents(rows) {
      let inserted = 0;
      for (const { event: e, sendId } of rows) {
        inserted += (await q(
          `insert into email_event (provider, provider_event_id, send_id, ref_external_id, type, at, recipient_hash, recipient_domain, detail, raw, schema_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (provider, provider_event_id) do nothing returning id`,
          [e.provider, e.providerEventId, sendId, e.ref.externalId ?? null, e.type, e.at, e.recipient.hash, e.recipient.domain, e.detail, e.raw ?? null, e.schemaVersion],
        )).length;
      }
      return inserted;
    },
    async recordSend({ entryId, provider, externalId, capabilities }) {
      const row = (await q(
        "insert into email_send (entry_id, provider, external_id, capabilities) values ($1,$2,$3,$4) returning *",
        [entryId, provider, externalId, capabilities],
      ))[0];
      // events that arrived before we recorded the send (or for a campaign sent by hand) are linked now
      await q("update email_event set send_id = $1 where send_id is null and provider = $2 and ref_external_id = $3", [row.id, provider, externalId]);
      return sendFrom(row);
    },
    async sendForEntry(entryId) {
      const r = (await q("select * from email_send where entry_id = $1", [entryId]))[0];
      return r ? sendFrom(r) : null;
    },
    async sends({ entryId, campaignId }) {
      return (await q(
        `select s.* from email_send s join content_calendar c on c.id = s.entry_id
         where ($1::text is null or s.entry_id = $1) and ($2::uuid is null or c.campaign_id = $2) order by s.created_at`,
        [entryId ?? null, campaignId ?? null],
      )).map(sendFrom);
    },
    async eventsFor(sendIds) {
      if (sendIds.length === 0) return [];
      return (await q("select send_id, type, recipient_hash, detail from email_event where send_id = any($1::uuid[]) order by at", [sendIds]))
        .map((r: any): CountableEvent => ({ sendId: r.send_id, type: r.type, recipientHash: r.recipient_hash, detail: r.detail }));
    },
  };
}
