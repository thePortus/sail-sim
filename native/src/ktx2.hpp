// Decode a KTX2 (Basis Universal supercompressed) blob to 8-bit RGBA.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

// Returns true on success, filling outW/outH and outRGBA (w*h*4 bytes, top-left origin).
bool decodeKtx2ToRGBA(const uint8_t* data, size_t size, int& outW, int& outH, std::vector<uint8_t>& outRGBA);
