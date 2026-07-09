#!/usr/bin/env bash
# Fetches and builds everything the wasm build needs that is not in git:
#
#   wasm/deps/          pinned third-party library sources
#   wasm/prefix/        those libraries cross-compiled with Emscripten
#   data/Scenarios/     the freely-distributed Marathon game content
#                       (git submodules pinned by the engine repo)
#
# Prerequisites: emscripten (emcc/emcmake in PATH), cmake, git, curl, unzip.
#
# After this completes, build the engine with:
#   emcmake cmake -B wasm/build -S wasm   (from the repo root)
#   cmake --build wasm/build -j8

set -euo pipefail

WASM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A1_ROOT="$(dirname "$WASM_DIR")"
DEPS="$WASM_DIR/deps"
PREFIX="$WASM_DIR/prefix"
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
GL4ES_COMMIT=17f0894e19d1553e4176276c759915dab44c08e2  # v1.1.7 master, no release tag

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

# --- gl4es (desktop OpenGL 2.x -> GLES2/WebGL translation) -------------------
# Built static, no loader/constructor: the engine calls initialize_gl4es()
# itself once SDL has created the WebGL context (wasm/config/gl4es_support.c).
# Installed in-tree (deps/gl4es/lib); the engine links it from there.

if [ -d "$DEPS/gl4es" ]; then
    echo "--- gl4es: already cloned, skipping fetch"
else
    git clone https://github.com/ptitSeb/gl4es.git "$DEPS/gl4es"
    git -C "$DEPS/gl4es" checkout "$GL4ES_COMMIT"
fi

echo "--- building gl4es"
emcmake cmake -B "$DEPS/gl4es/build" -S "$DEPS/gl4es" \
    -DCMAKE_BUILD_TYPE=Release \
    -DSTATICLIB=ON -DNOX11=ON -DNOEGL=ON \
    -DNO_LOADER=ON -DNO_INIT_CONSTRUCTOR=ON -DDEFAULT_ES=2
cmake --build "$DEPS/gl4es/build" -j"$JOBS"

# --- game data (data/Scenarios submodules) -----------------------------------
# The engine repo pins the freely-released Marathon game data as submodules.
# Their URLs in .gitmodules are relative (they resolve to sibling repos of
# whatever remote the engine was cloned from), which breaks in forks, so
# point the local config at the canonical upstream data repos before fetching.

echo "--- fetching game data submodules"
declare -a SCENARIOS=("Marathon" "Marathon 2" "Marathon Infinity")
declare -a DATA_REPOS=(data-marathon data-marathon-2 data-marathon-infinity)

for i in "${!SCENARIOS[@]}"; do
    path="data/Scenarios/${SCENARIOS[$i]}"
    git -C "$A1_ROOT" submodule init "$path"
    git -C "$A1_ROOT" config "submodule.$path.url" \
        "https://github.com/Aleph-One-Marathon/${DATA_REPOS[$i]}.git"
    git -C "$A1_ROOT" submodule update --depth 1 "$path"
done

echo
echo "All dependencies ready:"
echo "  libs:     $(ls "$PREFIX/lib" | tr '\n' ' ')"
echo "  gamedata: $(ls "$A1_ROOT/data/Scenarios" | tr '\n' ' ')"
echo
echo "Next: emcmake cmake -B wasm/build -S wasm && cmake --build wasm/build -j$JOBS"
