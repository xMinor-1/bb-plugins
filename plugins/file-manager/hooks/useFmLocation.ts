// hooks/useFmLocation.ts — where "the folder on screen" is stored.
//
// The nav panel keeps it in the route (`/plugins/file-manager/files/<subPath>`),
// so browser back/forward walks the folder history and a link can be shared.
// A panel tab has no route of its own — the host owns that surface — so it
// keeps the same value in component state instead. Both shapes answer the one
// question the panel asks ("which folder, and how do I move to another one"),
// which is why `FileManagerSurface` takes a location rather than a `subPath`.
import { useCallback, useMemo, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { PANEL_PATH } from "../contract";

export interface FmLocation {
  /** Root-relative path of the folder on screen; "" is the root itself. */
  subPath: string;
  /**
   * Move to another folder. `replace` means "the user did not ask for this"
   * (the bootstrap redirect), and it must not leave a history entry where a
   * history exists.
   */
  navigate(subPath: string, options?: { replace?: boolean }): void;
}

/** Nav panel flavour: the route is the state. */
export function useRouteLocation(subPath: string): FmLocation {
  const navigate = useBbNavigate();
  // The host hands a fresh `navigate` object every render; the callback below
  // is handed to memoized panel code, so it reads through a ref instead of
  // taking the object as a dependency.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const go = useCallback((next: string, options?: { replace?: boolean }) => {
    navigateRef.current.toPluginPanel(PANEL_PATH, {
      subPath: next,
      ...(options?.replace === true ? { replace: true } : {}),
    });
  }, []);

  return useMemo(() => ({ subPath, navigate: go }), [go, subPath]);
}

/**
 * Panel-tab flavour: the state is the state.
 *
 * `replace` is accepted and ignored — there is no history to replace an entry
 * in, and the bootstrap redirect must still land.
 */
export function useLocalLocation(initialSubPath = ""): FmLocation {
  const [subPath, setSubPath] = useState(initialSubPath);
  const go = useCallback((next: string) => {
    setSubPath(next);
  }, []);

  return useMemo(() => ({ subPath, navigate: go }), [go, subPath]);
}
