FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS toolchain
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# GHC-built tools abort on non-ASCII output in the POSIX locale.
ENV LANG=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl jq python3 unzip xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

ARG GHC_WASM_META_COMMIT
WORKDIR /ghc
RUN test -n "$GHC_WASM_META_COMMIT" \
    && curl -fL --retry 5 -o meta.tar.gz \
        "https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/archive/${GHC_WASM_META_COMMIT}/ghc-wasm-meta-${GHC_WASM_META_COMMIT}.tar.gz" \
    && tar xzf meta.tar.gz --strip-components=1 \
    && rm meta.tar.gz

# ghc-wasm-meta dropped -mtail-call from its defaults; GHC only emits return_call when it is baked in.
ENV WASM_CFLAGS="-Wno-error=int-conversion -O3 -mcpu=lime1 -mreference-types -msimd128 -mtail-call"
RUN CONF_CC_OPTS_STAGE1="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE1="-fno-exceptions $WASM_CFLAGS" \
    CONF_CC_OPTS_STAGE2="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE2="-fno-exceptions $WASM_CFLAGS" \
    ./setup.sh


FROM toolchain AS build
ARG GHC_WASM_META_COMMIT
ARG SHELLCHECK_VERSION
ARG SHELLCHECK_SRC_SHA256

WORKDIR /shellcheck
RUN test -n "$SHELLCHECK_VERSION" && test -n "$SHELLCHECK_SRC_SHA256" \
    && curl -fL --retry 5 -o src.tar.gz \
        "https://github.com/koalaman/shellcheck/archive/refs/tags/${SHELLCHECK_VERSION}.tar.gz" \
    && echo "${SHELLCHECK_SRC_SHA256}  src.tar.gz" | sha256sum -c - \
    && tar xzf src.tar.gz --strip-components=1 \
    && rm src.tar.gz \
    && ./striptests

COPY cabal.project build.sh check-target-features.py ./
RUN ./build.sh


FROM scratch AS artifact
COPY --from=build /out/shellcheck.wasm /out/shellcheck.wasm.sha256 /out/build-info.json /
