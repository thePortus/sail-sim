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
**public key** — a short base64 string. You pass it to the client build via the `SAILSIM_SPARKLE_PUBKEY` CMake
option (see *Building & releasing* below). The one key signs **both** macOS and Windows.

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
[`server/assets/client/README.md`](server/assets/client/README.md) for the full artifact layout.

## Building & releasing the desktop client

Each build **bakes in** the update feed URL + your public key from the step above, then you zip it and publish it
to the server. Build macOS on a Mac, Windows on a Windows machine. Feed URLs must be **HTTPS** in production
(Sparkle/WinSparkle refuse plain http); the pubkey defaults to the committed dev key, so override it with your
own.

### macOS (`.app` bundle)

``` sh
cd native
cmake -S . -B build-mac -DSAILSIM_MACOS_BUNDLE=ON \
  -DSAILSIM_SPARKLE_FEED_URL=https://your.server/client/appcast-mac.xml \
  -DSAILSIM_SPARKLE_PUBKEY=<your-public-key>
cmake --build build-mac
# → build-mac/bin/sailsim_native.app  (Sparkle.framework already embedded)
cd build-mac/bin && ditto -c -k --keepParent sailsim_native.app SailSim-<ver>-mac.zip
```

### Windows (`.exe`) — Visual Studio + CMake

``` sh
cd native
cmake -S . -B build-win -DSAILSIM_SPARKLE_FEED_URL_WIN=https://your.server/client/appcast-win.xml -DSAILSIM_SPARKLE_PUBKEY=<your-public-key>
cmake --build build-win --config Release
# → the build output folder (e.g. build-win\bin\Release) holds sailsim_native.exe AND WinSparkle.dll.
# Zip that whole folder (the .exe + WinSparkle.dll MUST travel together) as SailSim-<ver>-win.zip.
```

### Where the release files go on the live server

You don't copy them into place by hand — **the publish script does it**. Copy each zip to the machine running
the Node server, then run (once per platform per release):

``` sh
node server/scripts/client-release.js publish --platform mac --version <ver> --file SailSim-<ver>-mac.zip --base-url https://your.server/client
node server/scripts/client-release.js publish --platform win --version <ver> --file SailSim-<ver>-win.zip --base-url https://your.server/client
```

This writes into **`server/assets/client/`** — served at **`/client`** — the signed zips plus `appcast-mac.xml`
and `appcast-win.xml` (the feeds the installed clients poll). That folder is git-ignored (built artifacts), so a
fresh checkout/deploy starts empty and is filled by publishing.

**Docker:** `server/assets/client/` (the releases) and `server/.sparkle/` (your signing key) live inside the
container. Mount both as **volumes** so they survive container rebuilds — otherwise every redeploy wipes your
published releases and, critically, your signing key.

# Credits

Some textures from Polyhaven

Following [Popov72](https://github.com/Popov72/OceanDemo) for the ocean shader