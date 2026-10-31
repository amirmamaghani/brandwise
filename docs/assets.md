# Campaigns and assets

Decided 2026-10-29: content is divided by **campaign** (`campaign_id`), not by company, and files live in **S3 storage**. Metadata is in Postgres.

## Campaign

A campaign is the unit that content belongs to. Creatives differ between periods, so they must not be mixed with permanent ones. We do not use the word "project", because in BB a project is a repository.

```sql
create table campaign (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references campaign(id),  -- always-on base -> campaign
  root_id    uuid not null,                 -- root of the tree, RLS is based on it (customer isolation)
  name       text not null,
  kind       text not null check (kind in ('always_on','campaign')),
  starts_at  date,                          -- campaign period (null = permanent)
  ends_at    date,
  status     text not null default 'active'
);
```

- **`always_on`** is the permanent base of a brand or product with no end (in marketing "always-on"). It holds the logo, brand rules and permanent assets, for example "Acme".
- **`campaign`** is a period with dates under a base, for example "Q4 launch".
- A child inherits `brand/` (tokens, voice, rules) from its parent and can override them. So a campaign changes only what differs in it.
- Isolation between customers is `root_id`. Who may read is determined by the root, not by the individual campaign.
- We take no terms from BB: we do not use "project", "workspace", "environment" or "thread", and the variables of our provisioning have the prefix `BW_`, not `BB_`.

## Asset

One table for all files, regardless of whether it was produced by the system (Satori, Higgsfield) or uploaded by a human.

```sql
create table asset (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaign(id),
  kind          text not null,   -- image | video | audio | document | font
  role          text not null,   -- source | creative | brand | reference
  origin        text not null,   -- generated | uploaded | imported
  storage_key   text not null,   -- c/<campaign_id>/<sha256>.<ext>
  sha256        text not null,
  mime          text not null,
  bytes         bigint not null,
  width int, height int, duration_ms int,
  status        text not null default 'draft',  -- draft | linted | approved | published | archived
  ai_generated  boolean not null default false, -- labeling under AI Act art. 50
  rights        jsonb,           -- who holds the rights and what we may use the file for (customer photos!)
  provenance    jsonb,           -- generated: model, prompt, job ID, cost, template + version, tokens, fields, lint
                                 -- uploaded: who, when, from where
  created_by    text not null,   -- user or agent run
  created_at    timestamptz not null default now(),
  unique (campaign_id, sha256)
);

create table asset_link (
  parent_id uuid not null references asset(id),
  child_id  uuid not null references asset(id),
  relation  text not null,       -- derived_from | rendered_with | used_in
  primary key (parent_id, child_id, relation)
);
```

`content_calendar.asset_id` replaces the file name. `provenance` is JSON until we need queries (for example cost by model), then it is split into columns.

## Storage

The code uses only the S3 API, switching from local to production is environment variables (`.env.example`):

| | Local | Production |
|---|---|---|
| `S3_ENDPOINT` | `http://localhost:9010` | R2: `https://<account>.r2.cloudflarestorage.com`; AWS S3: leave unset |
| `S3_REGION` | `us-east-1` | R2: `auto`; S3: actual region |
| `S3_BUCKET` | `marketing-ai-assets` | `brandwise-assets-prod` |
| `S3_FORCE_PATH_STYLE` | `true` | `false` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from `infra/docker-compose.yml` | from the provider |

- **Key** is `c/<campaign_id>/<sha256>.<ext>`. A file is never overwritten and duplicates are merged.
- **The bucket is private.** The UI and agents get a signed link valid for a few minutes (`get_asset`). Anonymous access does not work.
- **Upload** (`save_asset`): compute the hash, upload if not there yet, write the row. For uploaded photos strip EXIF (location) and verify type and size.

### Local emulator

The official MinIO images could not be pulled on 2026-10-29 from Docker Hub or quay.io (`pull access denied`). So **RustFS** runs locally (S3 compatible, same `MINIO_ROOT_*` and `RUSTFS_*` variables). Verified on this stack:

- creating a private bucket and uploading an object under a hash-based key,
- a signed link (valid for 60 s) returned 200 and the whole file (499 493 B),
- anonymous access 403, tampered signature 400.

Alternatives that did pull: SeaweedFS and Garage. Changing the local emulator is cheap, the application sees only S3.

## Open

- Stability and license of RustFS (from memory it is a young project, so for local development only, not production). Unverified.
- Production choice: R2, S3 or B2 (price and data location for the EU).
- Overlapping campaigns in one product: which campaign applies in disputed periods.
- Direct upload from the browser (needs CORS on the bucket) vs. through the server.
- Lifecycle: how long to keep unused drafts and raw Higgsfield outputs.
