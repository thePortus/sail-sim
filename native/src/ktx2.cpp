#include "ktx2.hpp"

#include "basisu_transcoder.h"

#include <mutex>

bool decodeKtx2ToRGBA(const uint8_t* data, size_t size, int& outW, int& outH, std::vector<uint8_t>& outRGBA) {
  static std::once_flag once;
  std::call_once(once, [] { basist::basisu_transcoder_init(); });

  basist::ktx2_transcoder t;
  if (!t.init(data, (uint32_t)size)) return false;
  if (!t.start_transcoding()) return false;

  const uint32_t w = t.get_width();
  const uint32_t h = t.get_height();
  if (w == 0 || h == 0) return false;

  outW = (int)w;
  outH = (int)h;
  outRGBA.resize((size_t)w * h * 4);

  return t.transcode_image_level(
      0, 0, 0,                                        // level, layer, face
      outRGBA.data(), w * h,                          // output, size in pixels (RGBA32)
      basist::transcoder_texture_format::cTFRGBA32,
      0, w, h);                                        // flags, row pitch (pixels), rows
}
