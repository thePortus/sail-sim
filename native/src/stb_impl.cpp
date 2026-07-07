// Single translation unit that compiles the stb image implementations.
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

// stb_image (read/decode) — decodes the JPEG moon/star sky textures fetched from
// the server (/sky/moon, /sky/stars).
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

// stb_image_resize2 — downsamples the 8192-wide star map to bound VRAM.
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"
