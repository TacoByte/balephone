#!/usr/bin/env bash
# Fetches and builds everything the wasm build needs that is not in git:
#
#   wasm/deps/     pinned third-party library sources
#   wasm/prefix/   those libraries cross-compiled with Emscripten
#   wasm/gamedata/ the freely-distributed Marathon 2 game content
#
# Prerequisites: emscripten (emcc/emcmake in PATH), cmake, git, curl, unzip.
#
# After this completes, build the engine with:
#   emcmake cmake -B wasm/build -S wasm   (from the repo root)
#   cmake --build wasm/build -j8

set -euo pipefail

WASM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS="$WASM_DIR/deps"
PREFIX="$WASM_DIR/prefix"
GAMEDATA="$WASM_DIR/gamedata"
JOBS="${JOBS:-8}"

command -v emcmake >/dev/null || { echo "error: emcmake not found (install/activate emscripten)"; exit 1; }
command -v cmake   >/dev/null || { echo "error: cmake not found"; exit 1; }

mkdir -p "$DEPS" "$PREFIX"

# --- pinned versions --------------------------------------------------------
# openal-soft is pinned to 1.23.1: 1.24.x bundles a copy of fmt that does not
# compile under Emscripten. It must be built with -fexceptions so its own
# try/catch around thread creation works (thread spawning fails on the
# single-threaded web, and openal recovers from that gracefully).
OGG_TAG=v1.3.5
VORBIS_TAG=v1.3.7
FLAC_TAG=1.4.3
OPUS_TAG=v1.5.2
SNDFILE_TAG=1.2.2
OPENAL_TAG=1.23.1
ASIO_TAG=asio-1-30-2
DATA_URL="https://github.com/Aleph-One-Marathon/alephone/releases/download/release-20250829/Marathon2-20250829-Data.zip"

clone() { # repo tag dir
    local repo="$1" tag="$2" dir="$DEPS/$3"
    if [ -d "$dir" ]; then
        echo "--- $3: already cloned, skipping fetch"
    else
        git clone --depth 1 --branch "$tag" "$repo" "$dir"
    fi
}

build() { # dir extra-cmake-args...
    local dir="$DEPS/$1"; shift
    echo "--- building $dir"
    emcmake cmake -B "$dir/build" -S "$dir" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_PREFIX_PATH="$PREFIX" \
        -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
        "$@"
    cmake --build "$dir/build" -j"$JOBS"
    cmake --install "$dir/build"
}

# --- audio codec stack (order matters: ogg first, sndfile last) -------------

clone https://github.com/xiph/ogg.git            "$OGG_TAG"     ogg
clone https://github.com/xiph/vorbis.git         "$VORBIS_TAG"  vorbis
clone https://github.com/xiph/flac.git           "$FLAC_TAG"    flac
clone https://github.com/xiph/opus.git           "$OPUS_TAG"    opus
clone https://github.com/libsndfile/libsndfile.git "$SNDFILE_TAG" libsndfile
clone https://github.com/kcat/openal-soft.git    "$OPENAL_TAG"  openal-soft
clone https://github.com/chriskohlhoff/asio.git  "$ASIO_TAG"    asio-src

build ogg    -DBUILD_TESTING=OFF -DINSTALL_DOCS=OFF
build vorbis
build flac   -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF \
             -DBUILD_DOCS=OFF -DBUILD_CXXLIBS=OFF -DINSTALL_MANPAGES=OFF -DWITH_OGG=ON
build opus
build libsndfile -DBUILD_PROGRAMS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF \
             -DENABLE_EXTERNAL_LIBS=ON -DENABLE_MPEG=OFF -DENABLE_CPACK=OFF

build openal-soft \
    -DLIBTYPE=STATIC \
    -DALSOFT_UTILS=OFF -DALSOFT_EXAMPLES=OFF -DALSOFT_TESTS=OFF \
    -DALSOFT_BACKEND_SDL2=OFF -DALSOFT_BACKEND_WAVE=OFF -DALSOFT_BACKEND_OSS=OFF \
    -DALSOFT_BACKEND_PORTAUDIO=OFF -DALSOFT_BACKEND_PIPEWIRE=OFF \
    -DALSOFT_BACKEND_PULSEAUDIO=OFF -DALSOFT_BACKEND_ALSA=OFF \
    -DALSOFT_BACKEND_JACK=OFF -DALSOFT_RTKIT=OFF \
    -DALSOFT_CPUEXT_SSE=OFF -DALSOFT_CPUEXT_SSE2=OFF -DALSOFT_CPUEXT_SSE3=OFF \
    -DALSOFT_CPUEXT_SSE4_1=OFF -DALSOFT_CPUEXT_NEON=OFF \
    -DCMAKE_C_FLAGS=-fexceptions -DCMAKE_CXX_FLAGS=-fexceptions

# asio is header-only; the engine build includes it straight from deps/.

# --- Marathon 2 game data ----------------------------------------------------

if [ -e "$GAMEDATA/Map.sceA" ]; then
    echo "--- gamedata: already present, skipping download"
else
    echo "--- downloading Marathon 2 game data"
    tmp="$(mktemp -d)"
    curl -L -o "$tmp/data.zip" "$DATA_URL"
    unzip -q "$tmp/data.zip" -d "$tmp/extracted"
    # The zip contains a single top-level "Marathon 2" directory.
    src="$(find "$tmp/extracted" -maxdepth 1 -mindepth 1 -type d | head -1)"
    mkdir -p "$GAMEDATA"
    cp -R "$src"/. "$GAMEDATA"/
    rm -rf "$tmp"
fi

echo
echo "All dependencies ready:"
echo "  libs:     $(ls "$PREFIX/lib" | tr '\n' ' ')"
echo "  gamedata: $(ls "$GAMEDATA" | tr '\n' ' ')"
echo
echo "Next: emcmake cmake -B wasm/build -S wasm && cmake --build wasm/build -j$JOBS"
