# jesuit-catalogs-server

API for the Jesuit Catalogs, a Project by the Institute for Advanced Jesuit Studies, Boston College

## About

Jesuit Catalogs Database is the new digital research tool being developed by the Institute for Advanced Jesuit Studies in collaboration with the Archivum Romanum Societatis Iesu and Boston College Libraries to facilitate research not only on the Society of Jesus, but also on modern age history. By indexing all the information from the Triennales catalogs, the platform will provide long-term historical qualitative and quantitative data on the Society of Jesus and its social history.

---

This is a full stack app (MySQL ExpressJS Angular NodeJS), and **this repository contains only the client and server code**.

For the data, see [this repository](https://github.com/BCDigSchol/jesuit-catalogs-data).

---

## Project Credits

### Founding Partners

* [Archivum Romanum Societatis Iesu](https://arsi.jesuits.global/en/home-eng/)
* [Institute for Advanced Jesuit Studies, Boston College](https://www.bc.edu/bc-web/centers/iajs.html)
* [Boston College Libraries](https://ds.bc.edu/)

### Project Editors (IAJS)

* Cristiano Casalini
* Alessandro Corsi

### Development Team (Boston College Libraries)

* [Boston College Digital Scholarship Group](https://ds.bc.edu/)
* David Thomas, Developer

### Project Collaborators

* Claudio Ferlan
* Elisa Frei
* Claudia Giordano
* Brent Gordon
* Zsófia Kádár
* Oliver Laband
* Maria Macchi
* Laura Madella
* Lorenzo Mancini
* Andrea Mariani
* Silvia Notarfonso
* David Piras
* David Salomoni
* Antonio Taiga Guterres
* Carolina Vaz de Carvalho
* Yiying Xin
* Dmitri Zharov
* Vavrinec Žeňuch

---

## Installation

Current installation is on a Docker setup.

Install docker, and docker-compose locally. Then clone this repo and move inside the directory. Finally, fetch the submodule, which contains the seeder data.

``` sh
git clone https://github.com/BCDigSchol/jesuit-catalogs-server.git
cd jesuit-catalogs-server
git submodule update --init --recursive
```

Thenm, modify the following files with your desired accounts/passwords/ports

``` sh
# most crucial, for setting account passwords
/docker-compose.yml
# you must change the server_name and redirect to have the url to which you are deploying
/nginx/nginx.conf
```

Now, launch the docker containers with `docker compose up -d`.

The run command in our `docker-compose.yml` should have gotten the SSL certifictes for us already.

After docker is up... use `docker exec` to shell into the server container...

``` sh
# run to get list of docker container names, look for server
docker ps
# shell into the server container
docker exec -it SERVER_CONTAINER_NAME sh
# run the server seeders
source migrate.sh
# exit out of container shell
exit
```

If you are running in a Windows environment, instead of running migrate.sh, run the following commands instead...

``` sh
./node_modules/.bin/sequelize db:create
./node_modules/.bin/sequelize db:migrate
./node_modules/.bin/sequelize db:seed:all
```

Now, set the certbot to autorenew.

``` sh
docker compose run --rm certbot renew
```

Then, stop the webserver, and output the dhparam key

``` sh
docker compose stop webserver
sudo openssl dhparam -out /home/YOUR_USERNAME/jesuit-catalogs-server/dhparam/dhparam-2048.pem 2048
```

Finally, modify the `nginx/nginx.conf` file and uncomment the lower server block. MAKE SURE to replace values with your domains. Then restart the server with `docker compose restart`.

That's it, the server should be up and running.

If you have problems and the docker container keeps restarting, the certbot might not have run correctly. To fix this, first, bring down the container with `docker compose down`. Then, re-comment out the SSH lines in your `nginx/nginx.conf` file. Now, bring the image back up with `docker compose up -d`. Then run the command `docker compose run --rm certbot certonly --webroot --webroot-path /var/www/html/ --email sample@your_domain --agree-tos --no-eff-email -d your_domain -d www.your_domain`. Once it is complete, un-comment out the `nginx/nginx.conf` file and `docker compose up -d` to get it started.

## Local Development

To develop locally, if you want to use docker, comment out the lines indicated for local development in `docker-compose.yml`. Then launch with `docker compose up -d`.

For vanilla npm operation, move inside the server directory and start the app. First, however, you must have MySql installed locally, and have set up a database, preferably named `jesuit-catalogs`, and created a user with full privileges on it named `jesuit-catalogs-owner` with the password `password`.

 ``` sh
 cd server
npm start
```

To run testing...

``` sh
npm test
```

That's it!

---

## Supplement: Tilemaker - To power the apps maps

Head to OpenStreetMap.org, and download the latest tile data named planet-latest.osm.pbf.

Place that file in the ./build-data folder, then run

```bash
docker build -t local/tilemaker -f .docker/tilemaker/Dockerfile .

# or if developing on apple silicon chip
docker buildx build --platform linux/amd64 -t local/tilemaker --load -f .docker/tilemaker/Dockerfile .

docker run --rm \
  -v "$(pwd)/build-data:/data" \
  -v "$(pwd)/tiles:/out" \
  local/tilemaker \
  --input /data/planet-latest.osm.pbf --output /out/planet-z5.mbtiles \
  --config /data/config.json --process /data/process.lua
```

For a small scale test build, run an osmium extract

```bash
osmium extract -b 5.5,50.0,9.5,53.0 -o /data/small-bbox.pbf /data/planet-latest.osm.pbf
```

Then build using the smaller extract

```bash
docker run --rm \
  -v "$(pwd)/build-data:/data" \
  -v "$(pwd)/tiles:/out" \
  local/tilemaker \
  --input /data/small-bbox.pbf --output /out/planet-z5.mbtiles \
  --config /data/config.json --process /data/process.lua
```