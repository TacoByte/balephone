/* Minimal GLU replacements for the Emscripten build. gl4es provides GL but
   not GLU; the engine uses exactly two GLU entry points, both only ever with
   GL_RGBA / GL_UNSIGNED_BYTE data. */

#include <GL/gl.h>
#include <GL/glu.h>
#include <stdlib.h>
#include <stdint.h>

/* Bilinear scale of an RGBA8 image. */
GLint gluScaleImage(GLenum format,
                    GLsizei wIn, GLsizei hIn, GLenum typeIn, const void* dataIn,
                    GLsizei wOut, GLsizei hOut, GLenum typeOut, GLvoid* dataOut)
{
	if (format != GL_RGBA || typeIn != GL_UNSIGNED_BYTE || typeOut != GL_UNSIGNED_BYTE)
		return GLU_INVALID_ENUM;
	if (wIn <= 0 || hIn <= 0 || wOut <= 0 || hOut <= 0)
		return GLU_INVALID_VALUE;

	const uint8_t* src = (const uint8_t*)dataIn;
	uint8_t* dst = (uint8_t*)dataOut;

	for (int y = 0; y < hOut; y++)
	{
		float sy = (hOut > 1) ? (float)y * (hIn - 1) / (hOut - 1) : 0.0f;
		int y0 = (int)sy;
		int y1 = (y0 + 1 < hIn) ? y0 + 1 : y0;
		float fy = sy - y0;

		for (int x = 0; x < wOut; x++)
		{
			float sx = (wOut > 1) ? (float)x * (wIn - 1) / (wOut - 1) : 0.0f;
			int x0 = (int)sx;
			int x1 = (x0 + 1 < wIn) ? x0 + 1 : x0;
			float fx = sx - x0;

			const uint8_t* p00 = src + 4 * (y0 * wIn + x0);
			const uint8_t* p10 = src + 4 * (y0 * wIn + x1);
			const uint8_t* p01 = src + 4 * (y1 * wIn + x0);
			const uint8_t* p11 = src + 4 * (y1 * wIn + x1);
			uint8_t* out = dst + 4 * (y * wOut + x);

			for (int c = 0; c < 4; c++)
			{
				float top = p00[c] + (p10[c] - p00[c]) * fx;
				float bot = p01[c] + (p11[c] - p01[c]) * fx;
				float v = top + (bot - top) * fy;
				out[c] = (uint8_t)(v + 0.5f);
			}
		}
	}
	return 0;
}

GLint gluBuild2DMipmaps(GLenum target, GLint internalFormat,
                        GLsizei width, GLsizei height,
                        GLenum format, GLenum type, const void* data)
{
	glTexImage2D(target, 0, internalFormat, width, height, 0, format, type, data);
	glGenerateMipmap(target);
	return 0;
}
