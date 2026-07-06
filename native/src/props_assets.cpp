#include "props_assets.hpp"

#include <cstdio>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include "stb_image.h"        // implementation lives in stb_impl.cpp

namespace props {

static Image fetchImage(httplib::Client& cli, const std::string& path) {
  Image out;
  auto res = cli.Get(path.c_str());
  if (!res || res->status != 200) {
    std::printf("[props] fetch %s failed (%d)\n", path.c_str(), res ? res->status : 0);
    return out;
  }
  int w = 0, h = 0, comp = 0;
  unsigned char* pix = stbi_load_from_memory(
      reinterpret_cast<const unsigned char*>(res->body.data()),
      (int)res->body.size(), &w, &h, &comp, 4);
  if (!pix) {
    std::printf("[props] decode %s failed: %s\n", path.c_str(), stbi_failure_reason());
    return out;
  }
  out.w = w; out.h = h;
  out.rgba.assign(pix, pix + (size_t)w * h * 4);
  stbi_image_free(pix);
  out.ok = true;
  return out;
}

// Fraction of the image height that is fully transparent below the content —
// the client's measureBottomPad, used to sit the impostor's base on the ground.
static float bottomPad(const Image& img) {
  for (int y = img.h - 1; y >= 0; --y) {
    const uint8_t* row = img.rgba.data() + (size_t)y * img.w * 4;
    for (int x = 0; x < img.w; ++x)
      if (row[x * 4 + 3] >= 16) return (float)(img.h - 1 - y) / (float)img.h;
  }
  return 0.0f;
}

Set fetchAll(const std::string& host, int port) {
  Set s;
  httplib::Client cli(host, port);
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(30, 0);
  bool all = true;

  // ── Ship impostor atlases ──
  if (auto res = cli.Get("/geometry/ship_impostors/ship_impostors_manifest.json");
      res && res->status == 200) {
    auto j = nlohmann::json::parse(res->body, nullptr, false);
    if (!j.is_discarded() && j.contains("ships")) {
      auto num = [](const nlohmann::json& o, const char* k, float dflt) -> float {
        auto it = o.find(k);
        return (it != o.end() && it->is_number()) ? it->get<float>() : dflt;
      };
      for (auto& [slug, m] : j["ships"].items()) {
        ShipAtlas a;
        a.size = num(m, "size", 0.0f); a.centerY = num(m, "centerY", a.size * 0.4f);
        a.n = (int)num(m, "n", 16.0f); a.cols = (int)num(m, "cols", (float)a.n);
        a.img = fetchImage(cli, "/geometry/ship_impostors/" + slug + "_atlas.png");
        all = all && a.img.ok;
        if (a.img.ok) s.ships.emplace(slug, std::move(a));
      }
    }
  } else { all = false; }

  // ── Town building impostors ──
  if (auto res = cli.Get("/geometry/harbors/impostors/impostors_manifest.json");
      res && res->status == 200) {
    auto j = nlohmann::json::parse(res->body, nullptr, false);
    if (!j.is_discarded() && j.contains("buildings")) {
      auto num = [](const nlohmann::json& o, const char* k, float dflt) -> float {
        auto it = o.find(k);
        return (it != o.end() && it->is_number()) ? it->get<float>() : dflt;
      };
      for (auto& [asset, m] : j["buildings"].items()) {
        BuildingImp b;
        b.size = num(m, "size", 0.0f);
        b.img = fetchImage(cli, "/geometry/harbors/impostors/" + asset + "_imp.png");
        if (b.img.ok) b.basePad = bottomPad(b.img);
        all = all && b.img.ok;
        if (b.img.ok) s.buildings.emplace(asset, std::move(b));
      }
    }
  } else { all = false; }

  s.ok = all && !s.ships.empty();
  std::printf("[props] impostors: %zu ship atlases, %zu building types%s\n",
              s.ships.size(), s.buildings.size(), all ? "" : " (INCOMPLETE)");
  return s;
}

std::vector<VesselRow> fetchVessels(const std::string& host, int port) {
  std::vector<VesselRow> out;
  httplib::Client cli(host, port);
  cli.set_connection_timeout(8, 0);
  cli.set_read_timeout(15, 0);
  auto res = cli.Get("/vessels");
  if (!res || res->status != 200) { std::printf("[props] /vessels failed (%d)\n", res ? res->status : 0); return out; }
  auto j = nlohmann::json::parse(res->body, nullptr, false);
  if (j.is_discarded() || !j.is_array()) return out;
  auto num = [](const nlohmann::json& o, const char* k, float dflt) -> float {
    auto it = o.find(k);
    return (it != o.end() && it->is_number()) ? it->get<float>() : dflt;
  };
  for (const auto& v : j) {
    if (!v.is_object()) continue;
    VesselRow r;
    r.slug = v.value("slug", std::string());
    r.name = v.value("name", std::string());
    r.description = v.value("description", std::string());
    r.price = (int)num(v, "price", 0); r.cargo = (int)num(v, "cargo", 0);
    r.guns = (int)num(v, "guns", 0); r.maxSpeed = num(v, "maxSpeed", 0);
    r.cannonUpgradeCost = (int)num(v, "cannonUpgradeCost", 0);
    r.armorUpgradeCost  = (int)num(v, "armorUpgradeCost", 0);
    if (!r.slug.empty()) out.push_back(std::move(r));
  }
  return out;
}

} // namespace props
