# One image runs the app, the worker, migrations and the test suite.
# Not slim on purpose: dev deps (tsx, vitest, drizzle-kit) are needed by
# the worker and test services, and one image keeps `compose up` simple.
FROM node:24-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
