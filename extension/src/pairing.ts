// Heuristic extraction of a base64 HMAC secret from free-form text — the
// user typically pastes the daemon's multi-line onboarding banner
// (`======` rule lines + prose + the secret on an indented line) and we
// pluck the secret out so they don't have to.

const MIN_SECRET_BYTES = 16;

/** Extracted candidate plus what we recovered from it. `bytes` matches the
 * length the signer will see after `decodeSecret`. */
export type SecretCandidate = {
  token: string;
  bytes: number;
};

/**
 * Scan text for the most plausible base64 secret. Returns the decoded-byte
 * length so the UI can show feedback. `null` when nothing matches.
 *
 * Why a heuristic and not a single regex: the daemon banner contains
 * `====` rule lines (base64 padding-only — invalid), file paths
 * (alphanumerics + slashes — could pass a naive regex), and the secret
 * itself. We tokenize on whitespace and pick the strongest candidate by
 * decoded length; the 32-byte secret beats anything incidental.
 */
export function extractSecret(text: string): SecretCandidate | null {
  const tokens = text.split(/\s+/).filter(Boolean);
  let best: SecretCandidate | null = null;
  for (const t of tokens) {
    const cand = tryToken(t);
    if (!cand) continue;
    if (!best || cand.bytes > best.bytes) best = cand;
  }
  return best;
}

function tryToken(token: string): SecretCandidate | null {
  // Canonical base64: groups of 4, at most 2 trailing '='. We accept '+' and
  // '/' (standard alphabet — what the daemon uses); url-safe alphabet
  // ('-', '_') would need a separate path but the daemon never emits it.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return null;
  if (token.length < 4 || token.length % 4 !== 0) return null;
  let decoded: string;
  try {
    decoded = atob(token);
  } catch {
    return null;
  }
  if (decoded.length < MIN_SECRET_BYTES) return null;
  return { token, bytes: decoded.length };
}
