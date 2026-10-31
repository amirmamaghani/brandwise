# Brand system: generátor dizajn manuálu

Cieľ: z MD balíka klienta navrhnúť kompletný dizajn manuál (farby, písma, rozostupy, mriežky, logo, štýl obrázkov), z ktorého kreatívy vychádzajú deterministicky.

**Princíp:** LLM navrhuje *zámer* (osobnosť značky, nálada, hustota), kód z neho *odvodí* tokeny podľa pevných algoritmov a obmedzení. Značku vyberá človek (podľa briefu značka ostáva človeku, úroveň 3). LLM nikdy nepíše hodnoty tokenov z voľnej ruky bez kontroly.

## 1. Tok

```
MD balík (produkt, publikum, tón, konkurencia, existujúce logo a farby)
   │
   ├─ 1. Extrakcia zámeru (LLM)        → brand_intent.json  (osobnosť, nálada, hustota, publikum)
   ├─ 2. Audit konkurencie (voliteľné) → screenshoty reklám a webov, 5 až 10, rozbor farieb a písem
   ├─ 3. Generátor (kód)               → 3 varianty tokenov z intentu + kurátorskej knižnice
   ├─ 4. Kontroly (kód)                → kontrast, diakritika, licencie, úplnosť, minimá veľkostí
   ├─ 5. Náhľad (kód)                  → HTML „style tile“ pre každý variant
   ├─ 6. Voľba človekom (brána)        → vyberie 1 z 3 alebo požiada o úpravu
   └─ 7. Vydanie                       → brand/ priečinok (tokens, DESIGN.md, pravidlá, šablóny)
```

Ak klient už má logo, farby alebo písmo, generátor ich berie ako pevný vstup (kotvu) a navrhuje len zvyšok. Odporúčanie: pri firmách s existujúcou identitou nič nemeniť, len ju zapísať.

## 2. Čo generátor odvodzuje

| Oblasť | Ako sa to vyrába |
|---|---|
| **Farby** | Hlavný odtieň z loga alebo z nálady (v OKLCH). Z neho škála 50–950, neutrály jemne podfarbené hlavným odtieňom, doplnková a akcentová farba podľa harmónie, sémantické farby (úspech, chyba, varovanie). Páry text/pozadie sa vyberú len spomedzi tých, čo prejdú kontrastom. |
| **Písma** | Výber z **kurátorskej zoznamu dvojíc** (napríklad nadpisové + textové, voľné licencie OFL) podľa osí osobnosti (serióznosť, hravosť, prémiovosť). Kontrola pokrytia českej, slovenskej a nemeckej diakritiky. |
| **Typografická škála** | Základná veľkosť a pomer (1,2 / 1,25 / 1,333) podľa hustoty a formátu. Výška riadku a rozstup písmen podľa veľkosti. |
| **Rozostupy** | Základná jednotka 4 alebo 8 px, škála násobkov. Padding, medzery a polomery rohov z osobnosti (ostrá vs. mäkká). Tiene z troch úrovní. |
| **Mriežky a formáty** | Pre 9:16, 4:5, 1:1 a 16:9: okraje, počet stĺpcov, bezpečné zóny (kde prekrýva rozhranie siete), pozície loga a textu. |
| **Logo** | Voľný priestor okolo loga, minimálna veľkosť, povolené farebné varianty na svetlom a tmavom pozadí. Samotné logo nenavrhujeme automaticky (pozri otvorené). |
| **Obrázky** | Štýl fotiek a ilustrácií, spracovanie (farebný nádych, orezy) a **predpona promptu** pre generovanie v Higgsfielde, aby varianty vyzerali jednotne. |
| **Hlas** | `voice.md` už existuje v balíku. |

## 3. Výstup: priečinok `brand/` klienta

```
brand/
  tokens.json        # farby, písma, škály, rozostupy, polomery, tiene (formát W3C DTCG)
  DESIGN.md          # ľudsky čitateľný manuál s odôvodnením každého rozhodnutia
  rules.json         # strojové pravidlá pre lint kreatív (pozri nižšie)
  voice.md           # tón komunikácie
  assets/            # logo (SVG), písma, vzorové fotky
  templates/         # šablóny kreatív (HTML/React) pre obrázky a video
  preview.html       # style tile: paleta, písma, tlačidlá, ukážka príspevku
```

Ukážka `tokens.json` (formát nutné overiť voči aktuálnej verzii špecifikácie DTCG):

```json
{
  "color": {
    "$type": "color",
    "brand": { "500": { "$value": "#1F6FEB" }, "700": { "$value": "#154FA8" } },
    "neutral": { "50": { "$value": "#F6F7F9" }, "900": { "$value": "#14161A" } },
    "text-on-brand": { "$value": "#FFFFFF" }
  },
  "font": {
    "heading": { "$type": "fontFamily", "$value": ["Sora", "sans-serif"] },
    "body": { "$type": "fontFamily", "$value": ["Inter", "sans-serif"] }
  },
  "space": { "$type": "dimension", "unit": { "$value": "8px" } },
  "radius": { "$type": "dimension", "md": { "$value": "12px" } }
}
```

Tokeny sa cez Style Dictionary prekladajú na CSS premenné, tému pre Remotion a ďalšie výstupy.

## 4. Pravidlá a kontroly (kód, nie LLM)

**Pri generovaní manuálu:**
- Kontrast textu min. 4,5:1 (veľký text 3:1) pre každý povolený pár farieb.
- Písmo pokrýva diakritiku CZ/SK/DE a má licenciu povoľujúcu komerčné použitie (OFL alebo ekvivalent).
- Úplnosť tokenov podľa JSON schémy, všetky odkazy sa rozpustia.

**Pri každej kreatíve (`lint_creative`, pred schválením):**
- Len farby a písma z tokenov, žiadne iné.
- Minimálna veľkosť písma podľa formátu, maximum textu na obrázku.
- Text a logo mimo zakázaných zón (rozhranie sietí), voľný priestor okolo loga.
- Kontrast textu voči skutočnému pozadiu pod ním.
- Tvrdenia v texte prejdú `lint_claims`.

## 5. Nástroje agenta (doplnok k `agent-tools.md`)

| Nástroj | Druh | Riziko | Čo robí |
|---|---|---|---|
| `propose_brand_directions` | draft | 1 | z `brand_intent.json` vyrobí 3 varianty a náhľady |
| `get_brand_tokens` | read | 1 | vráti tokeny a pravidlá klienta |
| `render_creative` | draft | 1 | šablóna + dáta + tokeny → obrázok alebo video |
| `lint_creative` | read | 1 | deterministická kontrola kreatívy proti `rules.json` |
| `publish_brand` | write | 3 | zapíše vybraný variant do `brand/` po schválení človekom |

## 6. Obmedzenia, ktoré treba hovoriť otvorene

- Generátor nahradí rutinu (škály, kontrasty, mriežky), ale nie kreatívny koncept ani logo. Výsledok je „slušná, konzistentná“ značka, nie ocenený dizajn. Preto 3 varianty a voľba človekom.
- Kvalita závisí od kurátorskej knižnice dvojíc písem a paliet. Prvá verzia bude mať malú sadu (napr. 10 dvojíc, 8 harmónií), ktorú rozširujeme podľa výsledkov.
- Pri klientoch s existujúcou identitou je správne ju iba zapísať a zdokumentovať.

## 7. Otvorené

- Logo: negenerujeme, alebo ponúkame jednoduchý wordmark z vybraného písma?
- Verzia a presný formát DTCG a podpora v Style Dictionary (overiť v dokumentácii pred stavbou).
- Licencia Remotionu pre komerčné použitie v našom modeli (overiť).
- Kde sa vytvárajú náhľady: deterministický HTML render (Satori alebo Playwright).
- Pre klienta bez digitálnych podkladov: ako zbierať logo a fotky cez chat.
