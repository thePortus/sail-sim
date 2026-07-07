# sail-sim

Lazy vibe coded sailing sim

## Installation

Clone repo, install/initialize/pull git lfs files

``` sh
git clone https://github.com/thePortus/sail-sim.git
sudo apt install git-lfs
git lfs install
git lfs pull
```

Build the docker images

``` sh
docker compose up --build -d
```

Download opentopo files for terrain generation

```
Edit .env.example, change it to .env.... and put in your opentopography.org API key (you have to sign up for an account)
```

Go into container, build terrain files and run server migrations

``` sh
docker exec -it sail-sim-nodejs sh
# get source maps
npm run fetch:terrain-sources
# get basic ground and night sky textures
npm run download:terrain-tiles
# OR download in 2k
npm run download:terrain-tiles -- --2k
# now to build...
# random region + random seed
npm run terrain -- cyclades_naxos
# OR specific seed
npm run terrain -- 42
# OR a specific region with a specific seed
npm run terrain -- cyclades_naxos 42
npm run migrate
```

Go to the port for the angular container specified in the docker compose and you should be set.

## Auto-update signing key (native client)

The native desktop client auto-updates itself (Sparkle on macOS, WinSparkle on Windows). For that to be safe,
every update you publish is **signed** with a private key that only you hold, and the matching **public key** is
baked into the client. A client will refuse to install any update that isn't signed by your key — so nobody can
push a malicious "update" to your players. (This is Sparkle's own update signature. It is separate from — and
much simpler than — Apple notarization / Windows code-signing, which come later.)

If you've never done this before, here's the whole thing:

**1. Generate your key once, on the server, right after cloning:**

``` sh
node server/scripts/client-release.js keygen
```

This creates an Ed25519 key pair in `server/.sparkle/` (already git-ignored, like `.env`) and prints your
**public key** — a short base64 string. Copy it somewhere; you'll paste it into the client build config when the
updater is wired in (macOS `Info.plist` `SUPublicEDKey`, Windows `win_sparkle_set_eddsa_public_key`).

**2. Two rules — treat the private key like a password, or worse:**

- **Never commit it.** It lives in `server/.sparkle/ed25519_private.pem`, which `.gitignore` already excludes —
  don't force-add it.
- **Back it up** (a password manager / secrets vault). If you lose this key you can **never ship another update
  to already-installed clients** — the public key baked into their copy won't match a new key, so they'd all
  have to manually re-download the client. There is no recovery. For a deployed server, store the private key as
  a CI/deploy secret rather than leaving it only on one machine.

**3. Publish a build** (once per platform per release; use your real public HTTPS URL — Sparkle requires HTTPS in
production):

``` sh
node server/scripts/client-release.js publish \
  --platform mac --version 0.2.0 --file /path/to/SailSim-0.2.0-mac.zip \
  --base-url https://your.server/client --notes "What changed"
```

That signs the build and writes the update feed the clients poll. See
[`server/assets/client/README.md`](server/assets/client/README.md) for the full artifact layout and the Windows
command.

# Credits

Some textures from Polyhaven

Following [Popov72](https://github.com/Popov72/OceanDemo) for the ocean shader