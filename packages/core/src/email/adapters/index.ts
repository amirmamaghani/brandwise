// The list of providers. A new provider is one adapter file plus one entry here.
import type { EmailProvider } from "../domain/ports.ts";
import type { Recipient } from "../domain/types.ts";
import { resendProvider } from "./resend.ts";

export type ProviderConfig = { recipient: (address: string) => Recipient; resendApiKey?: string; resendWebhookSecret?: string };

/** Providers that have credentials. */
export const providersFrom = (cfg: ProviderConfig): EmailProvider[] => [
  ...(cfg.resendApiKey ? [resendProvider({ apiKey: cfg.resendApiKey, webhookSecret: cfg.resendWebhookSecret || undefined, recipient: cfg.recipient })] : []),
];
