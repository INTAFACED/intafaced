"""Make the two symbol subsets in src/lit/fonts/ and print their unicode-range lines for src/lit/fonts.css.

Volt's faces (Archivo, Geist, Geist Mono, as Fontsource ships them) carry no arrows, geometric shapes or check marks
but ↑ ↓, so a typed → ↗ ▲ ▼ fell back to whatever system face the machine had. fonts.css adds these subsets to each
Volt family with a unicode-range, so the family itself draws them.

Sources (both SIL OFL 1.1; licence texts in THIRD-PARTY.md):
  Inter 4.1, https://github.com/rsms/inter/releases/tag/v4.1, Inter-4.1.zip, web/InterVariable.woff2
  JetBrains Mono 2.304, https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304, JetBrainsMono-2.304.zip,
    fonts/variable/JetBrainsMono[wght].ttf (only the small triangles and ✕ that Inter lacks)

Run (needs fonttools and brotli):
  python3 packages/ui/scripts/symbol-fonts.py <InterVariable.woff2> <JetBrainsMono[wght].ttf>
"""

import hashlib
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

SOURCES = {
    "InterVariable.woff2": "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3",
    "JetBrainsMono[wght].ttf": "662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016",
}

# Arrows (without ↑ ↓, which Volt's faces draw themselves), geometric shapes, and check and cross marks.
WANTED = (
    [c for c in range(0x2190, 0x2200) if c not in (0x2191, 0x2193)]
    + list(range(0x25A0, 0x2600))
    + list(range(0x2713, 0x2719))
)

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "lit", "fonts")


def checked(path):
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    want = SOURCES[os.path.basename(path)]
    if digest != want:
        sys.exit(f"{path}: sha256 {digest}, expected {want}")
    return path


def ranges(codes):
    codes = sorted(codes)
    out, start = [], codes[0]
    for prev, cur in zip(codes, codes[1:] + [None]):
        if cur != prev + 1:
            out.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
            start = cur
    return ",".join(out)


def make(src, codes, name):
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    font = TTFont(src)
    sub = subset.Subsetter(options)
    sub.populate(unicodes=codes)
    sub.subset(font)
    path = os.path.join(OUT, name)
    font.flavor = "woff2"
    font.save(path)
    print(f"{name} ({os.path.getsize(path)} bytes): unicode-range: {ranges(codes)};")


def main():
    inter_path, mono_path = (checked(p) for p in sys.argv[1:3])
    inter = TTFont(inter_path).getBestCmap()
    mono = TTFont(mono_path).getBestCmap()
    from_inter = [c for c in WANTED if c in inter]
    from_mono = [c for c in WANTED if c not in inter and c in mono]
    os.makedirs(OUT, exist_ok=True)
    make(inter_path, from_inter, "volt-symbols.woff2")
    make(mono_path, from_mono, "volt-symbols-small.woff2")
    missing = [c for c in WANTED if c not in inter and c not in mono]
    print("drawn by neither:", ranges(missing) if missing else "none")


main()
