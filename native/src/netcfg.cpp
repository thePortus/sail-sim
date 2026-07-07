#include "netcfg.hpp"

#include <cstdlib>

// Compiled-in defaults (from CMake). Fall back to localhost:9080 http if the build didn't set them.
#ifndef SAILSIM_SERVER_HOST
#define SAILSIM_SERVER_HOST "localhost"
#endif
#ifndef SAILSIM_SERVER_PORT
#define SAILSIM_SERVER_PORT 9080
#endif
#ifndef SAILSIM_SERVER_TLS_DEFAULT
#define SAILSIM_SERVER_TLS_DEFAULT 0
#endif
#ifndef SAILSIM_SERVER_PATH
#define SAILSIM_SERVER_PATH ""
#endif

namespace netcfg {
namespace {
std::string g_host = SAILSIM_SERVER_HOST;
int         g_port = SAILSIM_SERVER_PORT;
bool        g_tls  = false;
std::string g_path = SAILSIM_SERVER_PATH;
}  // namespace

void init() {
  if (const char* h = std::getenv("SAILSIM_HOST"); h && *h) g_host = h;
  if (const char* p = std::getenv("SAILSIM_PORT"); p && *p) g_port = std::atoi(p);
  if (const char* sp = std::getenv("SAILSIM_PATH")) g_path = sp;   // may be set empty to force no prefix
  while (!g_path.empty() && g_path.back() == '/') g_path.pop_back();   // no trailing slash (avoid //)
#if defined(SAILSIM_HAVE_TLS) && SAILSIM_HAVE_TLS
  // TLS only exists in a build compiled with OpenSSL. Env overrides the compiled default.
  const char* t = std::getenv("SAILSIM_TLS");
  g_tls = t && *t ? (std::atoi(t) != 0 || t[0] == 't' || t[0] == 'T')
                  : (SAILSIM_SERVER_TLS_DEFAULT != 0);
#else
  g_tls = false;
#endif
}

const std::string& host() { return g_host; }
int  port() { return g_port; }
bool tls()  { return g_tls; }
const std::string& serverPath() { return g_path; }
std::string apiPath(const std::string& p) { return g_path.empty() ? p : g_path + p; }

std::string baseUrl(const std::string& h, int p) {
  return (g_tls ? "https://" : "http://") + h + ":" + std::to_string(p);
}
const char* wsScheme() { return g_tls ? "wss" : "ws"; }

}  // namespace netcfg
