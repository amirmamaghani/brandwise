// Test helper: removes everything a test created under a campaign-name prefix (children first, e-mail rows before calendar rows).
// Tests of one run share the database and run in parallel, so each uses a unique prefix and purges only that.
import type { createCore } from "./index.ts";

export async function purge(core: ReturnType<typeof createCore>, prefix: string): Promise<void> {
  const like = `${prefix}%`;
  const ids = "select id from campaign where name like $1";
  const run = (sql: string) => core.pool.query(sql, [like]);
  await run(`delete from regulator_state where campaign_id in (${ids})`);
  await run(`delete from experiment where campaign_id in (${ids})`);
  await run(`delete from email_event where send_id in (select s.id from email_send s join content_calendar c on c.id = s.entry_id where c.campaign_id in (${ids}))`);
  await run(`delete from email_send where entry_id in (select id from content_calendar where campaign_id in (${ids}))`);
  await run(`delete from content_calendar where campaign_id in (${ids})`);
  await run(`delete from asset where campaign_id in (${ids})`);
  await run("delete from campaign where name like $1 and parent_id is not null");
  await run("delete from campaign where name like $1");
}
