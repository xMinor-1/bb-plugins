import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../server";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
