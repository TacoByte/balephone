# Emscripten/WebAssembly build of Aleph One.
# Configure with:  emcmake cmake -B wasm/build -S wasm  (from the repo root)
cmake_minimum_required(VERSION 3.20)
project(AlephOneWasm CXX C)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "This build is Emscripten-only. Use emcmake.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(A1_WASM_PERF_TESTING "Enable browser benchmark instrumentation" OFF)

get_filename_component(A1_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(SF "${A1_ROOT}/Source_Files")
set(WASM_PREFIX "${CMAKE_CURRENT_SOURCE_DIR}/prefix")

# Emscripten ports used for SDL2 family, zlib and boost headers.
set(EM_PORT_COMPILE_FLAGS
    "-sUSE_SDL=2"
    "-sUSE_SDL_TTF=2"
    "-sUSE_SDL_IMAGE=2"
    "-sSDL2_IMAGE_FORMATS=png,jpg"
    "-sUSE_ZLIB=1"
    "-sUSE_BOOST_HEADERS=1"
)

set(SOURCES
    # top level
    ${SF}/shell.cpp
    ${SF}/shell_misc.cpp
    ${SF}/shell_options.cpp
    ${SF}/main.cpp

    # CSeries
    ${SF}/CSeries/byte_swapping.cpp
    ${SF}/CSeries/BStream.cpp
    ${SF}/CSeries/csalerts_sdl.cpp
    ${SF}/CSeries/cscluts_sdl.cpp
    ${SF}/CSeries/csdialogs_sdl.cpp
    ${SF}/CSeries/csmisc_sdl.cpp
    ${SF}/CSeries/cspaths_sdl.cpp
    ${SF}/CSeries/csstrings.cpp
    ${SF}/CSeries/FilmProfile.cpp
    # mytm_sdl.cpp is replaced by config/mytm_wasm.cpp (no threads on the web)

    # Files
    ${SF}/Files/AStream.cpp
    ${SF}/Files/crc.cpp
    ${SF}/Files/FileHandler.cpp
    ${SF}/Files/find_files_sdl.cpp
    ${SF}/Files/game_wad.cpp
    ${SF}/Files/import_definitions.cpp
    ${SF}/Files/Packing.cpp
    ${SF}/Files/preprocess_map_sdl.cpp
    ${SF}/Files/preprocess_map_shared.cpp
    ${SF}/Files/resource_manager.cpp
    ${SF}/Files/SDL_rwops_ostream.cpp
    ${SF}/Files/wad.cpp
    ${SF}/Files/wad_prefs.cpp
    ${SF}/Files/wad_sdl.cpp
    ${SF}/Files/WadImageCache.cpp

    # GameWorld
    ${SF}/GameWorld/devices.cpp
    ${SF}/GameWorld/dynamic_limits.cpp
    ${SF}/GameWorld/effects.cpp
    ${SF}/GameWorld/flood_map.cpp
    ${SF}/GameWorld/interpolated_world.cpp
    ${SF}/GameWorld/items.cpp
    ${SF}/GameWorld/lightsource.cpp
    ${SF}/GameWorld/map_constructors.cpp
    ${SF}/GameWorld/map.cpp
    ${SF}/GameWorld/marathon2.cpp
    ${SF}/GameWorld/media.cpp
    ${SF}/GameWorld/monsters.cpp
    ${SF}/GameWorld/pathfinding.cpp
    ${SF}/GameWorld/physics.cpp
    ${SF}/GameWorld/placement.cpp
    ${SF}/GameWorld/platforms.cpp
    ${SF}/GameWorld/player.cpp
    ${SF}/GameWorld/projectiles.cpp
    ${SF}/GameWorld/scenery.cpp
    ${SF}/GameWorld/weapons.cpp
    ${SF}/GameWorld/world.cpp
    ${SF}/GameWorld/ephemera.cpp

    # Input
    ${SF}/Input/mouse_sdl.cpp
    ${SF}/Input/joystick_sdl.cpp

    # Lua (vendored 5.2 plus bindings)
    ${SF}/Lua/lua_script.cpp
    ${SF}/Lua/lua_map.cpp
    ${SF}/Lua/lua_monsters.cpp
    ${SF}/Lua/lua_objects.cpp
    ${SF}/Lua/lua_player.cpp
    ${SF}/Lua/lua_music.cpp
    ${SF}/Lua/lua_projectiles.cpp
    ${SF}/Lua/lua_saved_objects.cpp
    ${SF}/Lua/lua_serialize.cpp
    ${SF}/Lua/lua_hud_objects.cpp
    ${SF}/Lua/lua_hud_script.cpp
    ${SF}/Lua/lua_ephemera.cpp
    ${SF}/Lua/lapi.c
    ${SF}/Lua/lauxlib.c
    ${SF}/Lua/lbaselib.c
    ${SF}/Lua/lbitlib.c
    ${SF}/Lua/lcode.c
    ${SF}/Lua/lctype.c
    ${SF}/Lua/ldblib.c
    ${SF}/Lua/ldebug.c
    ${SF}/Lua/ldo.c
    ${SF}/Lua/ldump.c
    ${SF}/Lua/lfunc.c
    ${SF}/Lua/lgc.c
    ${SF}/Lua/linit.c
    ${SF}/Lua/liolib.c
    ${SF}/Lua/llex.c
    ${SF}/Lua/lmathlib.c
    ${SF}/Lua/lmem.c
    ${SF}/Lua/lobject.c
    ${SF}/Lua/lopcodes.c
    ${SF}/Lua/loslib.c
    ${SF}/Lua/lparser.c
    ${SF}/Lua/lstate.c
    ${SF}/Lua/lstring.c
    ${SF}/Lua/lstrlib.c
    ${SF}/Lua/ltable.c
    ${SF}/Lua/ltablib.c
    ${SF}/Lua/ltm.c
    ${SF}/Lua/lundump.c
    ${SF}/Lua/lvm.c
    ${SF}/Lua/lzio.c

    # Misc
    ${SF}/Misc/achievements.cpp
    ${SF}/Misc/ActionQueues.cpp
    ${SF}/Misc/CircularByteBuffer.cpp
    ${SF}/Misc/Console.cpp
    ${SF}/Misc/DefaultStringSets.cpp
    ${SF}/Misc/game_errors.cpp
    ${SF}/Misc/interface.cpp
    ${SF}/Misc/Logging.cpp
    ${SF}/Misc/PlayerImage_sdl.cpp
    ${SF}/Misc/PlayerName.cpp
    ${SF}/Misc/preferences.cpp
    ${SF}/Misc/preference_dialogs.cpp
    ${SF}/Misc/preferences_widgets_sdl.cpp
    ${SF}/Misc/Scenario.cpp
    ${SF}/Misc/sdl_dialogs.cpp
    ${SF}/Misc/sdl_widgets.cpp
    ${SF}/Misc/shared_widgets.cpp
    ${SF}/Misc/thread_priority_sdl_dummy.cpp
    ${SF}/Misc/vbl.cpp
    ${SF}/Misc/Statistics.cpp
    ${SF}/Misc/ScenarioChooser.cpp

    # ModelView
    ${SF}/ModelView/Model3D.cpp
    ${SF}/ModelView/ModelRenderer.cpp
    ${SF}/ModelView/Dim3_Loader.cpp
    ${SF}/ModelView/StudioLoader.cpp
    ${SF}/ModelView/WavefrontLoader.cpp

    # Network: full multiplayer stack, running over the WebSocket relay
    # transport (config/net_relay.cpp) instead of asio sockets.
    # NetworkInterface.cpp (asio impl) is excluded; net_relay.cpp implements
    # the same API for the browser.
    ${SF}/Network/network.cpp
    ${SF}/Network/network_dialogs.cpp
    ${SF}/Network/network_dialog_widgets_sdl.cpp
    ${SF}/Network/network_games.cpp
    ${SF}/Network/network_messages.cpp
    ${SF}/Network/network_star_hub.cpp
    ${SF}/Network/network_star_spoke.cpp
    ${SF}/Network/network_udp.cpp
    ${SF}/Network/StarGameProtocol.cpp
    ${SF}/Network/network_capabilities.cpp
    ${SF}/Network/ConnectPool.cpp
    ${SF}/Network/SSLP_limited.cpp
    ${SF}/Network/Pinger.cpp
    ${SF}/Network/Update.cpp
    ${SF}/Network/HTTP.cpp
    ${SF}/Network/PortForward.cpp
    ${SF}/Network/Metaserver/network_metaserver.cpp
    ${SF}/Network/Metaserver/metaserver_dialogs.cpp
    ${SF}/Network/Metaserver/metaserver_messages.cpp
    ${SF}/Network/Metaserver/SdlMetaserverClientUi.cpp

    # TCPMess (setup/chat/map-transfer message channel; transport-agnostic)
    ${SF}/TCPMess/CommunicationsChannel.cpp
    ${SF}/TCPMess/Message.cpp
    ${SF}/TCPMess/MessageInflater.cpp

    ${CMAKE_CURRENT_SOURCE_DIR}/config/net_relay.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/config/mytm_wasm.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/config/wasm_compat.c
    ${CMAKE_CURRENT_SOURCE_DIR}/config/glu_shim.c
    ${CMAKE_CURRENT_SOURCE_DIR}/config/gl4es_support.c

    # RenderMain (software rasterizer; OGL_* files self-stub without HAVE_OPENGL)
    ${SF}/RenderMain/AnimatedTextures.cpp
    ${SF}/RenderMain/Crosshairs_SDL.cpp
    ${SF}/RenderMain/ImageLoader_Shared.cpp
    ${SF}/RenderMain/ImageLoader_SDL.cpp
    ${SF}/RenderMain/OGL_Faders.cpp
    ${SF}/RenderMain/OGL_Model_Def.cpp
    ${SF}/RenderMain/OGL_Render.cpp
    ${SF}/RenderMain/OGL_Setup.cpp
    ${SF}/RenderMain/OGL_Subst_Texture_Def.cpp
    ${SF}/RenderMain/OGL_Textures.cpp
    ${SF}/RenderMain/render.cpp
    ${SF}/RenderMain/RenderPlaceObjs.cpp
    ${SF}/RenderMain/RenderRasterize.cpp
    ${SF}/RenderMain/RenderSortPoly.cpp
    ${SF}/RenderMain/RenderVisTree.cpp
    ${SF}/RenderMain/scottish_textures.cpp
    ${SF}/RenderMain/shapes.cpp
    ${SF}/RenderMain/SW_Texture_Extras.cpp
    ${SF}/RenderMain/textures.cpp
    ${SF}/RenderMain/OGL_Shader.cpp
    ${SF}/RenderMain/OGL_FBO.cpp
    ${SF}/RenderMain/Rasterizer_Shader.cpp
    ${SF}/RenderMain/RenderRasterize_Shader.cpp

    # RenderOther
    ${SF}/RenderOther/ChaseCam.cpp
    ${SF}/RenderOther/computer_interface.cpp
    ${SF}/RenderOther/fades.cpp
    ${SF}/RenderOther/FontHandler.cpp
    ${SF}/RenderOther/game_window.cpp
    ${SF}/RenderOther/HUDRenderer.cpp
    ${SF}/RenderOther/HUDRenderer_OGL.cpp
    ${SF}/RenderOther/HUDRenderer_SW.cpp
    ${SF}/RenderOther/HUDRenderer_Lua.cpp
    ${SF}/RenderOther/images.cpp
    ${SF}/RenderOther/motion_sensor.cpp
    ${SF}/RenderOther/Image_Blitter.cpp
    ${SF}/RenderOther/OGL_Blitter.cpp
    ${SF}/RenderOther/Shape_Blitter.cpp
    ${SF}/RenderOther/OGL_LoadScreen.cpp
    ${SF}/RenderOther/overhead_map.cpp
    ${SF}/RenderOther/OverheadMap_OGL.cpp
    ${SF}/RenderOther/OverheadMapRenderer.cpp
    ${SF}/RenderOther/OverheadMap_SDL.cpp
    ${SF}/RenderOther/screen_drawing.cpp
    ${SF}/RenderOther/screen.cpp
    ${SF}/RenderOther/sdl_fonts.cpp
    ${SF}/RenderOther/sdl_resize.cpp
    ${SF}/RenderOther/TextLayoutHelper.cpp
    ${SF}/RenderOther/TextStrings.cpp
    ${SF}/RenderOther/ViewControl.cpp

    # Sound
    ${SF}/Sound/Decoder.cpp
    ${SF}/Sound/Music.cpp
    ${SF}/Sound/ReplacementSounds.cpp
    ${SF}/Sound/SndfileDecoder.cpp
    ${SF}/Sound/SoundFile.cpp
    ${SF}/Sound/SoundManager.cpp
    ${SF}/Sound/OpenALManager.cpp
    ${SF}/Sound/AudioPlayer.cpp
    ${SF}/Sound/SoundPlayer.cpp
    ${SF}/Sound/MusicPlayer.cpp
    ${SF}/Sound/StreamPlayer.cpp

    # Videos (stubbed without FILM_EXPORT; pl_mpeg used via interface.cpp)
    ${SF}/Videos/Movie.cpp

    # XML
    ${SF}/XML/Plugins.cpp
    ${SF}/XML/QuickSave.cpp
    ${SF}/XML/InfoTree.cpp
    ${SF}/XML/XML_LevelScript.cpp
    ${SF}/XML/XML_MakeRoot.cpp
)

add_executable(alephone ${SOURCES})

target_include_directories(alephone PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/config   # our config.h / confpaths.h
    ${SF}
    ${SF}/CSeries
    ${SF}/Files
    ${SF}/GameWorld
    ${SF}/Input
    ${SF}/Lua
    ${SF}/Misc
    ${SF}/ModelView
    ${SF}/Network
    ${SF}/Network/Metaserver
    ${SF}/RenderMain
    ${SF}/RenderOther
    ${SF}/Sound
    ${SF}/TCPMess
    ${SF}/Videos
    ${SF}/XML
    ${WASM_PREFIX}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/asio-src/asio/include
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/gl4es/include   # GL/gl.h, GL/glu.h, gl4esinit.h
)

target_compile_definitions(alephone PRIVATE
    HAVE_CONFIG_H
    AL_LIBTYPE_STATIC
)

if(A1_WASM_PERF_TESTING)
    target_compile_definitions(alephone PRIVATE A1_WASM_PERF_TESTING)
endif()

target_compile_options(alephone PRIVATE
    ${EM_PORT_COMPILE_FLAGS}
    -O2
    -fexceptions
    -Wno-deprecated-declarations
)

set(ENGINE_DATA_DIR "${A1_ROOT}/data")

target_link_options(alephone PRIVATE
    ${EM_PORT_COMPILE_FLAGS}
    -O2
    -fexceptions
    "-sASYNCIFY=1"
    "-sASYNCIFY_STACK_SIZE=262144"
    "-sALLOW_MEMORY_GROWTH=1"
    # Resizable ArrayBuffers break TextDecoder.decode in Chromium (as of
    # Playwright's build); fall back to copy-on-grow memory.
    "-sGROWABLE_ARRAYBUFFERS=0"
    "-sINITIAL_MEMORY=536870912"
    "-sSTACK_SIZE=8388608"
    "-sFORCE_FILESYSTEM=1"
    "-sEXIT_RUNTIME=0"
    "-sENVIRONMENT=web"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=AlephOne"
    "-sEXPORTED_RUNTIME_METHODS=FS,callMain"
    "-sINVOKE_RUN=0"
    # gl4es (desktop GL -> ES2): needs client-side arrays and runtime
    # GLES symbol lookup from emscripten's GL library.
    "-sFULL_ES2=1"
    "-sGL_ENABLE_GET_PROC_ADDRESS=1"
    "-lidbfs.js"
    # Engine support data only; game data (the data/Scenarios submodules,
    # which live inside data/ and must not be swept into this bundle) is
    # staged per-scenario below and fetched by the shell page at runtime.
    "--preload-file=${ENGINE_DATA_DIR}@/data/engine"
    "--exclude-file=*/Scenarios/*"
)

target_link_libraries(alephone PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/gl4es/lib/libGL.a
    ${WASM_PREFIX}/lib/libopenal.a
    ${WASM_PREFIX}/lib/libsndfile.a
    ${WASM_PREFIX}/lib/libvorbisenc.a
    ${WASM_PREFIX}/lib/libvorbisfile.a
    ${WASM_PREFIX}/lib/libvorbis.a
    ${WASM_PREFIX}/lib/libFLAC.a
    ${WASM_PREFIX}/lib/libopus.a
    ${WASM_PREFIX}/lib/libogg.a
)

set_target_properties(alephone PROPERTIES SUFFIX ".js")

# Keep the shell page in the build dir up to date (a POST_BUILD hook would
# only run when the engine relinks, missing shell-only edits).
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/index.html"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_SOURCE_DIR}/shell/index.html"
        "${CMAKE_CURRENT_BINARY_DIR}/index.html"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/shell/index.html"
)
add_custom_target(shellpage ALL DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/index.html")

# Stage game data (the data/Scenarios submodules) into build/gamedata/<slug>/
# with a manifest.json per scenario; the shell page downloads the selected
# scenario into the virtual filesystem before starting the engine.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_custom_target(gamedata ALL
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tools/package_scenarios.py"
        "$<TARGET_FILE_DIR:alephone>/gamedata"
        "${A1_ROOT}/data/Scenarios/Marathon"
        "${A1_ROOT}/data/Scenarios/Marathon 2"
        "${A1_ROOT}/data/Scenarios/Marathon Infinity"
    COMMENT "Staging scenario data + manifests"
)
