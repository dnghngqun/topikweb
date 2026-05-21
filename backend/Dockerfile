FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache poppler-utils
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts

EXPOSE 4000
CMD ["npm", "start"]
