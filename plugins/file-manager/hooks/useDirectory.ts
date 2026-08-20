// hooks/useDirectory.ts — one directory listing, kept fresh.
//
// Owns three things (§8.1):
//   * the `listDir` request, including the stale-response guard that a fast
//     click-through of folders needs;
//   * the `fs` realtime channel — refetch when the current directory is named
//     in a signal, and once more whenever the connection comes back, because
//     signals published while disconnected are lost (§7.3);
//   * the sort/filter memo, which is pure client-side work: changing the sort
//     column or typing in the search box must never issue an RPC.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";

import { FS_CHANNEL, type FileEntry, type Preferences } from "../contract";
import { parseRpcError, type ParsedRpcError } from "../lib/errors";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import { isSamePath } from "../lib/fm-paths";

export type ListDirResult = RpcOutput<"listDir">;
/** Re-exported from the frozen contract so both sides cannot drift. */
export type SortField = Preferences["sortField"];
export type SortDirection = Preferences["sortDirection"];

const KIND_ORDER: Record<FileEntry["kind"], number> = {
  directory: 0,
  file: 1,
  symlink: 2,
  other: 3,
};

/** Directories sort before files unless the caller opts out. */
export interface SortOptions {
  foldersFirst?: boolean;
}

function effectiveKind(entry: FileEntry): FileEntry["kind"] {
  if (entry.isSymlink && !entry.escapesRoot && entry.targetKind !== null) return entry.targetKind;
  return entry.kind;
}

function compareNames(a: FileEntry, b: FileEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

/** Pure and exported so the table header and tests can use it directly. */
export function sortEntries(
  entries: readonly FileEntry[],
  field: SortField,
  direction: SortDirection,
  options: SortOptions = {},
): FileEntry[] {
  const foldersFirst = options.foldersFirst ?? true;
  const sign = direction === "desc" ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (foldersFirst) {
      const aDir = effectiveKind(a) === "directory" ? 0 : 1;
      const bDir = effectiveKind(b) === "directory" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
    }
    let result = 0;
    switch (field) {
      case "size":
        result = a.sizeBytes - b.sizeBytes;
        break;
      case "modified":
        result = a.modifiedAtMs - b.modifiedAtMs;
        break;
      case "kind":
        result = KIND_ORDER[effectiveKind(a)] - KIND_ORDER[effectiveKind(b)];
        break;
      default:
        result = compareNames(a, b);
        break;
    }
    if (result === 0 && field !== "name") result = compareNames(a, b);
    return result * sign;
  });
}

/** Case-insensitive substring match on the entry name (the search box). */
export function matchesQuery(entry: FileEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return entry.name.toLowerCase().includes(needle);
}

export interface UseDirectoryArgs {
  /** Absolute directory path. */
  path: string;
  showHidden: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  /** Client-side filter from the search box; "" disables filtering. */
  query?: string;
  foldersFirst?: boolean;
  /** Skip the request entirely (e.g. while `getState` is still loading). */
  enabled?: boolean;
}

export interface UseDirectoryResult {
  /** The path this result belongs to. */
  path: string;
  data: ListDirResult | null;
  /** Sorted and filtered rows to render. */
  entries: FileEntry[];
  /** Row paths in render order — what `useSelection` wants. */
  visiblePaths: string[];
  /** True only while there is nothing to show yet. */
  isLoading: boolean;
  /** True while a background refresh is in flight over existing data. */
  isRefetching: boolean;
  error: ParsedRpcError | null;
  refetch: () => void;
}

export function useDirectory(args: UseDirectoryArgs): UseDirectoryResult {
  const {
    path,
    showHidden,
    sortField,
    sortDirection,
    query = "",
    foldersFirst = true,
    enabled = true,
  } = args;
  const rpc = useFmRpc();

  const [data, setData] = useState<ListDirResult | null>(null);
  const [error, setError] = useState<ParsedRpcError | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefetching, setIsRefetching] = useState(false);

  // Only the newest request may write state; folder click-through is faster
  // than a cold `listDir` on a large tree.
  const requestId = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (target: string, hidden: boolean, background: boolean): Promise<void> => {
      const ticket = (requestId.current += 1);
      if (background) setIsRefetching(true);
      else setIsLoading(true);
      try {
        const result = await rpc.call("listDir", { path: target, showHidden: hidden });
        if (!mounted.current || ticket !== requestId.current) return;
        setData(result);
        setError(null);
      } catch (failure) {
        if (!mounted.current || ticket !== requestId.current) return;
        setError(parseRpcError(failure));
        if (!background) setData(null);
      } finally {
        if (mounted.current && ticket === requestId.current) {
          setIsLoading(false);
          setIsRefetching(false);
        }
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load(path, showHidden, false);
  }, [enabled, load, path, showHidden]);

  const refetch = useCallback(() => {
    if (!enabled) return;
    void load(path, showHidden, true);
  }, [enabled, load, path, showHidden]);

  // Refs so the realtime subscription can stay identity-stable while still
  // seeing the current directory.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const pathRef = useRef(path);
  pathRef.current = path;

  useRealtime(
    FS_CHANNEL,
    useCallback((payload: unknown) => {
      const paths = (payload as { paths?: unknown } | null)?.paths;
      if (!Array.isArray(paths)) return;
      const current = pathRef.current;
      const touched = paths.some(
        (candidate) => typeof candidate === "string" && isSamePath(candidate, current),
      );
      if (touched) refetchRef.current();
    }, []),
  );

  // §7.3: signals published while the socket was down are gone, so a reconnect
  // is itself a reason to refetch.
  const connectionState = useRealtimeConnectionState();
  const previousConnection = useRef(connectionState);
  useEffect(() => {
    if (connectionState === "connected" && previousConnection.current !== "connected") {
      refetchRef.current();
    }
    previousConnection.current = connectionState;
  }, [connectionState]);

  const entries = useMemo(() => {
    const source = data?.entries ?? [];
    const filtered = query.trim() === "" ? source : source.filter((e) => matchesQuery(e, query));
    return sortEntries(filtered, sortField, sortDirection, { foldersFirst });
  }, [data, query, sortField, sortDirection, foldersFirst]);

  const visiblePaths = useMemo(() => entries.map((entry) => entry.path), [entries]);

  return {
    path,
    data,
    entries,
    visiblePaths,
    isLoading,
    isRefetching,
    error,
    refetch,
  };
}
