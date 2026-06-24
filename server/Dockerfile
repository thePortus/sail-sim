# Debian base (NOT Alpine): the biome-texture build — `npm run build:biome`, run at RUNTIME via
# `docker exec sail-sim-nodejs npm run download:terrain-tiles` — needs the KTX-Software `ktx` CLI, which
# ships ONLY as a glibc .deb/.rpm (there is no Alpine/musl build). bash + ImageMagick come from apt; the
# `ktx` CLI from the official GitHub .deb. The tools must be in the final image because the asset build
# runs in the running container, not at image-build time.
FROM node:18-bookworm-slim

WORKDIR /server

# Pin the KTX-Software release used to GPU-compress the biome tiles (Basis/UASTC → per-layer KTX2).
ARG KTX_VERSION=4.4.2

# Asset-build tooling (used by server/scripts/build-biome-*.sh):
#   bash        — the scripts use bash arrays / [[ ]]
#   imagemagick — Debian ships v6, so the binary is `convert` (resolve_bin in the scripts finds it); tile
#                 resize + ORM channel pack
#   ktx         — KTX-Software CLI (`ktx create …`), installed from the glibc .deb (arch-detected: amd64/arm64)
#   dos2unix    — keeps the migrate.sh CRLF fix from the old Alpine image
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash imagemagick dos2unix ca-certificates curl \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) KARCH=x86_64 ;; \
      arm64) KARCH=arm64 ;; \
      *) echo "unsupported arch for KTX-Software: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/ktx.deb \
      "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-${KARCH}.deb" \
 && apt-get install -y --no-install-recommends /tmp/ktx.deb \
 && rm -f /tmp/ktx.deb \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# copy project code
COPY . /server

# install dependencies
RUN npm install
RUN dos2unix /server/migrate.sh

# expose the port
EXPOSE 8080

# start the application
CMD npm start
