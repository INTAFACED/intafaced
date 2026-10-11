# The vendored trading shell — the app the platform is supposed to BE.
#
# WHY THIS FILE DID NOT EXIST UNTIL NOW, which is the important part.
#
# The stated product direction has always been: the vendored exchange is the
# main app, and our services are added underneath it. 74 Vue screens, 78 routes,
# a complete trading UI.
#
# It has never been deployable. No `dist/`, no Dockerfile, in no compose file.
# The only way to see it was `npm run dev` on a developer's machine. Documents
# referred readers to `:8090`; nothing has ever served that port. Meanwhile a
# separate Next.js app under `apps/` became the de-facto product on :3000, and
# the drift was invisible because nobody could run the thing being drifted from.
#
# This makes it real: build it, serve it, put it in the fleet.
#
# Node 24 is an active LTS line. Webpack 5 removes the Webpack 3/MD4 reason this
# image was pinned to EOL Node 16; no OpenSSL legacy-provider escape hatch is
# needed.
FROM node:24.20.0-alpine AS build

WORKDIR /app

# npm, not pnpm. This tree has its own lockfile from the upstream vendor and is
# NOT part of the pnpm workspace — deliberately, so its 2017 dependency graph
# cannot reach our services.
COPY package.json package-lock.json* ./
# The retained legacy Nightwatch tree has an x64-only chromedriver lifecycle
# installer. It is not used to compile or serve this SPA, so keep the image
# install deterministic and architecture-neutral by not executing dependency
# lifecycle scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund

# `.dockerignore` keeps the host's `node_modules` and `dist` out of this. Without
# it, this line copies a 330 MB host tree over the install above — so the image
# shipped whatever was on the builder's machine instead of what the lockfile
# pins, and a stale local `dist` could be served as if it were this commit.
COPY . .

# Approved public privacy text is compiled into the SPA; these are not secrets.
ARG OUTREACH_CONTACT_URL
ARG OUTREACH_RETENTION_NOTICE
ENV OUTREACH_CONTACT_URL=$OUTREACH_CONTACT_URL
ENV OUTREACH_RETENTION_NOTICE=$OUTREACH_RETENTION_NOTICE

RUN npm run build

# ── serve ───────────────────────────────────────────────────────────────────
#
# nginx rather than webpack-dev-server: the dev server is not a production
# server, and running one in the fleet is how a dev-only default reaches a host.
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
