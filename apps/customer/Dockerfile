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
# Security headers. The CSP is rendered at container start (the official image's
# entrypoint runs envsubst over /etc/nginx/templates) from these optional
# variables, all empty by default:
#   CUSTOMER_LIVEKIT_ORIGIN  Academy live-session media server, e.g. wss://lk.example.com
#   CUSTOMER_STORAGE_ORIGIN  origin of presigned recorded-video URLs (ACADEMY_VIDEO_S3_ENDPOINT)
#   CUSTOMER_MEDIA_ORIGINS   further https origins for <video>/<audio>, space separated
# An invalid value stops the container at start. The filter keeps envsubst away
# from nginx's own $variables.
COPY apps/customer/security-headers.conf.template /etc/nginx/templates/security-headers.conf.template
COPY apps/customer/security-headers-api.conf /etc/nginx/snippets/security-headers-api.conf
COPY apps/customer/csp-origins.envsh /docker-entrypoint.d/16-customer-csp-origins.envsh
RUN chmod 0755 /docker-entrypoint.d/16-customer-csp-origins.envsh
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets \
    NGINX_ENVSUBST_FILTER=^CUSTOMER_CSP_
COPY --from=build /app/apps/customer/dist /usr/share/nginx/html
EXPOSE 80
