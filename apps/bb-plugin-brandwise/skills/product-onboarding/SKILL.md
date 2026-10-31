---
name: product-onboarding
description: Interview the user about a product or brand and write its BrandWise product pack (product, audience, claims, constraints, voice). Use when a campaign has no product pack, when the user asks to set up, onboard or describe a product, or to refresh the pack.
---

# Product onboarding

Goal: the user answers once, the pack lets any agent write on-brand content later. Files (per always-on base campaign) are read and written with `bb brandwise product list|get|set`, never edited by hand.

1. Pick the campaign (ask if unclear) and run `product list`. If files exist, show what is there and ask which to redo; never overwrite without saying so.
2. Interview with the ask-user-question tool, one topic per question screen, 2-4 options plus free text where an answer is open. Topics, in order:
   - **product**: what is sold, the one-sentence promise, price range, how it is bought.
   - **audience**: who buys, who decides, their problem in their words, markets and languages.
   - **claims**: numbers, guarantees, awards, subsidies, comparisons the brand may state, each with its source and until when it holds.
   - **constraints**: topics and words never to use, legal or regulated areas, competitors not to name, required disclaimers.
   - **voice**: tone (3 adjectives), formal or informal address, examples of text they like and dislike.
3. Do not invent answers. If the user is unsure, write `TODO: <what is missing>` in that spot.
4. Write each file with `product set <file> --file <path>` (write the text to a temp file first), in this shape:
   - `claims.md`: one claim per line: `- claim | source | valid until (YYYY-MM-DD or "open") | markets`. A later claims check compares text against these lines, so keep the format exactly.
   - other files: short headings and bullet points, no prose over ~10 lines per section.
5. Show the user a summary of what was saved and list the `TODO` items. Do not write `derived/` files yet; positioning and keywords are a separate step the user approves.
