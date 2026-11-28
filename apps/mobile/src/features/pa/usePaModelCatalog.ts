import {
  createPaModelCatalogCache,
  type PaModelCatalogEntry,
  type PaModelCatalogKey,
} from "@t3tools/client-runtime/pa/models";
import { useSyncExternalStore } from "react";

import { paClient } from "./paApi";

/** The composer's model control and the model sheet read one catalog per Bot and session. */
export const paModelCatalogs = createPaModelCatalogCache((key) =>
  paClient(key.environmentId).getBotModels(key.botId, key.sessionId),
);

const NO_CATALOG: PaModelCatalogEntry = { catalog: null, loading: false, error: null };

export function usePaModelCatalog(key: PaModelCatalogKey | null): PaModelCatalogEntry {
  return useSyncExternalStore(paModelCatalogs.subscribe, () =>
    key ? paModelCatalogs.read(key) : NO_CATALOG,
  );
}
