// Screen agents: every BrandWise page can start one bb thread that knows which page (and, where the route says so, which
// project) the user is looking at. To give a new page an agent, add it to SCREENS and, if it needs more than the page name,
// a context function (see `video.agentContext`).
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Core } from "./core/index.ts";

export const SCREENS = ["calendar", "creatives", "campaigns", "video"] as const;
export type Screen = (typeof SCREENS)[number];

export const agentContract = {
  /** The agent thread of a page (and of its subject, e.g. a video project); `create` starts it when there is none. */
  agent_thread: {
    input: z.object({ screen: z.enum(SCREENS), subPath: z.string().max(300), create: z.boolean() }),
    output: z.object({ threadId: z.string().nullable() }),
  },
};

/** What a screen agent works on: a stable key (one thread per key), an optional working folder and campaign, and its briefing. */
export type AgentSpec = { key: string; cwd: string | null; campaignId: string | null; prompt: string };

const COMMON = [
  "Si agent BrandWise. Pracuješ cez CLI `bb brandwise` podľa skillu brandwise.",
  "Agenti nikdy neschvaľujú obsah ani nepublikujú: všetko ide cez kalendár a schvaľuje človek. Vytvorené kreatívy ukazuj v chate cez ::creative{ids=\"...\"}.",
].join(" ");
const WAIT = "Teraz si len pozri aktuálny stav, jednou vetou povedz, čo vidíš, a čakaj na pokyny.";

const PAGE_BRIEF: Record<Exclude<Screen, "video">, string> = {
  calendar: "Používateľ je na obrazovke Calendar (plán obsahu: príspevky, e-maily, stránky a ich schvaľovanie). Pomáhaš plánovať a upravovať záznamy kalendára (`bb brandwise calendar ...`).",
  creatives: "Používateľ je na obrazovke Creatives (knižnica obrázkov a videí kampaní). Pomáhaš s kreatívami: generovanie (`creative generate`), nahrávanie, premenovanie a stav (`assets ...`).",
  campaigns: "Používateľ je na obrazovke Campaigns (kampane, ich vlákna, kalendár a kreatívy). Pomáhaš zakladať a spravovať kampane (`bb brandwise campaign ...`). Ak kampaň (základ) nemá produktový balík (`product list`), ponúkni sprievodcu: použi skill product-onboarding.",
};

export function createAgents(deps: {
  bb: BbPluginApi;
  need: () => Core;
  /** Context of the video screen; `subPath` is "<campaign id>/<project id>" once a project is open. */
  video: (subPath: string) => Promise<AgentSpec | null>;
  assignThread: (threadId: string, campaignId: string) => Promise<void>;
}) {
  const { bb } = deps;

  async function spec(screen: Screen, subPath: string): Promise<AgentSpec | null> {
    if (screen === "video") return deps.video(subPath);
    return { key: screen, cwd: null, campaignId: null, prompt: [COMMON, PAGE_BRIEF[screen], WAIT].join("\n\n") };
  }

  /** First entry of a bb list result, which is an array or an object holding one. */
  async function first(list: Promise<unknown>, what: string): Promise<{ id: string }> {
    const res: any = await list;
    const item = (Array.isArray(res) ? res : Object.values(res).find(Array.isArray))?.[0];
    if (!item) throw new Error(`This bb instance has no ${what} to start the agent on`);
    return item;
  }

  async function thread(screen: Screen, subPath: string, create: boolean): Promise<string | null> {
    const s = await spec(screen, subPath);
    if (s === null) return null; // nothing to work on yet, e.g. the video page without a project
    const key = `agent:${s.key}`;
    const known = await bb.storage.kv.get<string>(key);
    if (known || !create) return known ?? null;
    const project = await first(bb.sdk.projects.list(), "project");
    const environment = s.cwd === null
      ? { type: "project-default" }
      : { type: "host", hostId: (await first(bb.sdk.hosts.list(), "machine")).id, workspace: { type: "unmanaged", path: s.cwd } };
    const created: any = await bb.sdk.threads.spawn({ projectId: project.id, prompt: s.prompt, environment } as never);
    if (s.campaignId) await deps.assignThread(created.id, s.campaignId);
    await bb.storage.kv.set(key, created.id);
    return created.id;
  }

  return { agent_thread: async ({ screen, subPath, create }: z.infer<(typeof agentContract)["agent_thread"]["input"]>) => ({ threadId: await thread(screen, subPath, create) }) };
}
