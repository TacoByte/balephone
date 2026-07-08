/* gl4es bring-up for the Emscripten build. gl4es is compiled with
   NO_LOADER/NO_INIT_CONSTRUCTOR, so the engine must initialize it once a
   WebGL context exists (right after SDL_GL_CreateContext). */

#ifdef __EMSCRIPTEN__

#include <emscripten/html5.h>
#include <stdlib.h>
#include "gl4esinit.h"

static void main_fb_size(int* width, int* height)
{
	emscripten_get_canvas_element_size("#canvas", width, height);
}

/* Without this, gl4es skips hardware extension detection entirely
   ("Hardware test disabled") and misdetects NPOT/FBO capabilities. */
void* emscripten_GetProcAddress(const char* name);

static void* get_proc_address(const char* name)
{
	return emscripten_GetProcAddress(name);
}

void wasm_gl4es_init(void)
{
	static int initialized = 0;
	if (initialized)
		return;
	initialized = 1;

	setenv("LIBGL_LOGSHADERERROR", "1", 1);
	set_getprocaddress(get_proc_address);
	set_getmainfbsize(main_fb_size);
	initialize_gl4es();
}

#endif
