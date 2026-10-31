# E-mail: metriky a providery

**Stav: kroky 1 až 3 sú postavené** (doména, úložisko, `email stats`, webhook, adaptér Resend a testovací provider `memory`), kód je v `packages/core/src/email/`. Overené testami (17 prechádza, vrátane integračného s databázou). **Živý beh cez Resend ešte nebol**, chýbajú kľúč, doména, segment a verejná adresa webhooku. Druhý provider zatiaľ nie je. Tvrdenia o schopnostiach konkrétnych providerov sa overujú pri písaní jeho adaptéra, nie tu.

## 1. Katalóg metrík

Základné pravidlo: **každá metrika má jednu definíciu v kóde** (čitateľ, menovateľ, okno). „Open rate“ nie je číslo providera, ale naša funkcia nad udalosťami, takže sa dá porovnať medzi providermi.

**Odoslanie a doručenie**
- odoslané (sent), doručené (delivered), doručiteľnosť = doručené / odoslané
- bounce: tvrdý (hard, trvalý), mäkký (soft, dočasný), s podtypom (schránka plná, neexistuje, blokovaný obsah, reputácia); bounce rate = bounce / odoslané
- odložené (deferred, delayed), zahodené (dropped, rejected, blocked), potlačené (suppressed pred odoslaním), zlyhané (failed)
- umiestnenie v schránke (inbox placement) a podiel do spamu (zo seed testov), spam trap zásahy

**Angažovanosť**
- otvorenia: celkové, unikátne; open rate = unikátne otvorenia / doručené
- **strojové otvorenia** (Apple Mail Privacy Protection, proxy na načítanie obrázkov) oddelene od ľudských, ak provider rozlišuje
- kliky: celkové, unikátne; CTR = unikátne kliky / doručené; **CTOR** = unikátne kliky / unikátne otvorenia; kliky podľa odkazu a pozície (heatmapa)
- odpovede (reply rate), preposlania (forward), tlač, čas čítania (skim, read), čas do otvorenia a do kliknutia
- rozmery: zariadenie, e-mailový klient, OS, krajina a mesto, jazyk, hodina a deň týždňa

**Zdravie zoznamu**
- odhlásenia (unsubscribe rate), sťažnosti na spam (complaint rate, spätná väzba od mailboxov), pridané do potlačených
- noví odberatelia, čistý rast, odliv (churn), opätovné prihlásenia, miera potvrdenia double opt-in, rast podľa zdroja
- podiel aktívnych odberateľov (otvorili alebo klikli za 90 dní), neaktívni a kandidáti na vyčistenie

**Konverzie a výnosy**
- konverzie a miera konverzie, ciele (rezervácia dema, registrácia, nákup), konverzia landing stránky
- výnos, výnos na e-mail a na príjemcu, priemerná hodnota objednávky, ROI, cena za akvizíciu, LTV z e-mailu
- atribúcia: okno (napr. 1, 7, 30 dní), posledný klik alebo viacero dotykov

**Reputácia a technika**
- úspešnosť SPF, DKIM, DMARC a zarovnania, reporty DMARC, BIMI, blacklisty
- reputácia domény a IP, podiel sťažností (limity veľkých mailboxov: pod 0,1 % cieľ, 0,3 % strop), sender score

**Experimenty a automatizácie**
- A/B: rozdiel (lift), štatistická významnosť, víťazný variant; holdout (prírastkový efekt oproti neposlaným); zlepšenie z optimalizácie času
- toky (flows): vstupy a výstupy, dokončenie krokov, odpad medzi krokmi, čas v toku, čas od spúšťača po konverziu
- frekvencia a únava (počet e-mailov na osobu a obdobie, pokles angažovanosti)

Pre rozhodnutia platí: **kliky, konverzie a odhlásenia sú spoľahlivé, otvorenia nie** (pixel, strojové otvorenia, e-mailové klienty ho blokujú). Katalóg preto označuje každú metriku ako `reliable` alebo `indicative`, aby ju agent nemiešal.

## 2. Vrstvy a smer závislostí

```
Kalendár ──► Connector "email" ──► E-mail doména ◄── Adaptéry (Resend, Brevo, memory, ...)
 (publish)    (tenký, vyberá          (typy, porty,       (prekladajú API providera
              providera podľa          metriky, ingest)     na naše typy; nič iné)
              cieľa kampane)                ▲
                                            │
                                  Úložisko udalostí (Postgres)
```

Pravidlá (vynucuje ich test, ktorý prechádza importy):
1. **Doména** (`email/domain/`): typy, porty, katalóg metrík, vzorce. Nič nezávisí od providera, databázy ani S3. Je to čistý TypeScript.
2. **Adaptéry** (`email/adapters/<id>.ts`) importujú len doménu. Nepoznajú databázu, kalendár ani plugin. Sú to čisté funkcie: vstup providera na naše typy a naše typy na volanie providera.
3. **Úložisko** (`email/store.ts`) implementuje port `EventStore` nad Postgresom. Doména ho pozná len ako rozhranie.
4. **Connector `email`** je tenká vrstva medzi kalendárom a doménou. Providera vyberá z cieľa kampane (`provider=resend`), takže **výmena providera je zmena jedného nastavenia**, nie kódu.
5. **Zloženie** (jediné miesto, ktoré pozná všetko): v plugine sa z nastavení postavia adaptéry a zaregistrujú sa. Poverenia sa predávajú konštruktorom, nikdy nie globálne.

## 3. Porty (rozhrania podľa zodpovednosti)

Pôvodný jeden veľký `EmailAdapter` bol príliš široký: miešal odosielanie, príjem udalostí a nastavenie. Provider môže vedieť len časť (napr. len SMTP nemá udalosti, provider len so súhrnmi nemá webhooky). Preto tri malé porty, ktoré adaptér implementuje podľa potreby:

```ts
// odosielanie (volá ho connector z kalendára)
interface EmailSender {
  readonly id: string;
  createCampaign(draft: CampaignDraft): Promise<{ externalId: string }>;   // vždy koncept
  schedule(externalId: string, at: Date): Promise<void>;
  sendTest?(externalId: string, to: string[]): Promise<void>;
  cancel?(externalId: string): Promise<void>;
}

// príjem udalostí (volá ho webhook trasa alebo plánovač dopytovania)
interface EmailEventSource {
  readonly id: string;
  parseWebhook?(req: { headers: Headers; body: string }): EmailEvent[];    // overí podpis, nič nezapisuje
  pull?(since: Date): AsyncIterable<EmailEvent>;                           // ak provider nemá webhooky
  pullTotals?(send: SendRef): Promise<Counts>;                             // ak dáva len súhrny
}

// stav sledovania (voliteľné; "je zapnuté sledovanie otvorení a klikov?")
interface TrackingCheck { status(): Promise<TrackingStatus>; }

type EmailProvider = { id: string; capabilities: Capabilities; sender?: EmailSender; events?: EmailEventSource; tracking?: TrackingCheck };
```

Adaptér nikdy nezapisuje do databázy: vráti udalosti a **príjem** ich uloží (jedna `ingest(events)` funkcia v doméne, ktorú používa webhook aj dopytovanie). Dedup, ukladanie a prepočty sú na jednom mieste.

## 4. Schopnosti určujú dostupnosť metrík (nič sa nepíše ručne podľa providera)

```ts
type Capabilities = {
  emits: ReadonlySet<EventType>;       // ktoré udalosti provider vie poslať: sent, delivered, opened, clicked, bounced, ...
  details: ReadonlySet<DetailKey>;     // ktoré detaily: link, bounceClass, bounceReason, machine, device, country, ...
  features: ReadonlySet<Feature>;      // drafts, scheduling, sendTest, segments, abTest, subAccounts, ...
};
```

Každá metrika v katalógu deklaruje, čo potrebuje: `requires: { events: ["delivered","clicked"], details: [] }`. Dostupnosť je odvodená: metrika je dostupná, ak `requires ⊆ capabilities` providera, ktorým bola kampaň odoslaná. Nová schopnosť providera = jedno pole v jeho deklarácii a metriky sa samy odomknú. Metrika, ktorú provider nevie, sa ukáže ako „nedostupné“ (nikdy ako 0).

## 5. Normalizovaná udalosť a naše identifikátory

```ts
type EmailEvent = {
  provider: string;
  providerEventId: string;            // dedup spolu s `provider`: webhooky chodia "aspoň raz"
  type: EventType;                    // sent | delivered | deferred | bounced | dropped | suppressed | failed | opened | clicked | unsubscribed | complained | replied
  at: string;                         // UTC
  sendId: string;                     // NÁŠ identifikátor odoslania (nie providera), viď nižšie
  recipient: { hash: string; domain: string };
  detail: { bounceClass?; bounceReason?; link?; linkPosition?; machine?: boolean | null; device?; client?; country? };
  raw: unknown;                       // celý pôvodný payload bezstratovo
  schemaVersion: 1;
};
```

**Prečo výmena providera nerozbije štatistiky:** všetko sa viaže na **naše** `send`, nie na identifikátory providera.
- Pri odoslaní vznikne záznam `email_send(id, entry_id, provider, external_id, capabilities_snapshot, created_at)`. Provider dostane naše `send_id` ako tag alebo metadáta (každý adaptér to prekladá vlastným spôsobom: tag, custom header, utm; kontraktový test overí, že sa vráti v udalosti).
- Udalosti nesú `sendId`. Metriky sa počítajú podľa `entry_id` alebo kampane cez `email_send`, **nikdy podľa providera**.
- Zmena providera v polovici roka: staré odoslania ostanú s Resend a jeho udalosťami, nové idú cez nový. Prehľad kampane alebo obdobia ich sčíta, lebo obe sú v tom istom tvare.

## 6. Metriky: jeden tvar vstupu, tri zdroje

Vzorce sú čisté funkcie nad **`Counts`**, nie nad udalosťami ani nad providerom:

```ts
type Counts = { sent; delivered; bounced: { hard; soft }; opened: { total; unique; humanUnique? }; clicked: { total; unique; perLink? }; unsubscribed; complained; ... };
```

- **Z udalostí** (hlavný zdroj): `eventsToCounts(events)`. Unikátnosť počítame **my** (príjemca + `sendId`), nie podľa príznaku providera, aby bola rovnaká všade.
- **Zo súhrnov providera** (len ak provider nemá udalosti): `pullTotals` vráti `Counts` priamo. Metriky závislé od detailov (per odkaz, strojové otvorenia) sa potom označia ako nedostupné.
- **Prepočet** `Counts` na metriky (`open_rate`, `ctr`, `ctor`, `bounce_rate`, ...) je jediné miesto s vzorcami a menovateľmi, spoločné pre všetkých providerov.
- Katalóg označuje metriky `reliable` alebo `indicative` (otvorenia sú orientačné). Strojové otvorenia sa odpočítajú, ak ich provider rozlišuje (`machine` nie je `null`), inak je metrika `indicative`.

Agent číta len výsledky: `email stats <záznam | kampaň | obdobie>`.

## 7. Webhooky a príjem

- Jedna trasa pluginu `/webhooks/email/<provider>`. Vyhľadá adaptér v registri a zavolá `events.parseWebhook`. Zlý podpis → 401 bez zápisu. Duplicita → 200 (už uložené). Neznáma udalosť providera → uloží sa len `raw` s typom `unknown`, nič nespadne.
- Poverenia a podpisové kľúče sú v nastaveniach pluginu a do adaptéra idú ako parametre konštruktora.
- Dopytovanie (`pull`) je plánovaná bb automation, rovnako ako scheduler, a volá tú istú funkciu `ingest`.

## 8. Rozloženie súborov

```
packages/core/src/email/
  domain/        types.ts  ports.ts  capabilities.ts  metrics.ts  counts.ts  ingest.ts   (čistá doména, bez pg a S3)
  adapters/      memory.ts (testovací provider, vyrába udalosti)  resend.ts  index.ts (zoznam)
  store.ts       EventStore nad Postgresom (email_send, email_event)
  connector.ts   Connector "email" pre calendar publish (vyberá providera z cieľa kampane)
  email.arch.test.ts   vynucuje pravidlá závislostí (domain nič neimportuje; adaptér len domain)
```

Poznámka k buildu: provisioning teraz kopíruje `packages/core/src/*.ts` plochým kopírovaním (bb odmieta importy mimo priečinka pluginu). Podpriečinky treba kopírovať rekurzívne, to je malá úprava `provision.sh`.

## 9. Ako sa pridáva provider

1. `adapters/<id>.ts`: funkcia `<id>Provider(config): EmailProvider` s deklarovanými schopnosťami a tými portami, ktoré provider vie. Nič iné sa nemení.
2. Zápis do `adapters/index.ts`.
3. **Kontraktové testy** (jedna sada pre všetky adaptére, spúšťa sa aj nad `memory`): zaznamenané payloady → očakávané `EmailEvent`; `sendId` sa vráti v udalosti; zlý podpis sa odmietne; koncept sa nikdy neodošle bez `schedule`; schopnosti zodpovedajú tomu, čo adaptér reálne emituje.
4. Z deklarovaných schopností sa generuje tabuľka „čo ktorý provider vie“.
5. Cieľ kampane: `bb brandwise campaign channel set email provider=<id> list=<...> from=<...>`.

## 10. Poradie stavby

1. Doména (typy, porty, `Counts`, katalóg metrík, `ingest`) a provider `memory` s kontraktovými testami a testom závislostí. Bez Resend, bez siete.
2. `store.ts` (migrácia `email_send`, `email_event`), `email stats`, trasa webhooku.
3. Adaptér Resend (sender, event source, tracking check) a kontraktové testy na jeho fixtúrach.
4. **Druhý provider** (Brevo alebo MailerLite) ako skúška abstrakcie: ak vyžaduje zmenu domény, abstrakcia bola zlá a opraví sa tu, nie obchádzkou.
5. Konverzie (`bw_eid`, UTM, udalosti z webu) a A/B testy.

## 11. Čo je potrebné vedieť pred stavbou

- Presné schopnosti Resend (polia udalosti pri otvorení, zoznam e-mailov, polia Broadcast API) a ceny sa overia pri adaptéri.
- Právo: ukladáme hash príjemcu (so soľou inštalácie) a doménu, nie adresy. Zoznamy, súhlas a potlačenie ostávajú u providera.
- Test závislostí treba písať ako súčasť kroku 1, inak sa pravidlá časom porušia.

## 12. Čo sa pri stavbe zmenilo oproti návrhu vyššie

- **Udalosť nesie `ref`, nie `sendId`:** `{ sendId?, externalId? }`. Resend nepodporuje tagy na kampaniach (Broadcasts), takže udalosť sa k nášmu odoslaniu priradí cez `broadcast_id` (`email_send.external_id`). Udalosť, ktorá príde skôr, než poznáme odoslanie, sa uloží a pripojí pri `recordSend`.
- **`send(externalId, { at? })` namiesto `schedule`:** scheduler spúšťa záznam až v jeho čase, takže sa posiela hneď. `sendTest` a `TrackingCheck` sa nestavali (v Resende nie je overený endpoint na stav sledovania domény).
- **Jedno odoslanie na záznam** (`email_send.entry_id` je unikátny): opakovanie po zlyhaní použije ten istý koncept a vopred sa opýta providera, či už neodišiel (`status`), takže sa nikdy nevytvorí druhá kampaň ani druhé odoslanie.
- **Súkromie:** `raw` neobsahuje adresy ani IP (adaptér ich nahradí pred uložením). Príjemca je soľený hash a doména; soľ je tajomstvo pluginu.
- **Webhook** je HTTP trasa pluginu bez prihlásenia bb (`auth: "none"`, bb to povoľuje len pre podpísané webhooky); bez platného podpisu sa nič neuloží.
- **Telo e-mailu:** `title` záznamu je predmet, `body` je text (alebo HTML, ak začína `<`), `link` dostane UTM značky. Odkaz na odhlásenie sa pridá vždy, ak ho telo nemá.
- **Neriešené:** odhlásenia (Resend ich hlási ako kontaktné udalosti, nie e-mailové, takže `unsubscribe_rate` je pri Resend „nedostupné“), segmentácia, A/B, konverzie (`bw_eid`), kontrola tvrdení pred schválením.
