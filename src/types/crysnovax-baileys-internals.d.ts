declare module "plogme/lib/Utils/auth-utils.js" {
  export function makeCacheableSignalKeyStore(
    store: {
      get: (
        type: string,
        ids: string[],
      ) => Promise<Record<string, unknown>>;
      set: (
        data: Record<string, Record<string, unknown>>,
      ) => Promise<unknown>;
    },
    logger?: unknown,
  ): {
    get: (
      type: string,
      ids: string[],
    ) => Promise<Record<string, unknown>>;
    set: (
      data: Record<string, Record<string, unknown>>,
    ) => Promise<unknown>;
    clear?: () => Promise<void>;
  };
}
