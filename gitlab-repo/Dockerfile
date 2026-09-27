FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY url-tester.html /app/url-tester.html
COPY server/package.json /app/server/package.json
WORKDIR /app/server
RUN npm install --omit=dev
COPY server/ /app/server/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
