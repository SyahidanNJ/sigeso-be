FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends pandoc ca-certificates curl \
 && curl -fsSL https://github.com/typst/typst/releases/download/v0.15.1/typst-x86_64-unknown-linux-musl.tar.xz -o /tmp/typst.tar.xz \
 && tar -xJf /tmp/typst.tar.xz -C /tmp && mv /tmp/typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
 && rm -rf /tmp/typst* /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV PORT=3001 TYPST_BIN=typst PANDOC_BIN=pandoc
EXPOSE 3001
CMD ["node", "src/index.js"]
