import type { Counts } from "./types.ts";
import type { CountableEvent } from "./ports.ts";

export const emptyCounts = (): Counts => ({
  sent: 0, delivered: 0, deferred: 0, dropped: 0, suppressed: 0, failed: 0,
  bounced: { hard: 0, soft: 0, unknown: 0 },
  opened: { total: 0, unique: 0, humanUnique: 0 },
  clicked: { total: 0, unique: 0, perLink: {} },
  unsubscribed: 0, complained: 0,
});

/**
 * Counts from events. "Unique" is decided here, not by the provider: one recipient counts once per send, so the numbers mean
 * the same whichever provider delivered the e-mail. Delivery-type events count once per recipient and send too (a retry or a
 * duplicate webhook must not double them); opens and clicks also keep their totals.
 */
export function eventsToCounts(events: CountableEvent[]): Counts {
  const c = emptyCounts();
  const seen = new Set<string>();
  const first = (kind: string, e: CountableEvent, extra = "") => {
    const key = `${kind}|${e.sendId}|${e.recipientHash}|${extra}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const e of events) {
    switch (e.type) {
      case "sent": if (first("sent", e)) c.sent++; break;
      case "delivered": if (first("delivered", e)) c.delivered++; break;
      case "deferred": if (first("deferred", e)) c.deferred++; break;
      case "dropped": if (first("dropped", e)) c.dropped++; break;
      case "suppressed": if (first("suppressed", e)) c.suppressed++; break;
      case "failed": if (first("failed", e)) c.failed++; break;
      case "unsubscribed": if (first("unsubscribed", e)) c.unsubscribed++; break;
      case "complained": if (first("complained", e)) c.complained++; break;
      case "bounced":
        if (first("bounced", e)) c.bounced[e.detail.bounceClass ?? "unknown"]++;
        break;
      case "opened":
        c.opened.total++;
        if (first("opened", e)) c.opened.unique++;
        if (e.detail.machine === false && first("opened-human", e)) c.opened.humanUnique++;
        break;
      case "clicked": {
        c.clicked.total++;
        if (first("clicked", e)) c.clicked.unique++;
        if (e.detail.link) {
          const l = (c.clicked.perLink[e.detail.link] ??= { total: 0, unique: 0 });
          l.total++;
          if (first("clicked-link", e, e.detail.link)) l.unique++;
        }
        break;
      }
      default: break;
    }
  }
  return c;
}

export function addCounts(a: Counts, b: Counts): Counts {
  const perLink: Counts["clicked"]["perLink"] = {};
  for (const src of [a.clicked.perLink, b.clicked.perLink]) {
    for (const [k, v] of Object.entries(src)) {
      const t = (perLink[k] ??= { total: 0, unique: 0 });
      t.total += v.total;
      t.unique += v.unique;
    }
  }
  return {
    sent: a.sent + b.sent, delivered: a.delivered + b.delivered, deferred: a.deferred + b.deferred, dropped: a.dropped + b.dropped,
    suppressed: a.suppressed + b.suppressed, failed: a.failed + b.failed,
    bounced: { hard: a.bounced.hard + b.bounced.hard, soft: a.bounced.soft + b.bounced.soft, unknown: a.bounced.unknown + b.bounced.unknown },
    opened: { total: a.opened.total + b.opened.total, unique: a.opened.unique + b.opened.unique, humanUnique: a.opened.humanUnique + b.opened.humanUnique },
    clicked: { total: a.clicked.total + b.clicked.total, unique: a.clicked.unique + b.clicked.unique, perLink },
    unsubscribed: a.unsubscribed + b.unsubscribed, complained: a.complained + b.complained,
  };
}
