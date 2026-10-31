// The "Start agent" action in the right-hand side panel of every BrandWise page. The tab gets the page's route (`subPath`),
// so the agent it opens knows which page, and for the video page which project, the user is on.
import { useEffect, useState } from "react";
import { ThreadChat, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { Screen } from "./agents";
import type { rpcContract } from "./server";

export function ScreenAgentTab({ screen, subPath }: PluginNavPanelProps & { screen: Screen }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ key: string; threadId: string | null; error: string | null } | null>(null);
  const key = `${screen}:${subPath}`;
  useEffect(() => {
    let live = true;
    rpc.call("agent_thread", { screen, subPath, create: true }).then(
      (r) => live && setState({ key, threadId: r.threadId, error: null }),
      (cause) => live && setState({ key, threadId: null, error: cause instanceof Error ? cause.message : String(cause) }),
    );
    return () => { live = false; };
  }, [rpc, screen, subPath, key]);

  if (state?.key !== key) return <p className="p-4 text-sm text-muted-foreground">Starting the agent…</p>;
  if (state.error) return <p role="alert" className="p-4 text-sm text-destructive">{state.error}</p>;
  if (state.threadId === null) return <p className="p-4 text-sm text-muted-foreground">Open a project on this page first: the agent works on what you have open.</p>;
  return <ThreadChat key={state.threadId} threadId={state.threadId} variant="compact" />;
}
