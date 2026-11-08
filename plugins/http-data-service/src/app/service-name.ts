// The panel's name in bb's sidebar. bb reads a panel's title once, when the plugin's frontend loads, and settings
// arrive later over RPC. So the name is remembered in the browser: the first session shows the generic title in the
// sidebar and the service name in the page header, every later one shows the service name everywhere.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";
import { setIconText } from "./icon";

const STORAGE_KEY = "http-data-service:service-name";
export const DEFAULT_TITLE = "Data Service";

export function rememberedTitle(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_TITLE;
  } catch {
    return DEFAULT_TITLE;
  }
}

/** The configured name, remembered for the next load. Null until the server answers. Also updates the sidebar icon. */
export function useServiceName(): string | null {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("config").then(
      (config) => {
        if (!live) return;
        setName(config.name);
        setIconText(config.iconText);
        try {
          localStorage.setItem(STORAGE_KEY, config.name);
        } catch {
          // Without storage the sidebar keeps the generic title; the page still shows the name.
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  return name;
}
