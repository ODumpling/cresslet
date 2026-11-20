#!/usr/bin/env bash
# End-to-end TLS check of deploy/compose.yaml: real ACME flows against Pebble (a test CA) and bind9.
#   wildcard *.cresslet.test via DNS-01, a verified custom domain via on-demand TLS, and an
#   unverified one refused by the control plane's ask endpoint. Needs Docker and Node; touches no real DNS.
set -euo pipefail
cd "$(dirname "$0")/.."
P=cresslet-acme-test
KEY=o3/lA6ITes+dU+yezlfMGzfrVggvIlfkRO0hHGWNSqw= # test-only TSIG key (test/named.conf)
tmp=$(mktemp -d)
export CRESSLET_DOMAIN=cresslet.test PEBBLE_MINICA="$tmp/minica.pem"
dc() { docker compose -p "$P" --env-file /dev/null -f compose.yaml -f test/compose.acme.yaml "$@"; } # not deploy/.env
cleanup() {
  [ "${ok:-}" = 1 ] || dc logs caddy cresslet | tail -60
  [ -n "${KEEP:-}" ] || dc down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

cid=$(docker create ghcr.io/letsencrypt/pebble:2.10.3)
docker cp -q "$cid:/test/certs/pebble.minica.pem" "$PEBBLE_MINICA"
docker rm -f "$cid" >/dev/null

dc up -d --build --wait --quiet-pull
# A client in the test network, resolving through the test DNS; trusts only Pebble's issuing root.
c() { docker run --rm --network "${P}_default" --dns 10.77.0.53 -v "$tmp:/w" curlimages/curl:8.17.0 -sS "$@"; }
c -k https://pebble:15000/roots/0 -o /w/root.pem
https() { c --cacert /w/root.pem "$@"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval("JSON.parse(s)."+process.argv[1])))' "$1"; }

# Root and wildcard are separate orders: wait for both.
ready() { https -m 10 -o /dev/null "$1" 2>/dev/null; }
for i in $(seq 61); do
  ready https://cresslet.test/healthz && ready https://preview.cresslet.test/cresslet-relay.html && break
  [ "$i" -lt 61 ] || fail "timed out waiting for the root and wildcard certificates"
  sleep 2
done
[ "$(https https://cresslet.test/healthz)" = ok ] || fail "studio root over TLS"
pass "studio root https://cresslet.test (DNS-01)"

tok=$(https -X POST https://cresslet.test/v1/accounts -H 'authorization: Bearer test-admin' \
  -H 'content-type: application/json' -d '{"email":"t@example.test"}' | json token)
auth="authorization: Bearer $tok"
app=$(https -X POST https://cresslet.test/v1/deploys -H "$auth" -H 'content-type: application/json' \
  -d '{"files":[{"path":"index.html","data":"hello over tls"}]}' | json app.name)

out=$(https -v "https://$app.cresslet.test/" 2>&1)
grep -q 'hello over tls' <<<"$out" || fail "app subdomain: $out"
grep -q 'CN=\*\.cresslet\.test\|"\*\.cresslet\.test"' <<<"$out" || grep -qi 'subjectAltName.*\*\.cresslet\.test' <<<"$out" || fail "app not on wildcard cert"
pass "app https://$app.cresslet.test on the wildcard cert"

[ "$(https -o /dev/null -w '%{http_code}' https://preview.cresslet.test/cresslet-relay.html)" = 200 ] || fail "preview host"
pass "preview host https://preview.cresslet.test"

[ "$(c -o /dev/null -w '%{http_code}' "http://$app.cresslet.test/")" = 308 ] || fail "http→https redirect"
pass "http redirects to https"

# Custom domain: add, prove DNS ownership (TXT), verify → on-demand cert.
txt=$(https -X POST "https://cresslet.test/v1/apps/$app/domains" -H "$auth" -H 'content-type: application/json' \
  -d '{"domain":"shop.example.test"}' | json 'domain.dns.find(r=>r.type==="TXT").value')
printf 'server 127.0.0.1\nupdate add _cresslet.shop.example.test 5 TXT %s\nsend\n' "$txt" | dc exec -T bind nsupdate -y "hmac-sha256:caddy:$KEY"
[ "$(https -X POST "https://cresslet.test/v1/apps/$app/domains/shop.example.test/verify" -H "$auth" | json domain.verified)" = true ] \
  || fail "custom domain verify"
out=$(https -v https://shop.example.test/ 2>&1)
grep -q 'hello over tls' <<<"$out" || fail "custom domain: $out"
pass "verified custom domain https://shop.example.test (on-demand cert)"

# Same server, DNS pointed at it, never verified: the ask endpoint refuses, so no cert is requested.
if https -o /dev/null https://evil.example.test/ 2>/dev/null; then fail "unverified domain got a cert"; fi
certs=$(dc exec -T caddy find /data/caddy/certificates -name '*.crt')
grep -q shop.example.test <<<"$certs" || fail "cert store: $certs"
! grep -q evil <<<"$certs" || fail "cert issued for evil.example.test"
pass "unverified https://evil.example.test refused (no certificate)"

ok=1
echo "all passed"
