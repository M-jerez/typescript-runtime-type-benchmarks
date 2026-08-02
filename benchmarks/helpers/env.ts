/**
 * Read an env var without assuming a Node-shaped global.
 *
 * `process` exists in Node and Bun, and in Deno under its node compatibility
 * layer, but reading it unguarded would throw where it does not. `globalThis`
 * is avoided deliberately: this package's lint config targets Node >= 8, where
 * it does not exist.
 */
export function readEnv(name: string): string | undefined {
  if (typeof process === 'undefined') {
    return undefined;
  }

  return process.env?.[name];
}

/** An opt-out flag: on unless explicitly set to `0`. */
export function envEnabled(name: string): boolean {
  return readEnv(name) !== '0';
}
