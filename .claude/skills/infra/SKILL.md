---
name: infra
description: "MUST USE for ALL local infrastructure tasks in this repo: starting, stopping or checking Docker services (Postgres, the local S3 emulator), containers, compose files, ports, buckets, S3 env vars, or anything under infra/ except infra/bb-instance. Trigger on: 'spin up', 'bring up', 'tear down', 'start services', 'infra', 'containers', 'postgres', 'minio', 's3', 'bucket', 'local development'. Load this BEFORE running any docker or docker compose command."
---

# Local infrastructure

Stack in `infra/docker-compose.yml`: **Postgres 17 + pgvector** and a **local S3 emulator (RustFS)**. The BB instance has its own provisioning, see the `bb-instance` skill.

## Naming rule

Everything is grouped under the package name `brandwise`: compose `name: brandwise`, containers `brandwise-<service>`, volumes `brandwise-<purpose>`. Never rely on the folder name. Verify after `up`: `docker compose ls` must show project `brandwise`.

## Commands

```bash
pnpm infra:up      # docker compose -f infra/docker-compose.yml up -d --wait
pnpm infra:down    # stop, volumes stay
docker compose -f infra/docker-compose.yml ps
docker exec marketing-ai-postgres psql -U marketing_ai -d marketing_ai
```

Always pass `-f infra/docker-compose.yml`. Docker commands need the sandbox off (the Colima socket is blocked inside it).

## Services

| Service | Container | Host port | Notes |
|---|---|---|---|
| Postgres 17 + pgvector | marketing-ai-postgres | 127.0.0.1:5436 | user/password/db `marketing_ai` |
| S3 emulator (RustFS) | marketing-ai-s3 | API 127.0.0.1:9010, console 9011 | keys `marketing-ai` / `marketing-ai-secret` |
| bucket creator | marketing-ai-s3-init | none | one-shot (aws-cli), creates the private bucket `marketing-ai-assets`, exits 0 |

Other stacks use 5432–5435, 1025–1027 and 9090–9091; do not stop containers of other projects, report the conflict.

## Local vs production storage

The app uses only `S3_*` variables (`.env.example`): `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`. Switching to Cloudflare R2, AWS S3 or Backblaze B2 changes these values only, never code. Keys, buckets and the asset table are described in `docs/assets.md`.

## Gotchas

- Official MinIO images are not pullable from Docker Hub or quay.io (checked 2026-10-29), that is why the emulator is RustFS. `mc` is gone too; use `amazon/aws-cli` against `--endpoint-url`.
- To test a presigned URL from the host, sign for `host.docker.internal:9010` and call it with `curl --resolve host.docker.internal:9010:127.0.0.1`, otherwise the signature host does not match.
- Confirm before anything destructive (removing volumes, `docker system prune`).
