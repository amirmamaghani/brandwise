// Display modes of the BrandWise plugin. A mode is DATA: add an entry to MODES and it shows up in the
// plugin setting, the CLI and the engine; no other code changes. The engine (applyMode) owns "undo":
// it records what it changed and reverts exactly that when another mode is selected.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type ModeDef = {
  label: string;
  description: string;
  /** Bundled bb plugins switched off while this mode is active. Never list "brandwise". */
  disablePlugins: string[];
  /** bb UI preferences (`bb settings ui list` shows the keys) set while this mode is active, reset after. */
  uiPreferences: Record<string, unknown>;
  /** CSS injected into the app, for host UI that has neither a plugin nor a preference to switch it off. */
  css: string;
};

export const MODES = {
  full: {
    label: "Full",
    description: "Everything bb ships.",
    disablePlugins: [],
    // null = every navigation destination shown. Set explicitly because bb keeps an allow-list there that goes stale
    // (it still named a panel we renamed), which would hide new pages.
    uiPreferences: { "sidebar.visiblePluginPanels": null },
    css: "",
  },
  minimal: {
    label: "Minimal",
    description: "Marketing only: hides bb's account, remote access, git, code editor, other agent providers and promo surfaces.",
    // Off while Minimal is active (bundled plugins; Full brings back exactly the ones it switched off):
    //  bb-account, connect      getbb.app account and remote access
    //  bb--git, bb--github-pr-status, monaco-editor, agent-annotations   developer tooling
    //  provider-codex, provider-pi, provider-acp   we run Claude Code only
    // Kept on purpose: provider-claude-code, environment-*, automations, workflows, secrets, ask-user-question,
    // browser-automation, inline-vis, bb-guide (agent skills), bb-ai (cloud titles, voice), push-notifications.
    disablePlugins: [
      "bb-account", "connect",
      "bb--git", "bb--github-pr-status", "monaco-editor", "agent-annotations",
      "provider-codex", "provider-pi", "provider-acp",
    ],
    uiPreferences: {
      // Footer built-ins are keyed builtin:<id>; hidden ones move into the More menu. "settings" stays.
      "sidebar.hiddenFooterItems": ["builtin:report-bug", "builtin:mobile"],
      // Navigation destinations that stay: new thread, search, automations and our two pages. Plugins and Skills go.
      "sidebar.visiblePluginPanels": [
        "__bb__/new-thread", "__bb__/search-threads", "__bb__/automations",
        "brandwise/calendar", "brandwise/creatives", "brandwise/campaigns", "brandwise/video", "brandwise/email",
      ],
    },
    css: "",
  },
} satisfies Record<string, ModeDef>;

export type ModeName = keyof typeof MODES;
export const MODE_NAMES = Object.keys(MODES) as [ModeName, ...ModeName[]];
export const isModeName = (v: string): v is ModeName => v in MODES;

/**
 * Modes the operator allows, from BW_MODES (comma list, read when the bb server starts).
 * Unset or empty means all modes; unknown names are ignored. One entry means the mode is locked.
 */
export function allowedModes(env: Record<string, string | undefined> = process.env): ModeName[] {
  const listed = (env.BW_MODES ?? "").split(",").map((v) => v.trim()).filter(isModeName);
  return listed.length > 0 ? [...new Set(listed)] : [...MODE_NAMES];
}

/** `defHash` fingerprints the mode definition, so editing MODES re-applies it; `uiPrev` holds the values we overwrote. */
type ModeState = { mode: ModeName; defHash: string; disabledByUs: string[]; uiKeys: string[]; uiPrev: Record<string, unknown> };
export const defHashOf = (name: ModeName) => createHash("sha1").update(JSON.stringify(MODES[name])).digest("hex").slice(0, 12);
const STATE_KEY = "mode_state";
const EMPTY: ModeState = { mode: "full", defHash: "", disabledByUs: [], uiKeys: [], uiPrev: {} };

export async function appliedMode(bb: BbPluginApi): Promise<ModeState> {
  return (await bb.storage.kv.get<ModeState>(STATE_KEY)) ?? EMPTY;
}

/** Make the host match `wanted`. Idempotent; returns a human-readable list of what changed. */
export async function applyMode(bb: BbPluginApi, wanted: ModeName): Promise<string[]> {
  const prev = await appliedMode(bb);
  const def: ModeDef = MODES[wanted];
  const changes: string[] = [];

  const listed: any = await bb.sdk.plugins.list();
  const plugins: { id: string; enabled: boolean }[] = Array.isArray(listed) ? listed : listed.plugins;
  const enabled = new Map(plugins.map((p) => [p.id, p.enabled]));
  const disabledByUs = new Set(prev.disabledByUs);
  for (const id of def.disablePlugins) {
    if (id === "brandwise") continue;
    // only plugins that are on get recorded: one the user switched off by hand is not ours to switch back on
    if (enabled.get(id) === true) {
      await bb.sdk.plugins.disable({ pluginId: id });
      disabledByUs.add(id);
      changes.push(`disabled plugin ${id}`);
    }
  }
  for (const id of [...disabledByUs]) {
    if (def.disablePlugins.includes(id)) continue;
    await bb.sdk.plugins.enable({ pluginId: id });
    disabledByUs.delete(id);
    changes.push(`enabled plugin ${id}`);
  }

  const { preferences } = await bb.sdk.system.uiPreferences.list();
  const uiKeys = new Set(prev.uiKeys);
  const uiPrev: Record<string, unknown> = { ...prev.uiPrev };
  const prefs = preferences as Record<string, { revision: number; value: unknown }>;
  for (const [key, value] of Object.entries(def.uiPreferences)) {
    const current = prefs[key];
    if (current === undefined) throw new Error(`Unknown UI preference "${key}" in mode ${wanted}`);
    if (!uiKeys.has(key)) uiPrev[key] = current.value; // remember what was there before the first override
    if (JSON.stringify(current.value) !== JSON.stringify(value)) {
      await bb.sdk.system.uiPreferences.set({ key: key as never, value: value as never, expectedRevision: current.revision });
      changes.push(`set ${key}`);
    }
    uiKeys.add(key);
  }
  for (const key of [...uiKeys]) {
    if (key in def.uiPreferences) continue;
    const before = prefs[key];
    // put back what was there before we touched it; reset to the bb default only when we never recorded a value
    if (key in uiPrev && before !== undefined) {
      if (JSON.stringify(before.value) !== JSON.stringify(uiPrev[key])) {
        await bb.sdk.system.uiPreferences.set({ key: key as never, value: uiPrev[key] as never, expectedRevision: before.revision });
      }
    } else {
      await bb.sdk.system.uiPreferences.reset({ key: key as never });
    }
    delete uiPrev[key];
    uiKeys.delete(key);
    changes.push(`restored ${key}`);
  }

  await bb.storage.kv.set(STATE_KEY, { mode: wanted, defHash: defHashOf(wanted), disabledByUs: [...disabledByUs], uiKeys: [...uiKeys], uiPrev } satisfies ModeState);
  return changes;
}
