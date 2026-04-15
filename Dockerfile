# Use Apify's official Node.js base image
FROM apify/actor-node:20

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY . ./

# Run the actor
CMD npm start
