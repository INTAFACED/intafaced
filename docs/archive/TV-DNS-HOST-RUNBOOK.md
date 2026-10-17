# DNS / Host runbook — trade.intafaced.com

## Target

`trade.intafaced.com` → static site in `sites/sovereign-os/` (monorepo SoT)

## Live now (interim — no Nitro DNS required)

| Item       | Value                                                                        |
| ---------- | ---------------------------------------------------------------------------- |
| Public URL | https://zenyoda3.github.io/intafaced-sovereign-os/                           |
| Host       | GitHub Pages on mirror `ZenYoda3/intafaced-sovereign-os`                     |
| Monorepo   | `Phantom-X-007/intafaced` → `sites/sovereign-os/**` on main                  |
| Sync rule  | After monorepo site edits, re-publish mirror or point Pages at monorepo path |

## Host options (priority for cutover)

1. **Cloudflare Pages / any static host** with custom domain, root = `sites/sovereign-os`
2. **GitHub Pages** from monorepo path or dedicated `gh-pages` branch of site folder only
3. **Keep interim** ZenYoda3 Pages until custom domain ready
4. **Emergency only:** cloudflared quick tunnel for private review (not apply URL)

## DNS records (when Nitro has registrar — Class X)

| Type  | Name  | Value           |
| ----- | ----- | --------------- |
| CNAME | trade | `<host-target>` |

Apex `intafaced.com` payments site: **do not modify** except adding subdomain.

## SSL

Host-managed cert; force HTTPS.

## AFK / agent note

Custom domain is **optional**. Agent finish line is public HTTPS + pack-ready. Inventing or purchasing host/DNS without Nitro is banned (Class X).
