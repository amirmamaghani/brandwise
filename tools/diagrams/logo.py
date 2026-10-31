# BrandWise mark: a "b" and a "w" woven together, drawn in the same style as the bb mark (thick round strokes, graphite gradient).
# Writes assets/logo.svg (plugin branding, dark mark) and docs/images/logo.svg + logo-dark.svg (README, light and dark themes).
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
W = 58  # stroke width of every letter

def mark(stops, rim_opacity):
    g = "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    b_stem = "M82 40 L47 228"
    # bowl of the b: a tilted ring (filled with an even-odd hole), like the bowls of the bb mark
    bowl = ('M118 160 C60 160 12 206 12 264 C12 322 56 366 112 366 C170 366 222 320 222 262 C222 204 176 160 118 160Z '
            'M116 214 C148 214 168 238 168 264 C168 292 146 312 114 312 C84 312 66 290 66 262 C66 236 86 214 116 214Z')
    w_path = "M222 128 L262 318 L330 190 L398 318 L470 128"
    d = f'''<defs>
<linearGradient id="g" x1="40" y1="20" x2="460" y2="380" gradientUnits="userSpaceOnUse">{g}</linearGradient>
</defs>
<g id="b" fill="url(#g)" stroke="url(#g)" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round">
<path d="{b_stem}" fill="none"/><path d="{bowl}" fill-rule="evenodd" stroke="none"/></g>
<g id="w-edge" fill="none" stroke="#000" stroke-opacity="{rim_opacity}" stroke-width="{W+8}" stroke-linecap="round" stroke-linejoin="round"><path d="{w_path}"/></g>
<g id="w" fill="none" stroke="url(#g)" stroke-width="{W}" stroke-linecap="round" stroke-linejoin="round"><path d="{w_path}"/></g>'''
    return d

DARK  = [(0, "#424242"), (.28, "#303030"), (.57, "#1b1b1b"), (.82, "#0b0b0b"), (1, "#030303")]
LIGHT = [(0, "#ffffff"), (.35, "#e6e6e6"), (.7, "#bdbdbd"), (1, "#8f8f8f")]

def svg(stops, rim, title="BrandWise"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 507 405" role="img" aria-labelledby="t"><title id="t">{title}</title>'
            + mark(stops, rim) + "</svg>\n")

def write(rel, text):
    p = os.path.join(ROOT, rel); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write(text)

write("apps/bb-plugin-brandwise/assets/logo.svg", svg(DARK, .7))
write("docs/images/logo.svg", svg(DARK, .7))
write("docs/images/logo-dark.svg", svg(LIGHT, .35))

# Avatars (square, for X/Twitter, GitHub and others; the mark stays inside the central circle, which is what a round crop keeps).
def avatar(bg, stops, rim, name, glow=None):
    inner = re.search(r"</title>(.*)</svg>", svg(stops, rim), re.S).group(1).replace('id="g"', f'id="g-{name}"').replace("url(#g)", f"url(#g-{name})")
    back = f'<rect width="1024" height="1024" fill="{bg}"/>'
    if glow: back += f'<circle cx="512" cy="512" r="470" fill="url(#glow-{name})"/><defs><radialGradient id="glow-{name}"><stop offset="0" stop-color="{glow}" stop-opacity=".55"/><stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient></defs>'
    # mark box 720 wide centred; the artwork is 507x405 units in the viewBox
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img"><title>BrandWise</title>{back}'
            f'<svg x="152" y="{512-292-6}" width="720" height="583" viewBox="-8 -8 507 405">{inner}</svg></svg>\n')
WHITE = [(0, "#ffffff"), (.5, "#f1f1f1"), (1, "#d9d9d9")]
write("docs/images/avatar.svg", avatar("#FF5A1F", WHITE, .38, "o"))
write("docs/images/avatar-dark.svg", avatar("#0b0d10", WHITE, .5, "k", glow="#FF5A1F"))
print("wrote logos and avatars")
