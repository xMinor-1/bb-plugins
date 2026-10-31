import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";

import type { Card, rpcContract } from "../server";

export type CardsRpc = PluginRpcClient<typeof rpcContract>;

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The board's cards, refetched on every "cards-changed" signal and after a reconnect. */
export function useCards() {
  const rpc = useRpc<typeof rpcContract>();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("cards_list").then(
      (result) => {
        setCards(result.cards);
        setError(null);
      },
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("cards-changed", refetch);
  // Signals are not replayed after a reconnect: read the list again.
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refetch();
  }, [connection, refetch]);
  return { rpc, cards, error, refetch };
}
