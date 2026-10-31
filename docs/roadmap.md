# Plán: čo ostáva spraviť

Stav k 2026-10-30. Rozhodnutie: **všetko beží na bb**, bez Vercel AI SDK a bez DBOS. Agent = bb vlákno (Claude Code), nástroje = `bb brandwise` (CLI a MCP), plánovanie = bb automations, schvaľovanie a upozornenia = stránka Calendar a bb push notifications, prihlasovacie údaje = bb `secrets`. Stav, ktorý musí prežiť (kalendár, limity, metriky), je v Postgrese.

## Poradie

1. Scheduler (`calendar run-due` z bb automation)
2. Konektory (publikovanie)
3. Limity a spotreba (usage)
4. Produkt: sprievodca a MD balík
5. Claims lint
6. Metriky a spätná väzba
7. Moderácia komentárov
8. Výskumné nástroje
9. Roly (persony) a upozornenia

Body 1 až 3 sú nutné, aby sa čokoľvek dostalo von. Zvyšok sa dá robiť v poradí, v akom to prinesie hodnotu prvému klientovi.

## 1. Scheduler: bb automation volá náš príkaz

**Rozhodnutie:** minútový *script automation* spustí `bb brandwise calendar run-due`. Žiadny vlastný démon, žiadne DBOS.

Prečo je to najčistejšie voči bb:
- automations sú súčasť bb (cron, história behov, výstup, pozastavenie, retry viditeľné v UI), nepridávame novú infraštruktúru,
- script, ktorý nič nevypíše, sa zapíše ako tichý tik (žiadny šum),
- logika zostáva v našom plugine (jeden príkaz), automation je len budík. Vymeniteľné za iný budík bez zmeny logiky,
- vytvorí ho `provision.sh apply` deklaratívne (`bb automation create --cron "* * * * *"`), ako ostatné nastavenia inštancie.

Ako `run-due` funguje:
1. V jednej transakcii vyberie záznamy `approved` a `scheduled_at <= now()` príkazom `... FOR UPDATE SKIP LOCKED` a nastaví `publishing` (druhý tik ich nevezme znova).
2. Pre každý zavolá konektor (bod 2) s `idempotency_key`. Úspech: `published`, `external_id`. Chyba: `attempts + 1`, `next_attempt_at` s exponenciálnym oneskorením. Po 3. pokuse `failed` a upozornenie (bod 7).
3. Pred odpálením znovu skontroluje schválenie, limity (bod 2) a claims (bod 4). Zmena od schválenia = späť do `pending_approval`.
4. Záznamy, ktoré zostali v `publishing` dlhšie než časový limit (spadol proces), sa vrátia do `approved`; idempotency key chráni pred dvojitým odoslaním.

Riziká na overenie v prvom teste: automation script dostáva `BB_SERVER_URL`, ale nie `BB_HOST_DAEMON_PORT`; treba overiť, že `bb brandwise ...` v ňom zasiahne správnu inštanciu. Najkratší cyklus je 1 minúta (stačí pre sociálne siete). Vypnutý plugin Automations (napr. v nejakom móde) = nič sa nepublikuje, preto provisioning kontroluje, že beží.

**Stav: hotové (2026-10-30).** `calendar run-due` v `packages/core/src/publish.ts`, stavy `publishing` a `needs_manual`, konektor `mock`, test v `core.test.ts`, automation zakladá `provision.sh apply`. Overené naživo: záznam s časom o minútu sa sám publikoval, záznam s `[fail]` v názve sa opakuje.

Pasce, na ktoré sme narazili (zapísané aj v provisioning skripte):
- bb dáva do skriptov automation `BB_SERVER_URL` na predvolený server (osobný bb, 38886); skript si ho nastaví z `BB_SERVER_PORT`.
- bb dáva do nich `BB_CLI` na launcher v `<data dir>/bin/bb`, ktorý sa re-execuje donekonečna (stovky procesov za sekundu). Skript musí nastaviť `BB_CLI="$BB_CLI_DIR/bb"` a volať ho priamo.
- Skript, ktorý skončí na časový limit, neukáže žiadny výstup: ladenie cez zápis do súboru.

## 2. Konektory (publikovanie, metriky, neskôr komentáre)

**Jeden kontrakt pre všetky siete a zdroje.** Konektor je priečinok `packages/connectors/<name>/` s manifestom a tromi voliteľnými schopnosťami:

```ts
type Connector = {
  id: string;                         // "meta-instagram", "linkedin", "email-resend", "web-cms"
  channels: string[];                 // ktoré `channel` hodnoty kalendára obslúži
  auth: { kind: "oauth" | "apikey"; secrets: string[] };   // mená v bb secrets
  publish?(entry: PublishInput): Promise<{ externalId: string; url?: string }>;
  metrics?(range: { since: string; until: string }): AsyncIterable<MetricPoint>;   // bod 5
  limits?: { postsPerDay?: number; maxTextLength?: number; mediaKinds?: string[] };
};
```

- `PublishInput` je neutrálny (text, assety s podpísanými URL, čas, trh). Prispôsobenie sieti (dĺžka, formát, hashtagy) robí konektor, nie agent.
- Registrácia: jeden zoznam v `packages/connectors/index.ts`. Nová sieť = nový priečinok + riadok v zozname. Nič v kalendári, plugine ani UI sa nemení.
- Poverenia: bb plugin **secrets** (agent hodnoty nikdy nevidí). V kóde len mená.
- Kanál bez konektora sa dá naplánovať, ale nepublikuje sa automaticky: záznam skončí v stave `needs_manual` s textom a assetmi v inboxe (Calendar). Tak funguje aj Postiz alebo ručné nahratie na začiatku.
- **Hotové: `telegram`** (kanál `telegram`: text, obrázok alebo video; jeden `TELEGRAM_BOT_TOKEN` v `.env`, a **kampaň určuje kam**: `bb brandwise campaign channel set telegram chatId=@kanál` pre kanál, skupinu alebo používateľa; cieľ zdedí kampaň od nadradenej, vlastný ho prebije; bez cieľa záznam čaká ako „Publish by hand“ s návodom) a `mock`. Telegram nemá idempotency key, takže pád medzi odoslaním a zápisom môže príspevok zdvojiť (poznámka v kóde). Ďalšie kanály podľa výsledku výskumu a klienta.
- **Hotové (bez živého testu): `email` cez Resend**, pozri `email.md`: konektor, adaptér, webhook, štatistiky (`email stats`), výmena providera.
- Pôvodný nápad na prvý konektor: **Postiz** (jeho API; AGPL, preto len cez API, nie fork) alebo priamo e-mail. Rozhodnutie závisí od prvého kanála klienta.
- Testovací konektor `mock` (zapíše do logu) je súčasť bodu 1.

Hotovo, keď: dva rôzne konektory (mock + jeden reálny) publikujú z toho istého kalendára bez zmeny `run-due`.

## 3. Limity a spotreba (nahrádza „policy gate“)

Súhlasím: samostatný „policy engine“ netreba. Rozdelenie:

| Čo | Kde | Poznámka |
|---|---|---|
| Limity na deň, kanál, kredity, rozpočet, tiché hodiny | **tabuľka `limit` + `usage` záznamy** | rovnaký princíp ako dnešné limity pre Higgsfield (limit na volanie a na deň) |
| Schvaľovacia úroveň 1 až 3 | kalendár (už je) | |
| Kontrola tvrdení | claims lint (bod 4) | je to kontrola obsahu, nie spotreby |

- `limit(scope, key, period, max)`: napr. `("channel","instagram","day",2)`, `("credits","higgsfield","day",40)`, `("quiet_hours","SK","", "22:00-07:00")`.
- `usage(scope, key, amount, at, entry_id?)`: zapisuje sa pri každom odpálení a generovaní. Jedna funkcia `canSpend(scope, key, amount)` ju číta; `run-due` ju volá pred publikovaním.
- Nastavenia limitov sú v stránke Settings pluginu a v `profile.env` (ako teraz). Prekročenie = záznam sa posunie na ďalšie okno alebo ide do inboxu, nikdy sa nezahodí.

Hotovo, keď: 3. príspevok za deň na kanál s limitom 2 sa posunie na ďalší deň a v Calendar je vidno prečo.

## 4. Produkt: sprievodca a MD balík

Súhlasím so sprievodcom cez bb (nástroj na kladenie otázok), potom klasické vlákno.

1. **Balík** je priečinok `~/.bb-brandwise/product/<id základnej kampane>/` s `product.md`, `audience.md`, `claims.md`, `constraints.md`, `voice.md` a podpriečinkom `derived/` (positioning, kľúčové slová, posolstvá). Čítanie a zápis cez `bb brandwise product get|set <súbor>`. Bez nového úložiska.
2. **Sprievodca** je skill `product-onboarding`: vlákno kladie otázky nástrojom na otázky (jedna téma na obrazovku: čo predávame, komu, čím sa líšime, čo môžeme a nemôžeme tvrdiť, tón, trhy a jazyky, zakázané témy), po odpovediach napíše súbory cez `product set`.
3. Potom **kompilácia**: ďalšie vlákno (rola „stratég“, bod 7) prečíta balík a vyrobí `derived/`. Človek schváli.
4. Na stránke Campaigns pribudne tlačidlo „Spustiť sprievodcu“ (otvorí vlákno so skillom) a zoznam súborov balíka s úpravou v texte.
5. Nástroje na čítanie: `product get` (celý balík alebo súbor), `claims get` (štruktúrovane: tvrdenie, zdroj, platnosť, trh).

`claims.md` má pevnú štruktúru (pole `claim`, `source`, `valid_until`, `markets`), aby sa dal použiť v bode 5. Presný formát sa určí s prvým klientom.

Hotovo, keď: nový klient prejde sprievodcom do 15 minút a agent napíše koncept príspevku len z balíka.

## 5. Claims lint

Deterministická kontrola (bez LLM) textu záznamu proti `claims.md`: čísla, ceny, záruky, dotácie, superlatívy. Výsledok `green | list`, zobrazí sa na schvaľovacej karte; pre úroveň 3 povinný. `run-due` ho spustí znova tesne pred odpálením. Začína sa, keď existuje `claims.md` prvého klienta (backlog).

## 6. Metriky a spätná väzba (flexibilné pre všetky siete a zdroje)

Cieľ: pridať novú sieť alebo zdroj dát bez zmeny schémy.

- **Jedna úzka tabuľka** `metric_point(source, entity, metric, value, at, dims jsonb)`:
  - `source` = id konektora (`meta-instagram`, `ga4`, `shop`, `crm`),
  - `entity` = čoho sa to týka (`calendar:<id>`, `campaign:<id>`, `ad:<id>`, `page:<url>`),
  - `metric` z **pevného slovníka** (`impressions`, `reach`, `clicks`, `likes`, `comments`, `shares`, `saves`, `video_views`, `watch_time`, `followers`, `spend`, `conversions`, `revenue`, `orders`),
  - `dims` pre rozmery (trh, kreatíva, variant experimentu), čo sa nehodí do slovníka.
- **Zber:** každý konektor so schopnosťou `metrics()` má jeden bb automation script (denne, po publikovaní aj po 1 h, 24 h a 7 d cez `run-due`, ktorý pri `published` založí kontrolné záznamy). Skript volá `bb brandwise metrics pull <konektor>`; opakovanie je bezpečné (kľúč `source+entity+metric+at`).
- **Surové eventy z webu, CRM a obchodu:** prijímač cez HTTP trasu pluginu s podpisom a zápisom do `metric_point` alebo do `event` (ďalšia úzka tabuľka); rovnaký slovník.
- **Čítanie agentom:** len deterministické agregácie, nikdy surové riadky: `metrics summary --campaign <c> --since 7d --by channel|entry|variant`, `metrics compare <a> <b>`. Agent dostane čísla a signály („príspevok X mal 3× medián“), nie tabuľky.
- **Experimenty:** `experiment(id, hypothesis, variants, holdout_pct, metric)` a stĺpce v kalendári (`experiment_id`, `variant`, `holdout`). Vyhodnotenie je deterministická funkcia nad `metric_point`; závery sa zapíšu ako poznatky (`learning`), ktoré agent číta cez `get_learnings`.

Hotovo, keď: po publikovaní testovacieho príspevku sa po hodine objavia jeho čísla v `metrics summary` a Calendar ukáže výkon pri zázname.

## 7. Moderácia komentárov (čítanie cez automation)

Rozhodnuté: komentáre sa **čítajú periodicky** bb automation, nie cez webhook. Webhook (Meta ho má, TikTok, LinkedIn a YouTube pri organických komentároch pravdepodobne nie) sa dá neskôr pridať ako ping na ten istý príkaz; vyžaduje samostatný verejný prijímač, lebo bb inštanciu verejne vystaviť nesmieme.

- Konektor dostane schopnosť `comments?(since)` a akcie `hide`, `delete`, `reply`.
- Tabuľka `comment(source, external_id, entry_id, author, text, at, status)`, kľúč `source+external_id` robí zber opakovateľným. Stavy: `new`, `ok`, `hidden`, `needs_review`, `replied`.
- Automation script každých pár minút volá `bb brandwise comments pull <konektor>`; bez nových komentárov nič nevypíše (tichý tik), inak spustí moderačného agenta (persona).
- Deterministický predfilter (blokované slová, odkazy, opakovanie) rieši jasný spam bez LLM, agent posudzuje len nejasné.
- Úrovne: skrytie jasného spamu = 1 (automaticky, s logom, vratné); zmazanie, blokovanie a odpoveď = 2 a idú cez kalendár. Agent odpoveď sám neodošle.
- Push na `needs_review` a na hromadné skrytie.
- Pred stavbou overiť v oficiálnej dokumentácii možnosti API pre TikTok a LinkedIn.

Hotovo, keď: testovací komentár sa objaví do 5 minút a spam sa skryje bez zásahu.

## 8. Výskumné nástroje (SEO, GEO, reklamy)

Rovnaký vzor ako konektory: **poskytovateľ** je malý adaptér, nástroj je príkaz.

- Príkazy: `research keywords <dopyt>`, `research serp <dopyt>`, `research gsc --site <s> --since 28d`, `research ads <značka>` (Meta Ad Library), `research geo <dopyt>` (citácie v AI odpovediach), `media transcribe <súbor>` (Whisper).
- Poskytovateľ (DataForSEO, Google Search Console, Meta) = `packages/research/<name>.ts` s jednou funkciou; zoznam v `index.ts`. Poverenia v bb secrets.
- **Cache a cena:** tabuľka `research_cache(provider, key, payload, fetched_at, cost)` s platnosťou podľa nástroja (SERP 24 h, kľúčové slová 30 d). Každé platené volanie ide cez `usage` (bod 3), takže platia limity.
- Výstup je vždy ohraničený (top N, zhrnutie), nie surový export.

Hotovo, keď: `research keywords` vráti výsledok, druhé rovnaké volanie ide z cache a v `usage` je vidno cenu.

## 9. Roly a upozornenia

**Roly = persony** (systémový prompt + zoznam príkazov, ktoré smie používať): `researcher`, `writer`, `seo`, `ads`, `analyst`, `critic`, `strategist`. Každá je súbor `roles/<name>.md` v plugine. Spúšťa sa ako vlákno s tým promptom (z „Start agent“, z iného vlákna alebo z automation). Súhlasím, že to stačí.

Čestné obmedzenie: persona **nevynúti** zákaz nástrojov, je to len inštrukcia. Skutočné ochrany ostávajú v kóde: agent nemôže schváliť (len človek), nič nejde von mimo kalendára, limity a claims lint beží v `run-due`. Rola preto zjednodušuje prácu, nie bezpečnosť.

**Upozornenia (to, čo som volal inbox a digest):** majiteľ nesmie musieť sledovať aplikáciu. V bb to znamená:
- **Inbox = stránka Calendar** (už existuje): záznamy na schválenie, zlyhané publikácie, `needs_manual`.
- **Kontrola cez bb automation** (nie push z pluginu): malá script automation každých pár minút spustí `bb brandwise inbox` (záznamy čakajúce na schválenie, `failed`, `needs_manual`). Ak nič nie je nové, nevypíše nič (tichý tik). Ak je, pošle upozornenie cez bb push notifications (mobil aj desktop). Stav „už upozornené“ si drží príkaz v Postgrese, aby sa neopakovalo. Plugin tak nemusí nič posielať pri zmene stavu a všetko je vidieť v histórii behov automation.
- **Týždenný digest:** jedna bb automation v pondelok ráno (režim agent), ktorá vyrobí vlákno „Týždeň: čo prebehlo, čo čaká, čo sa naučilo“ a pošle push s odkazom. Žiadny WhatsApp ani e-mail na začiatku; pridať sa dá ako ďalší konektor.

## Čo sme zrušili oproti pôvodnému návrhu

- **Vercel AI SDK, DBOS, Inngest, A2A:** preč. Agent je bb vlákno, trvanlivosť je stav v Postgrese plus bb automations.
- **Tabuľky `tool` a `tool_call`:** preč. Každé volanie nástroja je už v logu bb vlákna, druhý záznam by bol duplicita. Ostáva len prepojenie záznamu kalendára na vlákno, ktoré ho vytvorilo (`thread_id`, `rationale`) a tabuľka `usage` (bod 3), ktorú potrebujeme na limity.
- **`propose_tool` a schvaľovanie nových nástrojov:** nový nástroj je zmena v kóde pluginu cez bežný PR.
- **Samostatný policy engine:** nahradený limitmi, claims lintom a schvaľovacou úrovňou.
- **Test výberu nástrojov (50 úloh):** zostáva ako voliteľná kontrola kvality po bode 8, nie ako podmienka.
