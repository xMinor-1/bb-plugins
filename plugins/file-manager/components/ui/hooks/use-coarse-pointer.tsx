import {
  createContext,
  createElement,
  useContext,
  type ReactNode,
} from "react";

import { useMediaQuery } from "./use-media-query.js";

export const COARSE_POINTER_QUERY = "(pointer: coarse)";

const CoarsePointerOverrideContext = createContext<boolean | null>(null);

interface CoarsePointerOverrideProviderProps {
  children: ReactNode;
  isCoarsePointer: boolean;
}

export function CoarsePointerOverrideProvider({
  children,
  isCoarsePointer,
}: CoarsePointerOverrideProviderProps) {
  return createElement(
    CoarsePointerOverrideContext.Provider,
    { value: isCoarsePointer },
    children,
  );
}

export function useIsCoarsePointer(): boolean {
  const override = useContext(CoarsePointerOverrideContext);
  const isCoarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  return override ?? isCoarsePointer;
}
