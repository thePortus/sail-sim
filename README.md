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
npm run download:terrain-tiles
# OR download in 2k
npm run download:terrain-tiles -- --2k
# now to build...
# random region + random seed
npm run terrain -- cyclades_naxos	that region, random seed
# OR specific seed
npm run terrain -- 42
# OR a specific region with a specific seed
npm run terrain -- cyclades_naxos 42
npm run migrate
```

Go to the port for the angular container specified in the docker compose and you should be set.

# Credits

Some textures from Polyhaven

Following [Popov72](https://github.com/Popov72/OceanDemo) for the ocean shader