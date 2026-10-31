# Kampane a assety

Rozhodnuté 2026-10-29: obsah delíme podľa **kampane** (`campaign_id`), nie podľa firmy, a súbory žijú v **S3 úložisku**. Metadáta sú v Postgrese.

## Kampaň

Kampaň je jednotka, ku ktorej patrí obsah. Kreatívy sa v jednotlivých obdobiach líšia, preto sa nesmú miešať s trvalými. Slovo „projekt" nepoužívame, lebo v BB je projekt repozitár.

```sql
create table campaign (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references campaign(id),  -- trvalý základ -> kampaň
  root_id    uuid not null,                 -- koreň stromu, na ňom stojí RLS (izolácia zákazníkov)
  name       text not null,
  kind       text not null check (kind in ('always_on','campaign')),
  starts_at  date,                          -- obdobie kampane (null = trvalé)
  ends_at    date,
  status     text not null default 'active'
);
```

- **`always_on`** je trvalý základ značky alebo produktu bez konca (v marketingu „always-on"). Drží logo, pravidlá značky a trvalé assety, napríklad „Acme".
- **`campaign`** je obdobie s dátumami pod základom, napríklad „Q4 launch".
- Dieťa dedí z rodiča `brand/` (tokeny, hlas, pravidlá) a môže ich prepísať. Kampaň teda mení len to, čo sa v nej líši.
- Izolácia medzi zákazníkmi je `root_id`. Kto smie čítať, určuje koreň, nie jednotlivá kampaň.
- Z BB nepreberáme žiadne pojmy: nepoužívame „project", „workspace", „environment" ani „thread" a premenné nášho provisioningu majú predponu `BW_`, nie `BB_`.

## Asset

Jedna tabuľka pre všetky súbory, nezáleží, či ho vyrobil systém (Satori, Higgsfield) alebo ho nahral človek.

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
  ai_generated  boolean not null default false, -- označovanie podľa AI Act čl. 50
  rights        jsonb,           -- kto ma práva a na čo súbor smieme použiť (fotky zákazníkov!)
  provenance    jsonb,           -- generated: model, prompt, ID úlohy, cena, šablóna + verzia, tokeny, polia, lint
                                 -- uploaded: kto, kedy, odkiaľ
  created_by    text not null,   -- user alebo run agenta
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

`content_calendar.asset_id` nahrádza názov súboru. `provenance` je JSON, kým nepotrebujeme dotazy (napríklad cena podľa modelu), potom sa rozbije na stĺpce.

## Úložisko

Kód používa len S3 API, prepnutie z lokálu na produkciu sú premenné prostredia (`.env.example`):

| | Lokálne | Produkcia |
|---|---|---|
| `S3_ENDPOINT` | `http://localhost:9010` | R2: `https://<account>.r2.cloudflarestorage.com`; AWS S3: nenastavovať |
| `S3_REGION` | `us-east-1` | R2: `auto`; S3: skutočný región |
| `S3_BUCKET` | `marketing-ai-assets` | `brandwise-assets-prod` |
| `S3_FORCE_PATH_STYLE` | `true` | `false` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | z `infra/docker-compose.yml` | z poskytovateľa |

- **Kľúč** je `c/<campaign_id>/<sha256>.<ext>`. Súbor sa neprepisuje a duplicity sa zlúčia.
- **Bucket je súkromný.** UI a agenti dostanú podpísaný odkaz s platnosťou niekoľko minút (`get_asset`). Anonymný prístup nefunguje.
- **Nahrávanie** (`save_asset`): spočítať hash, nahrať, ak ešte nie je, zapísať riadok. Pri nahraných fotkách odstrániť EXIF (poloha) a overiť typ a veľkosť.

### Lokálny emulátor

Oficiálne obrazy MinIO sa 2026-10-29 nedali stiahnuť z Docker Hubu ani z quay.io (`pull access denied`). Lokálne preto beží **RustFS** (S3 kompatibilný, rovnaké premenné `MINIO_ROOT_*` aj `RUSTFS_*`). Overené na tomto stacku:

- vytvorenie súkromného bucketu a nahratie objektu pod kľúčom podľa hashu,
- podpísaný odkaz (platnosť 60 s) vrátil 200 a celý súbor (499 493 B),
- anonymný prístup 403, pozmenený podpis 400.

Alternatívy, ktoré sa stiahli: SeaweedFS a Garage. Meniť lokálny emulátor je lacné, aplikácia vidí len S3.

## Otvorené

- Stabilita a licencia RustFS (z pamäte je to mladý projekt, preto len na lokálny vývoj, nie na produkciu). Neoverené.
- Voľba produkcie: R2, S3 alebo B2 (cena a poloha dát pre EÚ).
- Prekrývanie kampaní v jednom produkte: ktorá kampaň platí pri sporných obdobiach.
- Priame nahrávanie z prehliadača (potrebuje CORS na bucket) vs. cez server.
- Lifecycle: ako dlho držať nepoužité drafty a surové výstupy z Higgsfieldu.
