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

The desktop client is built **on the OS it targets** (macOS on a Mac, Windows on a Windows PC), then the build is
**uploaded to the live Ubuntu server** over SSH, where the publish script **signs it and updates the feed** that
installed clients poll.

Key idea: your **signing key stays on the server** (`server/.sparkle/`, from the keygen step above). Your dev
machines only ever upload the *unsigned* build zip — the private key never travels. So each release is three
steps: **build → upload → publish**.

Throughout, replace the placeholders: `<ver>` = the release version (e.g. `0.2.0`; must match `SAILSIM_VERSION`
in `native/CMakeLists.txt`), `you@your.server` = your SSH login to the Ubuntu box, `https://your.server` = your
public HTTPS site, `<your-public-key>` = the base64 key printed by keygen, and `sail-sim-nodejs` = your Node
container's name (from `docker compose`). Feed URLs **must be HTTPS** in production (Sparkle/WinSparkle refuse
plain http). One SSH key from each dev machine to the server makes `scp` passwordless.

### Step 1 — Build the client

**On a Mac** (produces the `.app` bundle, Sparkle embedded):

``` sh
cd native
cmake -S . -B build-mac -DSAILSIM_MACOS_BUNDLE=ON \
  -DSAILSIM_SPARKLE_FEED_URL=https://your.server/client/appcast-mac.xml \
  -DSAILSIM_SPARKLE_PUBKEY=<your-public-key>
cmake --build build-mac
# Zip the .app (ditto preserves the bundle's symlinks — a plain zip can corrupt it):
cd build-mac/bin && ditto -c -k --keepParent sailsim_native.app SailSim-<ver>-mac.zip
```

**On a Windows PC** (Visual Studio + CMake installed; run in PowerShell). The build drops
`sailsim_native.exe` **and** `WinSparkle.dll` into the output folder — they must ship together:

``` powershell
cd native
cmake -S . -B build-win -DSAILSIM_SPARKLE_FEED_URL_WIN=https://your.server/client/appcast-win.xml -DSAILSIM_SPARKLE_PUBKEY=<your-public-key>
cmake --build build-win --config Release
# Zip the whole output folder (.exe + WinSparkle.dll):
Compress-Archive -Path build-win\bin\Release\* -DestinationPath SailSim-<ver>-win.zip
```

### Step 2 — Upload the zip to the Ubuntu server (SSH)

Copy the zip into a scratch dir on the server. `scp` ships with macOS and with Windows 10/11 (the built-in
OpenSSH client, so it works in PowerShell too):

``` sh
# from the Mac:
scp build-mac/bin/SailSim-<ver>-mac.zip you@your.server:/tmp/
```
``` powershell
# from Windows (PowerShell):
scp native\SailSim-<ver>-win.zip you@your.server:/tmp/
```
(Prefer a GUI on Windows? **WinSCP** does the same drag-and-drop. `rsync` works too if you have WSL.) Nothing
extra is needed on the server beyond the SSH access it already has.

### Step 3 — Publish on the server

Your Node server runs in Docker, so `server/.sparkle/` (the key) and `server/assets/client/` (the releases) live
*inside* the container. Copy the uploaded zip into the container and run the publish script there — it signs the
zip and writes the feed:

``` sh
# on the Ubuntu host, for each platform you uploaded:
docker cp /tmp/SailSim-<ver>-mac.zip sail-sim-nodejs:/tmp/
docker exec -it sail-sim-nodejs \
  node server/scripts/client-release.js publish \
    --platform mac --version <ver> --file /tmp/SailSim-<ver>-mac.zip \
    --base-url https://your.server/client

docker cp /tmp/SailSim-<ver>-win.zip sail-sim-nodejs:/tmp/
docker exec -it sail-sim-nodejs \
  node server/scripts/client-release.js publish \
    --platform win --version <ver> --file /tmp/SailSim-<ver>-win.zip \
    --base-url https://your.server/client
```

Publish writes the signed zip + `appcast-mac.xml` / `appcast-win.xml` into `server/assets/client/`, served at
**`/client`** — the feed URLs you baked into the builds. Installed clients pick up the update on their next
launch. Done.

### Persistence across deploys (already configured)

`server/assets/client/` (the releases) and `server/.sparkle/` (your signing key) are git-ignored, so they're
**not** baked into the image. `docker-compose.yml` bind-mounts both from the host, so `docker compose up --build`
keeps them — the releases via the existing `./server/assets` mount, the key via `./server/.sparkle`. Because
they're host paths, you can also skip the `docker cp` and run the publish script on the host (with Node
installed), pointing `--file` straight at `server/assets/client` on disk. **Back up `server/.sparkle/` off the
host regardless** — a bind mount protects it from rebuilds, not from the box dying.

# Credits

Some textures from Polyhaven

Following [Popov72](https://github.com/Popov72/OceanDemo) for the ocean shader