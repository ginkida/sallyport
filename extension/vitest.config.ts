import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Coverage is gated only on the chrome-API-free units below. The
      // chrome-bound tool implementations (tools/dom.ts, fetch.ts,
      // evaluate.ts, keyboard.ts, upload.ts, …), background.ts, and
      // popup.ts need a chrome mock to test, so they sit outside this gate.
      // Their *security gates* ARE unit-tested here (tools/gates.ts: allowlist
      // + evaluate opt-in; tools/refs.ts: per-tab isolation), and the daemon's
      // pytest e2e harness exercises the wire end-to-end (handshake, HMAC,
      // tool_call round-trip via snapshot/click/list_tabs). The tool bodies
      // themselves are validated manually via `sallyport-daemon exec <tool>`
      // (README §B). Per-file thresholds pin the quality of what we test
      // instead of inflating global numbers with untested files.
      include: [
        'src/protocol.ts',
        'src/crypto.ts',
        'src/allowlist.ts',
        'src/storage.ts',
        'src/bridge-connection.ts',
        'src/tools/refs.ts',
        'src/tools/gates.ts',
        'src/tools/errors.ts',
        'src/tools/ownership.ts',
      ],
      thresholds: {
        'src/protocol.ts': {
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
        },
        'src/crypto.ts': {
          lines: 90,
          branches: 85,
          functions: 80,
          statements: 90,
        },
        'src/allowlist.ts': {
          lines: 95,
          branches: 90,
          functions: 95,
          statements: 95,
        },
        'src/storage.ts': {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90,
        },
        'src/bridge-connection.ts': {
          // The 'open' handler's error catch and a couple of defensive
          // branches are hard to hit without a contrived signer mock —
          // we tolerate 85/75 here and pin the public-facing paths.
          lines: 85,
          branches: 75,
          functions: 90,
          statements: 85,
        },
        'src/tools/refs.ts': {
          lines: 95,
          branches: 90,
          functions: 100,
          statements: 95,
        },
        'src/tools/gates.ts': {
          lines: 95,
          branches: 90,
          functions: 100,
          statements: 95,
        },
        'src/tools/errors.ts': {
          lines: 80,
          branches: 100,
          functions: 100,
          statements: 80,
        },
        'src/tools/ownership.ts': {
          lines: 95,
          branches: 90,
          functions: 95,
          statements: 95,
        },
      },
    },
  },
});
