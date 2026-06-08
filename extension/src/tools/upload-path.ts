import { BridgeError } from './errors.js';

/** Reject anything that isn't a single absolute path with no `..` segments.
 *
 * Chrome's debugger reads these files from the user's filesystem. Keeping
 * the surface small means an agent can't accidentally hand over
 * `../../etc/passwd`-style paths. The typical safe flow is:
 * fetch_in_page → save_to_file → upload from `~/Downloads/sallyport/`.
 *
 * Kept in a chrome-free module so it can be unit-tested under vitest. */
export function validatePath(p: unknown): string {
  if (typeof p !== 'string' || !p) {
    throw new BridgeError('bad_args', 'upload: each path must be a non-empty string');
  }
  const isPosixAbs = p.startsWith('/');
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(p);
  if (!isPosixAbs && !isWinAbs) {
    throw new BridgeError('bad_args', `upload: path must be absolute: ${p}`);
  }
  if (p.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new BridgeError('unsafe_path', `upload: path contains '..': ${p}`);
  }
  return p;
}
