# Caddy with one DNS provider module (needed for the wildcard cert's DNS-01 challenge).
ARG CADDY_VERSION=2.11.9
FROM caddy:${CADDY_VERSION}-builder AS build
ARG DNS_MODULE=github.com/caddy-dns/cloudflare@v0.2.4
RUN xcaddy build --with ${DNS_MODULE}

FROM caddy:${CADDY_VERSION}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
