# Nástroje agenta

Agent si vyberá z nástrojov, ale o tom, či sa niečo stane, rozhoduje kód a človek (pozri `architecture.md`). Nástroje sú príkazy `bb brandwise` (CLI a MCP inštancie bb). Rozhodnuté (2026-10-30): agent je bb vlákno, žiadny Vercel AI SDK ani DBOS (pozri `roadmap.md`). Tabuľky `tool` a `tool_call` nižšie sú zrušené: volania nástrojov sú v logu vlákna.

## Pravidlá

1. **Malé balíky podľa roly.** Každá rola vidí 15–25 nástrojov. Viac zhoršuje výber a zvyšuje cenu kontextu.
2. **Nástroje na úrovni zámeru**, typované vstupy a výstupy, výstup ohraničený (žiadne surové tabuľky).
3. **Tri druhy:**
   - `read` – bez vedľajších účinkov,
   - `draft` – zapisuje len do interných tabuliek (koncepty), nič nejde von,
   - `write` – vytvorí alebo zmení záznam v kalendári. Nič nevolá platformu priamo, von ide len cez scheduler.
4. **Brány sú v kóde.** Každý nástroj je obalený našou policy funkciou, ktorá pred vykonaním overí rolu, druh, riziko, limity a rozpočet. Pri zamietnutí vyhráva zamietnutie.
5. **Agent dostane len naše nástroje.** Žiadny shell ani prístup k súborom v produkcii.
6. **Nové nástroje agent len navrhuje** (`propose_tool`): stav `proposed` → sandbox → schválenie človekom (úroveň 3) → `approved`. Nikdy sa nespustí neschválený kód.
7. **Limity na beh:** maximálny počet krokov, tokenov a volaní na nástroj. Každé volanie sa zapíše do `tool_call`.

## Schéma

```sql
create table tool (
  name            text primary key,              -- napr. search_keywords
  version         int  not null default 1,
  roles           text[] not null,               -- ktoré roly ho vidia
  kind            text not null check (kind in ('read','draft','write')),
  risk_tier       int  not null check (risk_tier between 1 and 3),
  idempotent      boolean not null,
  cost_cents_est  numeric,                       -- odhad na jedno volanie
  max_calls_per_run int,
  input_schema    jsonb not null,
  output_schema   jsonb not null,
  impl            text not null,                 -- id adaptéra, napr. tools/video-dl.sh
  status          text not null default 'draft'
                  check (status in ('draft','proposed','approved','disabled')),
  proposed_by     text,
  approved_by     text,
  approved_at     timestamptz
);

create table tool_call (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,                     -- RLS podľa koreňa kampane (campaign.root_id)
  run_id      uuid not null,
  tool        text not null references tool(name),
  version     int  not null,
  input_hash  text not null,
  output_ref  text,                              -- odkaz na uložený výstup
  status      text not null check (status in ('ok','denied','error')),
  denied_by   text,                              -- pravidlo, ktoré zamietlo
  cost_cents  numeric,
  started_at  timestamptz not null default now()
);
```

## Prvá rola: obsah a výskum (SEO, GEO, organické príspevky)

Stav: **existuje** = hotové v repe, **plán** = treba postaviť, **externé** = vyžaduje účet alebo schválenie.

| # | Nástroj | Druh | Riziko | Čo robí | Stav |
|---|---|---|---|---|---|
| 1 | `get_product_context` | read | 1 | derived/ (positioning, posolstvá) pre biznis | plán |
| 2 | `get_claims` | read | 1 | štruktúrované tvrdenia z `claims.md` | plán |
| 3 | `get_brand_voice` | read | 1 | pravidlá tónu a príklady | plán |
| 4 | `search_keywords` | read | 1 | kľúčové slová a objem (DataForSEO) | externé |
| 5 | `get_serp_snapshot` | read | 1 | top výsledky k dopytu | externé |
| 6 | `get_search_console_report` | read | 1 | zobrazenia, kliky, pozície | externé |
| 7 | `get_competitor_ads` | read | 1 | reklamy konkurencie (Meta Ad Library) | externé |
| 8 | `download_video` | read | 1 | stiahne video, vráti cestu a metadáta | **existuje** (`tools/video-dl.sh`) |
| 9 | `transcribe_media` | read | 1 | prepis zvuku (Whisper) | plán |
| 10 | `get_geo_citations` | read | 1 | citácie v AI odpovediach | externé |
| 11 | `get_social_metrics` | read | 1 | výkon publikovaných príspevkov | plán |
| 12 | `get_calendar` | read | 1 | budúce a minulé záznamy kalendára | plán |
| 13 | `get_learnings` | read | 1 | knižnica poznatkov a experimenty | plán |
| 14 | `lint_claims` | read | 1 | deterministická kontrola textu voči `claims.md` | plán |
| 15 | `draft_post` | draft | 1 | uloží koncept príspevku, hneď pustí lint | plán |
| 16 | `draft_page` | draft | 1 | stránka zo šablóny a riadku dát (pSEO) | plán |
| 17 | `generate_media` | draft | 2 nad rozpočtom | obrázok alebo video (Higgsfield), stojí kredity | **existuje** ako `bb brandwise creative cost\|generate\|collect` (limit na volanie aj denný) |
| 18 | `log_hypothesis` | write | 1 | zapíše hypotézu do `experiments` | plán |
| 19 | `schedule_item` | write | 1–3 podľa typu | vytvorí záznam v kalendári | plán |
| 20 | `reschedule_item` | write | 1–2 | zmení čas alebo zruší záznam | plán |
| 21 | `propose_tool` | write | 3 | navrhne nový nástroj (len stav `proposed`) | plán |
| 22 | `get_asset` | read | 1 | metadáta assetu a krátkodobý podpísaný odkaz (pozri `assets.md`) | plán |
| 23 | `save_asset` | draft | 1 | uloží súbor do úložiska podľa hashu a zapíše záznam `asset` | plán |

`schedule_item`: koncept bez publikovania je úroveň 1, publikovanie na účet je úroveň 2, tvrdenia o cene, záruke alebo dotáciách a nový kanál sú úroveň 3.

## Ako overíme výber nástrojov

- 50 pevných úloh s očakávaným nástrojom (napríklad „napíš príspevok o …" → `get_product_context`, `get_claims`, `draft_post`, `lint_claims`).
- Sleduje sa, či agent vybral správny nástroj, či neporušil rolu a koľko volaní spotreboval.
- Až keď to prechádza, pridáme ďalšiu rolu (reklamy, lifecycle, recepcia).

## Otvorené

- Presná štruktúra `claims.md` (polia, príklad), pozri `roadmap.md` bod 4.
