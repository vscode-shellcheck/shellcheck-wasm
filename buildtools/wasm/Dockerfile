# syntax=docker/dockerfile:1

FROM debian:13-slim AS toolchain
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# GHC-built tools abort on non-ASCII output in the POSIX locale.
ENV LANG=C.UTF-8

# setup.sh needs curl, jq, unzip, zstd, xz (tar xJ) and a host C toolchain for the
# bindist's configure/make install. binaryen, wasmtime and wasm-tools come with the
# toolchain itself.
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

# ghc-wasm-meta dropped -mtail-call from its defaults in 2025-09 (WebKit crashes); GHC's
# wasm NCG only emits return_call when the flag is in the configured C compiler options,
# so it must be explicit here. setup.sh bakes CONF_*_OPTS into the installed GHC settings.
ENV WASM_CFLAGS="-Wno-error=int-conversion -O3 -mcpu=lime1 -mreference-types -msimd128 -mtail-call"
RUN CONF_CC_OPTS_STAGE1="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE1="-fno-exceptions $WASM_CFLAGS" \
    CONF_CC_OPTS_STAGE2="$WASM_CFLAGS" CONF_CXX_OPTS_STAGE2="-fno-exceptions $WASM_CFLAGS" \
    ./setup.sh


FROM toolchain AS build

# ARGs are stage-scoped; re-declare the ones this stage reads.
ARG GHC_WASM_META_COMMIT
ARG SHELLCHECK_VERSION
ARG SHELLCHECK_SRC_SHA256

WORKDIR /shellcheck
RUN test -n "$SHELLCHECK_VERSION" && test -n "$SHELLCHECK_SRC_SHA256" \
    && curl -fL --retry 5 -o src.tar.gz \
        "https://github.com/koalaman/shellcheck/archive/refs/tags/${SHELLCHECK_VERSION}.tar.gz" \
    && echo "${SHELLCHECK_SRC_SHA256}  src.tar.gz" | sha256sum -c - \
    && tar xzf src.tar.gz --strip-components=1 \
    && rm src.tar.gz

RUN ./striptests

COPY cabal.project ./cabal.project

# cabal's download of this tarball gets a 403 from Hackage's CDN; pre-seed the package
# cache so the solver's choice (latest fgl at cabal.project's index-state) resolves locally.
RUN mkdir -p /root/.ghc-wasm/.cabal/packages/hackage.haskell.org/fgl/5.8.3.1 \
    && curl -fL --retry 5 -o /root/.ghc-wasm/.cabal/packages/hackage.haskell.org/fgl/5.8.3.1/fgl-5.8.3.1.tar.gz \
        https://hackage.haskell.org/package/fgl-5.8.3.1/fgl-5.8.3.1.tar.gz

RUN . /root/.ghc-wasm/env \
    && wasm32-wasi-cabal update \
    && wasm32-wasi-cabal build exe:shellcheck

RUN mkdir -p /out \
    && . /root/.ghc-wasm/env \
    && cp "$(wasm32-wasi-cabal list-bin exe:shellcheck)" /out/shellcheck.linked.wasm

COPY check-target-features.py write-build-info.sh /tools/

# Gate on the linker output: wasm-opt --enable-tail-call rewrites the section and would
# claim +tail-call even if GHC had emitted none.
RUN python3 /tools/check-target-features.py /out/shellcheck.linked.wasm --require tail-call

RUN . /root/.ghc-wasm/env \
    && wasm-opt --enable-tail-call --flatten --rereloop --converge -O3 \
        -o /out/shellcheck.wasm /out/shellcheck.linked.wasm

RUN . /root/.ghc-wasm/env \
    && wasm-tools validate --features all /out/shellcheck.wasm \
    && python3 /tools/check-target-features.py /out/shellcheck.wasm --require tail-call \
        > /out/target-features.json

RUN . /root/.ghc-wasm/env \
    && wasmtime run -W tail-call=y /out/shellcheck.wasm --version \
        | grep -Fx "version: ${SHELLCHECK_VERSION#v}"

RUN . /root/.ghc-wasm/env \
    && SHELLCHECK_VERSION="$SHELLCHECK_VERSION" GHC_WASM_META_COMMIT="$GHC_WASM_META_COMMIT" \
        sh /tools/write-build-info.sh /out


FROM scratch AS artifact
COPY --from=build /out/shellcheck.wasm /out/shellcheck.wasm.sha256 /out/build-info.json /
