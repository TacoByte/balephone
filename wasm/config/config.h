/* config.h for the Emscripten/WebAssembly build of Aleph One.
   Hand-maintained; mirrors what configure would produce for a minimal
   single-player build (no networking, no OpenGL, no curl/zzip/upnp/nfd). */

#ifndef WASM_CONFIG_H
#define WASM_CONFIG_H

/* Core features */
#define HAVE_SDL_TTF 1
#define HAVE_SDL_IMAGE 1
#define HAVE_ZLIB 1
#define HAVE_ZLIB_H 1

/* Disabled subsystems */
#define DISABLE_NETWORKING 1

/* OpenGL renderer via gl4es (desktop GL 2.x -> WebGL) */
#define HAVE_OPENGL 1
/* no HAVE_CURL, HAVE_ZZIP, HAVE_PNG, HAVE_MINIUPNPC, HAVE_NFD, FILM_EXPORT */

/* Standard headers/functions available under Emscripten */
#define HAVE_UNISTD_H 1
#define HAVE_PWD_H 1
#define HAVE_SNPRINTF 1
#define HAVE_VSNPRINTF 1
#define HAVE_SYSCONF 1
#define LUA_USE_MKSTEMP 1

#define PACKAGE "AlephOne"
#define PACKAGE_NAME "Aleph One"
#define PACKAGE_TARNAME "AlephOne"
#define PACKAGE_BUGREPORT "https://github.com/Aleph-One-Marathon/alephone/issues"
#define PACKAGE_URL "https://alephone.lhowon.org/"
#define VERSION "20250829"
#define PACKAGE_STRING "Aleph One 20250829"
#define PACKAGE_VERSION "20250829"

#define TARGET_PLATFORM "emscripten wasm32"

#endif
