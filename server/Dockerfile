FROM node:18-alpine

WORKDIR /server

# copy project code
COPY . /server

# copy package.json and install dependencies
RUN npm install
# convert dos to unix style line endings (if needed for a Windows machine)
RUN apk add dos2unix
RUN dos2unix /server/migrate.sh

# expose the port
EXPOSE 8080

# start the application
CMD npm start