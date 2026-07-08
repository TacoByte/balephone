/* Emscripten/gl4es compatibility for Aleph One's GL usage.

   gl4es on wasm cannot use symbol aliases, so it only exports mangled
   gl4es_gl* names; its GL/gl.h + gl_mangle.h remap plain gl* calls via
   macros. That covers core entry points, but Aleph One calls the ARB/EXT
   suffixed variants, whose mangled forms (gl4es_gl*ARB / gl4es_gl*EXT) are
   not exported. Redirect them to the equivalents that do exist. */

#ifndef GL4ES_COMPAT_H
#define GL4ES_COMPAT_H

#ifdef __cplusplus
extern "C" {
#endif

/* GL_ARB_shader_objects wrappers: gl4es implements these as unsuffixed
   gl4es_gl* functions that are not declared in any header. */
GLhandleARB gl4es_glCreateProgramObject(void);
GLhandleARB gl4es_glCreateShaderObject(GLenum shaderType);
GLvoid gl4es_glDeleteObject(GLhandleARB obj);
GLvoid gl4es_glAttachObject(GLhandleARB containerObj, GLhandleARB obj);
GLvoid gl4es_glUseProgramObject(GLhandleARB programObj);
GLvoid gl4es_glGetObjectParameteriv(GLhandleARB obj, GLenum pname, GLint* params);

#ifdef __cplusplus
}
#endif

#undef glCreateProgramObjectARB
#define glCreateProgramObjectARB gl4es_glCreateProgramObject
#undef glCreateShaderObjectARB
#define glCreateShaderObjectARB gl4es_glCreateShaderObject
#undef glDeleteObjectARB
#define glDeleteObjectARB gl4es_glDeleteObject
#undef glAttachObjectARB
#define glAttachObjectARB gl4es_glAttachObject
#undef glUseProgramObjectARB
#define glUseProgramObjectARB gl4es_glUseProgramObject
#undef glGetObjectParameterivARB
#define glGetObjectParameterivARB gl4es_glGetObjectParameteriv

/* ARB names that are plain aliases of core functions. The core names are
   themselves macros (via gl_mangle.h) resolving to exported gl4es_gl*. */
#undef glActiveTextureARB
#define glActiveTextureARB glActiveTexture
#undef glClientActiveTextureARB
#define glClientActiveTextureARB glClientActiveTexture
#undef glMultiTexCoord4fARB
#define glMultiTexCoord4fARB glMultiTexCoord4f
#undef glCompressedTexImage2DARB
#define glCompressedTexImage2DARB glCompressedTexImage2D
#undef glCompileShaderARB
#define glCompileShaderARB glCompileShader
#undef glLinkProgramARB
#define glLinkProgramARB glLinkProgram
#undef glShaderSourceARB
#define glShaderSourceARB glShaderSource
#undef glGetUniformLocationARB
#define glGetUniformLocationARB glGetUniformLocation
#undef glUniform1iARB
#define glUniform1iARB glUniform1i
#undef glUniform1fARB
#define glUniform1fARB glUniform1f
#undef glUniformMatrix4fvARB
#define glUniformMatrix4fvARB glUniformMatrix4fv

/* EXT framebuffer object -> core FBO (gl4es exports the core names). */
#undef glGenFramebuffersEXT
#define glGenFramebuffersEXT glGenFramebuffers
#undef glDeleteFramebuffersEXT
#define glDeleteFramebuffersEXT glDeleteFramebuffers
#undef glBindFramebufferEXT
#define glBindFramebufferEXT glBindFramebuffer
#undef glCheckFramebufferStatusEXT
#define glCheckFramebufferStatusEXT glCheckFramebufferStatus
#undef glFramebufferTexture2DEXT
#define glFramebufferTexture2DEXT glFramebufferTexture2D
#undef glFramebufferRenderbufferEXT
#define glFramebufferRenderbufferEXT glFramebufferRenderbuffer
#undef glGenRenderbuffersEXT
#define glGenRenderbuffersEXT glGenRenderbuffers
#undef glDeleteRenderbuffersEXT
#define glDeleteRenderbuffersEXT glDeleteRenderbuffers
#undef glBindRenderbufferEXT
#define glBindRenderbufferEXT glBindRenderbuffer
#undef glRenderbufferStorageEXT
#define glRenderbufferStorageEXT glRenderbufferStorage
#undef glBlitFramebufferEXT
#define glBlitFramebufferEXT glBlitFramebuffer

/* Misc EXT aliases of core functions. */
#undef glBlendColorEXT
#define glBlendColorEXT glBlendColor
#undef glBlendEquationEXT
#define glBlendEquationEXT glBlendEquation

#endif /* GL4ES_COMPAT_H */
