# Use an official Node.js runtime as a parent image
FROM node:18-alpine as build

# Set the working directory
WORKDIR /client

# Copy the package.json and package-lock.json files
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build args for configuration and base href
ARG BUILD_CONFIG=production
ARG BASE_HREF=/

# Build the Angular application
RUN npm run build -- --configuration $BUILD_CONFIG --base-href $BASE_HREF

# Use an official Nginx image to serve the AngularJS application
FROM nginx:alpine

# Copy the built Angular application from the previous stage
COPY --from=build /client/dist/sail-sim/browser /usr/share/nginx/html

# Copy custom Nginx configuration file
COPY --from=build /client/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start Nginx server
CMD ["nginx", "-g", "daemon off;"]