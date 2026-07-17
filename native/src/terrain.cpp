#include "terrain.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include <httplib.h>
#include "netcfg.hpp"
#include <nlohmann/json.hpp>

#include "asset_cache.hpp"

using json = nlohmann::json;

namespace terrain {

bool Terrain::load(const std::string& host, int port) {
  httplib::Client cli(netcfg::baseUrl(host, port));
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(15, 0);

  // ── Manifest (through the ETag disk cache) ──
  auto mres = assetcache::get(cli, "/terrain/manifest");
  if (!mres.ok) {
    std::printf("[terrain] manifest fetch failed\n");
    return false;
  }
  json j = json::parse(mres.bytes, nullptr, false);
  if (j.is_discarded() || !j.is_object()) { std::printf("[terrain] manifest parse failed\n"); return false; }

  m_.width       = j.value("width", 0);
  m_.height      = j.value("height", 0);
  m_.chunkSize   = j.value("chunkSize", 256);
  m_.chunkCountX = j.value("chunkCountX", 0);
  m_.chunkCountZ = j.value("chunkCountZ", 0);
  m_.quant       = j.value("quantizationLevels", 65535.0);
  m_.minE        = j.value("minElevation", 0.0);
  m_.maxE        = j.value("maxElevation", 0.0);
  m_.source      = j.value("source", std::string());
  m_.sourceName  = j.value("sourceName", std::string());
  if (j.contains("worldBounds")) {
    const json& b = j["worldBounds"];
    m_.minX = b.value("minX", -25000.0); m_.maxX = b.value("maxX", 25000.0);
    m_.minZ = b.value("minZ", -25000.0); m_.maxZ = b.value("maxZ", 25000.0);
  }
  if (j.contains("harbors") && j["harbors"].is_array()) {
    for (const auto& h : j["harbors"]) {
      Harbor hb;
      hb.id      = h.value("id", std::string());
      hb.name    = h.value("name", std::string());
      hb.faction = h.value("faction", std::string());
      hb.tier    = h.value("tier", std::string());
      hb.variant = h.value("variant", std::string());
      hb.x = h.value("x", 0.0f); hb.z = h.value("z", 0.0f); hb.heading = h.value("heading", 0.0f);
      // Null-tolerant number read (a bare .value() throws type_error on null).
      auto num = [](const json& o, const char* k, float dflt) -> float {
        auto it = o.find(k);
        return (it != o.end() && it->is_number()) ? it->get<float>() : dflt;
      };
      if (h.contains("pad") && h["pad"].is_object()) {
        const auto& pd = h["pad"];
        hb.padElev = num(pd, "elev", 0.0f);
        hb.pad.cx = num(pd, "cx", 0.0f);       hb.pad.cz = num(pd, "cz", 0.0f);
        hb.pad.halfX = num(pd, "halfX", 0.0f); hb.pad.halfZ = num(pd, "halfZ", 0.0f);
        hb.pad.rotY = num(pd, "rotY", 0.0f);
        hb.pad.valid = hb.pad.halfX > 0.0f && hb.pad.halfZ > 0.0f;
      }
      if (h.contains("buildings") && h["buildings"].is_array()) {
        for (const auto& b : h["buildings"]) {
          if (!b.is_object()) continue;
          Building bd;
          bd.asset = (b.contains("asset") && b["asset"].is_string()) ? b["asset"].get<std::string>() : std::string();
          bd.x = num(b, "x", 0.0f); bd.z = num(b, "z", 0.0f); bd.rotY = num(b, "rotY", 0.0f);
          if (!bd.asset.empty()) hb.buildings.push_back(bd);
        }
      }
      if (h.contains("square") && h["square"].is_object()) {
        const auto& sq = h["square"];
        hb.square.cx = num(sq, "cx", 0.0f); hb.square.cz = num(sq, "cz", 0.0f);
        hb.square.halfX = num(sq, "halfX", 0.0f); hb.square.halfZ = num(sq, "halfZ", 0.0f);
        hb.square.rotY = num(sq, "rotY", 0.0f);
        hb.square.valid = hb.square.halfX > 0.0f && hb.square.halfZ > 0.0f;
      }
      if (h.contains("streets") && h["streets"].is_array()) {
        for (const auto& s : h["streets"]) {
          if (!s.is_object()) continue;
          Street st;
          st.x1 = num(s, "x1", 0.0f); st.z1 = num(s, "z1", 0.0f);
          st.x2 = num(s, "x2", 0.0f); st.z2 = num(s, "z2", 0.0f);
          st.w = num(s, "width", 5.0f);
          hb.streets.push_back(st);
        }
      }
      if (h.contains("walls") && h["walls"].is_array()) {
        for (const auto& w : h["walls"]) {
          if (!w.is_object()) continue;
          WallNode wn;
          wn.x = num(w, "x", 0.0f); wn.z = num(w, "z", 0.0f);
          std::string tag = (w.contains("tag") && w["tag"].is_string()) ? w["tag"].get<std::string>() : std::string();
          wn.tag = tag == "gate" ? 2 : tag == "bastion" ? 1 : 0;
          hb.walls.push_back(wn);
        }
      }
      if (h.contains("forts") && h["forts"].is_array()) {
        for (const auto& f : h["forts"]) {
          if (!f.is_object()) continue;
          Fort ft;
          ft.glb  = (f.contains("glb")  && f["glb"].is_string())  ? f["glb"].get<std::string>()  : std::string();
          ft.tier = (f.contains("tier") && f["tier"].is_string()) ? f["tier"].get<std::string>() : std::string();
          ft.x = num(f, "x", 0.0f); ft.z = num(f, "z", 0.0f); ft.y = num(f, "y", 0.0f);
          ft.heading = num(f, "heading", 0.0f);
          ft.hd = num(f, "hd", 0.0f); ft.hw = num(f, "hw", 0.0f);
          if (f.contains("flag") && f["flag"].is_array() && f["flag"].size() == 3) {
            ft.hasFlag = true;
            ft.flagX = f["flag"][0].get<float>(); ft.flagY = f["flag"][1].get<float>(); ft.flagZ = f["flag"][2].get<float>();
          }
          ft.accent = f.value("accent", false);
          if (f.contains("guns") && f["guns"].is_array())
            for (const auto& g : f["guns"]) {
              if (!g.is_object()) continue;
              Gun gn;
              gn.x = num(g, "x", 0.0f); gn.z = num(g, "z", 0.0f); gn.y = num(g, "y", 0.0f);
              gn.heading = num(g, "heading", 0.0f); gn.range = num(g, "range", 0.0f);
              gn.reload = num(g, "reload", 0.0f); gn.damage = num(g, "damage", 0.0f);
              ft.guns.push_back(gn);
            }
          if (!ft.glb.empty()) hb.forts.push_back(ft);
        }
      }
      m_.harbors.push_back(hb);
    }
  }
  if (j.contains("spawns") && j["spawns"].is_array()) {
    for (const auto& s : j["spawns"]) {
      Spawn sp; sp.x = s.value("x", 0.0f); sp.z = s.value("z", 0.0f); sp.heading = s.value("heading", 0.0f);
      m_.spawns.push_back(sp);
    }
  }

  if (m_.width <= 0 || m_.height <= 0) { std::printf("[terrain] bad dimensions\n"); return false; }

  // ── Chunks -> raw quantized heightfield ──
  std::vector<uint16_t> hf((size_t)m_.width * m_.height, 0);
  const int cs = m_.chunkSize;
  for (int cz = 0; cz < m_.chunkCountZ; ++cz) {
    for (int cx = 0; cx < m_.chunkCountX; ++cx) {
      std::string path = "/terrain/chunk/" + std::to_string(cz) + "/" + std::to_string(cx);
      auto cres = assetcache::get(cli, path);
      if (!cres.ok) {
        std::printf("[terrain] chunk %d/%d fetch failed\n", cz, cx);
        return false;
      }
      const std::string& body = cres.bytes;
      const int x0 = cx * cs, z0 = cz * cs;
      const int cw = std::min(cs, m_.width - x0);
      const int ch = std::min(cs, m_.height - z0);
      if ((int)body.size() < cw * ch * 2) { std::printf("[terrain] chunk %d/%d short\n", cz, cx); return false; }
      const uint8_t* p = (const uint8_t*)body.data();
      size_t o = 0;
      for (int z = 0; z < ch; ++z) {
        uint16_t* row = &hf[(size_t)(z0 + z) * m_.width + x0];
        for (int x = 0; x < cw; ++x, o += 2)
          row[x] = (uint16_t)(p[o] | (p[o + 1] << 8));   // Uint16LE
      }
    }
  }

  // ── Decode to metres ──
  const double span = (m_.maxE - m_.minE) / m_.quant;
  elevF_.resize(hf.size());
  for (size_t i = 0; i < hf.size(); ++i)
    elevF_[i] = (float)(hf[i] * span + m_.minE);

  loaded_ = true;
  std::printf("[terrain] loaded '%s' %dx%d, elevation %.0f..%.0f m, %d harbors\n",
              m_.sourceName.c_str(), m_.width, m_.height, m_.minE, m_.maxE, (int)m_.harbors.size());
  return true;
}

float Terrain::elevation(float worldX, float worldZ) const {
  if (!loaded_) return 0.0f;
  const int W = m_.width, H = m_.height;
  // World -> texel, matching the client's GPU convention (+Z south).
  double ux = (worldX - m_.minX) / (m_.maxX - m_.minX);
  double uz = (m_.maxZ - worldZ) / (m_.maxZ - m_.minZ);
  double px = ux * W - 0.5, pz = uz * H - 0.5;
  int x0 = (int)std::floor(px), z0 = (int)std::floor(pz);
  float tx = (float)(px - x0), tz = (float)(pz - z0);
  auto clampi = [](int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); };
  int xa = clampi(x0, 0, W - 1), xb = clampi(x0 + 1, 0, W - 1);
  int za = clampi(z0, 0, H - 1), zb = clampi(z0 + 1, 0, H - 1);
  const float* f = elevF_.data();
  float h00 = f[(size_t)za * W + xa], h10 = f[(size_t)za * W + xb];
  float h01 = f[(size_t)zb * W + xa], h11 = f[(size_t)zb * W + xb];
  float a = h00 + (h10 - h00) * tx;
  float b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

} // namespace terrain
