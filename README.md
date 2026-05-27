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

Go into container, build terrain files and run server migrations

``` sh
docker exec -it sail-sim-nodejs sh
npm run build:terrain
npm run migrate
```

Go to the port for the angular container specified in the docker compose and you should be set.

