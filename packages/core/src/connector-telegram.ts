// Telegram connector: posts through the Bot API (https://core.telegram.org/bots/api). One bot token (plugin setting, TELEGRAM_BOT_TOKEN in .env);
// each campaign says where to post (`campaign channel set telegram chatId=@channel`): a channel (the bot must be its admin), a group,
// or a user who has started the bot. Chats are inherited from the parent campaign.
// shortcut: the Bot API has no idempotency key, so a crash between "sent" and "recorded" can post twice; fine for a first channel,
// move to a sent-marker table before high-volume use. Photos up to 10 MB and videos up to 50 MB (Bot API upload limits).
import type { Connector } from "./publish.ts";
import { campaignSlug, tagText, withUtm } from "./email/domain/render.ts";

const CAPTION_MAX = 1024;
const TEXT_MAX = 4096;
const MB = 1_000_000;

export function telegram(opts: { token: string; fetchImpl?: typeof fetch }): Connector {
  const call = async (method: string, body: FormData | Record<string, unknown>) => {
    const isForm = body instanceof FormData;
    const res = await (opts.fetchImpl ?? fetch)(`https://api.telegram.org/bot${opts.token}/${method}`, {
      method: "POST",
      ...(isForm ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.ok !== true) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result as { message_id: number; chat: { id: number; username?: string } };
  };

  return {
    id: "telegram",
    channels: ["telegram"],
    targetHint: "bb brandwise campaign channel set telegram chatId=<@channel | numeric chat id>",
    async publish({ entry, asset, target }) {
      const chatId = target?.chatId;
      if (!chatId) throw new Error("No chatId in the campaign's telegram target");
      // links carry the entry (utm_content), so a visit or a lead from the post is traced back to it (docs/analytics.md D6)
      const utm = { entryId: entry.id, campaign: campaignSlug(entry.campaignName), medium: "messenger", source: "telegram" };
      const text = [tagText(entry.body.trim(), utm), entry.link ? withUtm(entry.link, utm) : ""].filter(Boolean).join("\n\n");
      if (text === "" && !asset) throw new Error("Entry has no text and no creative to post");
      let sent;
      if (asset && (asset.kind === "image" || asset.kind === "video")) {
        const video = asset.kind === "video";
        if (asset.bytes > (video ? 50 : 10) * MB) throw new Error(`${asset.name} is too large for Telegram (${video ? "50" : "10"} MB limit)`);
        const form = new FormData();
        form.set("chat_id", chatId);
        form.set(video ? "video" : "photo", new Blob([(await asset.read()).slice()], { type: asset.mime }), asset.name);
        const inCaption = text.length > 0 && text.length <= CAPTION_MAX;
        if (inCaption) form.set("caption", text);
        sent = await call(video ? "sendVideo" : "sendPhoto", form);
        if (text.length > CAPTION_MAX) await call("sendMessage", { chat_id: chatId, text: text.slice(0, TEXT_MAX) }); // too long for a caption: follows as its own message
      } else {
        if (text.length > TEXT_MAX) throw new Error(`Text is ${text.length} characters, Telegram allows ${TEXT_MAX}`);
        sent = await call("sendMessage", { chat_id: chatId, text });
      }
      return { externalId: `${sent.chat.id}:${sent.message_id}`, url: sent.chat.username ? `https://t.me/${sent.chat.username}/${sent.message_id}` : undefined };
    },
  };
}
