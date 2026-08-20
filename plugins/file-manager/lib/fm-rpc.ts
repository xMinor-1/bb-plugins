// lib/fm-rpc.ts — the typed RPC surface every panel component uses.
//
// Two jobs:
//   1. Pin `useRpc()` to the frozen contract so method names, inputs and
//      outputs are checked at compile time.
//   2. Normalize rejections into `FileManagerRpcError`, so callers can branch
//      on `error.code` ("exists", "not_found", …) instead of string-matching
//      the message (§4.1, §13).
//
// The returned object is referentially stable for the lifetime of the
// component, which matters because it ends up in `useEffect` and `useCallback`
// dependency arrays all over the panel.
import { useMemo, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginRpcCallArgs,
  PluginRpcClient,
  PluginRpcResult,
} from "@get-bb/plugin-sdk/app";

import type { FileManagerContract } from "../contract";
import { toFileManagerError } from "./errors";

export type FileManagerRpcMethod = Extract<keyof FileManagerContract, string>;
export type FileManagerRpcClient = PluginRpcClient<FileManagerContract>;

/** Input value of one RPC method, as the caller passes it (pre-defaults). */
export type RpcInput<M extends FileManagerRpcMethod> =
  PluginRpcCallArgs<FileManagerContract[M]>[0];
/** Resolved value of one RPC method. */
export type RpcOutput<M extends FileManagerRpcMethod> = PluginRpcResult<FileManagerContract[M]>;

export interface FileManagerRpc {
  /** Same shape as `useRpc().call`, but rejects with `FileManagerRpcError`. */
  call<M extends FileManagerRpcMethod>(
    method: M,
    ...args: PluginRpcCallArgs<FileManagerContract[M]>
  ): Promise<RpcOutput<M>>;
  /** The unwrapped client, for the rare caller that wants the raw rejection. */
  raw: FileManagerRpcClient;
}

/** Wraps any contract-typed client; exported so tests can wrap a stub. */
export function wrapRpc(client: FileManagerRpcClient): FileManagerRpc {
  return {
    raw: client,
    async call<M extends FileManagerRpcMethod>(
      method: M,
      ...args: PluginRpcCallArgs<FileManagerContract[M]>
    ): Promise<RpcOutput<M>> {
      try {
        return await client.call(method, ...args);
      } catch (error) {
        throw toFileManagerError(error);
      }
    },
  };
}

export function useFmRpc(): FileManagerRpc {
  const client = useRpc<FileManagerContract>();
  // The host may hand back a fresh client object on every render; routing
  // through a ref keeps the wrapper's identity stable regardless.
  const clientRef = useRef(client);
  clientRef.current = client;

  return useMemo(() => {
    const stable: FileManagerRpcClient = {
      call<M extends FileManagerRpcMethod>(
        method: M,
        ...args: PluginRpcCallArgs<FileManagerContract[M]>
      ): Promise<RpcOutput<M>> {
        return clientRef.current.call(method, ...args);
      },
    };
    return wrapRpc(stable);
  }, []);
}
