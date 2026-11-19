# Self-hosting

```sh
CLOVER_DOMAIN=clover.example.com CLOVER_SCHEME=https CLOVER_PUBLIC_PORT=443 \
CLOVER_DATA_DIR=/var/lib/clover deno task start
```

Needs wildcard DNS (`*.clover.example.com` + `clover.example.com` → server) and TLS in front, e.g. Caddy:

```
clover.example.com, *.clover.example.com {
  tls { dns cloudflare {env.CF_API_TOKEN} }
  reverse_proxy localhost:8787
}
```

| Env | Default | |
|---|---|---|
| `PORT` | 8787 | listen port |
| `CLOVER_DOMAIN` | localhost | apps at `<name>.<domain>` |
| `CLOVER_SCHEME` / `CLOVER_PUBLIC_PORT` | http / PORT | used in generated URLs |
| `CLOVER_DATA_DIR` | ./data | metadata + app data |
| `CLOVER_SOCK_DIR` | /tmp/clover-sock | sandbox sockets (keep path short) |
| `CLOVER_DENO` | current deno | binary used for sandboxes |
| `CLOVER_OPEN_SIGNUP` | true | allow `POST /v1/accounts` |
| `CLOVER_MAX_DEPLOY_MB` / `_FILES` / `CLOVER_MAX_SERVER_MB` | 25 / 2000 / 5 | |
| `CLOVER_REQUEST_TIMEOUT_MS` | 30000 | |
| `CLOVER_APP_MEMORY_MB` | 256 | V8 heap cap |
| `CLOVER_IDLE_MS` | 300000 | stop idle sandboxes |
| `CLOVER_ANON_TTL_HOURS` | 72 | unclaimed app lifetime |

`*.localhost` resolves to 127.0.0.1 in browsers and curl, so local dev needs no DNS setup.

v1 caveats: signup has no email verification; secrets stored plaintext in `clover.db`; one server process (no horizontal scaling). See [architecture.md](architecture.md#roadmap).
