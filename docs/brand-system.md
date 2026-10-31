# Brand system: brand guidelines generator

Goal: from the client's Markdown pack, design complete brand guidelines (colors, fonts, spacing, grids, logo, image style) from which creatives follow deterministically.

**Principle:** the LLM proposes the *intent* (brand personality, mood, density), code *derives* the tokens from it using fixed algorithms and constraints. The brand is chosen by a human (per the brief, the brand stays with the human, tier 3). The LLM never writes token values freehand without checks.

## 1. Flow

```
Markdown pack (product, audience, tone, competition, existing logo and colors)
   │
   ├─ 1. Intent extraction (LLM)        → brand_intent.json  (personality, mood, density, audience)
   ├─ 2. Competitor audit (optional)    → screenshots of ads and websites, 5 to 10, breakdown of colors and fonts
   ├─ 3. Generator (code)               → 3 token variants from the intent + curated library
   ├─ 4. Checks (code)                  → contrast, diacritics, licenses, completeness, minimum sizes
   ├─ 5. Preview (code)                 → HTML "style tile" for each variant
   ├─ 6. Human choice (gate)            → picks 1 of 3 or asks for changes
   └─ 7. Release                        → brand/ folder (tokens, DESIGN.md, rules, templates)
```

If the client already has a logo, colors or font, the generator takes them as fixed input (an anchor) and proposes only the rest. Recommendation: for companies with an existing identity, change nothing, only document it.

## 2. What the generator derives

| Area | How it is produced |
|---|---|
| **Colors** | Main hue from the logo or from the mood (in OKLCH). From it a 50–950 scale, neutrals lightly tinted with the main hue, a complementary and an accent color by harmony, semantic colors (success, error, warning). Text/background pairs are chosen only from those that pass the contrast check. |
| **Fonts** | Selection from a **curated list of pairs** (for example heading + body, free OFL licenses) by personality axes (seriousness, playfulness, premium feel). Check coverage of Czech, Slovak and German diacritics. |
| **Type scale** | Base size and ratio (1.2 / 1.25 / 1.333) by density and format. Line height and letter spacing by size. |
| **Spacing** | Base unit of 4 or 8 px, a scale of multiples. Padding, gaps and corner radii from the personality (sharp vs. soft). Shadows from three levels. |
| **Grids and formats** | For 9:16, 4:5, 1:1 and 16:9: margins, number of columns, safe zones (where the network's interface overlaps), logo and text positions. |
| **Logo** | Clear space around the logo, minimum size, allowed color variants on light and dark backgrounds. We do not design the logo itself automatically (see open questions). |
| **Images** | Style of photos and illustrations, treatment (color tint, crops) and a **prompt prefix** for generation in Higgsfield, so the variants look consistent. |
| **Voice** | `voice.md` already exists in the pack. |

## 3. Output: the client's `brand/` folder

```
brand/
  tokens.json        # colors, fonts, scales, spacing, radii, shadows (W3C DTCG format)
  DESIGN.md          # human-readable guidelines with the reasoning for each decision
  rules.json         # machine rules for creative lint (see below)
  voice.md           # tone of communication
  assets/            # logo (SVG), fonts, sample photos
  templates/         # creative templates (HTML/React) for images and video
  preview.html       # style tile: palette, fonts, buttons, sample post
```

Sample `tokens.json` (the format must be verified against the current version of the DTCG specification):

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

Tokens are translated through Style Dictionary into CSS variables, a theme for Remotion and other outputs.

## 4. Rules and checks (code, not LLM)

**When generating the guidelines:**
- Text contrast at least 4.5:1 (large text 3:1) for every allowed color pair.
- The font covers CZ/SK/DE diacritics and has a license allowing commercial use (OFL or equivalent).
- Token completeness against the JSON schema, all references resolve.

**For every creative (`lint_creative`, before approval):**
- Only colors and fonts from the tokens, no others.
- Minimum font size by format, maximum amount of text on the image.
- Text and logo outside forbidden zones (network interface), clear space around the logo.
- Text contrast against the actual background beneath it.
- Claims in the text pass `lint_claims`.

## 5. Agent tools (addition to `agent-tools.md`)

| Tool | Kind | Risk | What it does |
|---|---|---|---|
| `propose_brand_directions` | draft | 1 | produces 3 variants and previews from `brand_intent.json` |
| `get_brand_tokens` | read | 1 | returns the client's tokens and rules |
| `render_creative` | draft | 1 | template + data + tokens → image or video |
| `lint_creative` | read | 1 | deterministic check of the creative against `rules.json` |
| `publish_brand` | write | 3 | writes the chosen variant to `brand/` after human approval |

## 6. Limitations to state openly

- The generator replaces routine work (scales, contrasts, grids), but not the creative concept or the logo. The result is a "decent, consistent" brand, not an award-winning design. Hence 3 variants and a human choice.
- Quality depends on the curated library of font pairs and palettes. The first version will have a small set (e.g. 10 pairs, 8 harmonies), which we expand based on results.
- For clients with an existing identity, the right approach is only to document and record it.

## 7. Open

- Logo: do we not generate it, or do we offer a simple wordmark from the chosen font?
- Version and exact format of DTCG and support in Style Dictionary (verify in the documentation before building).
- Remotion license for commercial use in our model (verify).
- Where previews are produced: deterministic HTML render (Satori or Playwright).
- For a client without digital materials: how to collect the logo and photos via chat.
