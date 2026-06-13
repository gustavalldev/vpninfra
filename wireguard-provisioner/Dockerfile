FROM node:20-alpine

RUN apk add --no-cache iproute2 iptables wireguard-tools

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

CMD ["node", "server.js"]
