FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY index.js ./
COPY lib/ ./lib/
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "index.js"]
