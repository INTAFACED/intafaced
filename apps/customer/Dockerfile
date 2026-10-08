# Sole customer site; build from the repository root, independently of the
# service/admin image. Only browser assets reach the Nginx runtime stage.
FROM node:22-bookworm-slim AS build
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/customer ./apps/customer
RUN pnpm install --frozen-lockfile --filter '@intafaced/customer...'
ARG VITE_TEAM_URL
ENV VITE_TEAM_URL=$VITE_TEAM_URL
RUN node apps/customer/deployment/validate-env.mjs \
    && pnpm --filter '@intafaced/customer^...' build \
    && pnpm --filter @intafaced/customer build

FROM nginx:1.30.5-alpine AS runtime
COPY apps/customer/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/customer/dist /usr/share/nginx/html
EXPOSE 80
