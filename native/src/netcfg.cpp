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

namespace netcfg {
namespace {
std::string g_host = SAILSIM_SERVER_HOST;
int         g_port = SAILSIM_SERVER_PORT;
bool        g_tls  = false;
}  // namespace

void init() {
  if (const char* h = std::getenv("SAILSIM_HOST"); h && *h) g_host = h;
  if (const char* p = std::getenv("SAILSIM_PORT"); p && *p) g_port = std::atoi(p);
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

std::string baseUrl(const std::string& h, int p) {
  return (g_tls ? "https://" : "http://") + h + ":" + std::to_string(p);
}
const char* wsScheme() { return g_tls ? "wss" : "ws"; }

}  // namespace netcfg
