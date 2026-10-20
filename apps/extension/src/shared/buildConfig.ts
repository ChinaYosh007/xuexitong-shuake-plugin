declare const __BUILD_BACKEND_ORIGIN__: string;

/** Backend Origin injected by scripts/build-extension.mjs; used as the default for options/side panel. */
export const BUILD_BACKEND_ORIGIN: string =
  typeof __BUILD_BACKEND_ORIGIN__ === "string" && __BUILD_BACKEND_ORIGIN__.length > 0
    ? __BUILD_BACKEND_ORIGIN__
    : "http://127.0.0.1:8080";
