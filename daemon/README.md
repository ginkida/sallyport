# sallyport

The Python MCP-server half of **[Sallyport](https://github.com/ginkida/sallyport)** —
a security-first bridge between Claude Code (or any MCP client) and your Chrome,
with explicit trust boundaries instead of implicit ones.

```
Claude Code ── MCP/stdio ──▶ daemon (this package) ── WS+HMAC ──▶ extension (MV3) ── CDP ──▶ Chrome
```

The daemon speaks MCP on stdio and hosts an HMAC-authenticated WebSocket server
on `127.0.0.1:10086` that the companion Chrome extension connects into. Every
frame is signed (HMAC-SHA256 + timestamp + nonce); the extension enforces a
per-domain allowlist and a per-domain opt-in for arbitrary JS.

## Install

```sh
pip install sallyport
```

The package installs the `sallyport-daemon` console command.

## Quickstart

```sh
sallyport-daemon doctor          # check Python, secret file + perms, port; print the pairing block
claude mcp add sallyport sallyport-daemon   # register with Claude Code
```

Then load the unpacked extension (or the release zip) from the
[main repository](https://github.com/ginkida/sallyport) and paste the pairing
block into its popup.

- `sallyport-daemon list-tools` — print the tool catalogue (no daemon start)
- `sallyport-daemon serve` — WS-only mode (no MCP) for wire testing
- `sallyport-daemon exec <tool> k=v …` — fire one tool from the shell

## Security

The full threat model, the load-bearing invariants, and known limitations live
in [SECURITY.md](https://github.com/ginkida/sallyport/blob/main/SECURITY.md).
In short: loopback-only bind, HMAC on every frame, a domain allowlist enforced
in the extension, per-domain `evaluate` opt-in, password-field gates, and
daemon-side filesystem sandboxes for `upload`/`save_to_file`.

## License

MIT — see [LICENSE](https://github.com/ginkida/sallyport/blob/main/LICENSE).
