"""
Builds models/furosemide_box.glb: Glenda's Furosemide 40 mg carton from the scenario room
(same 13.5 x 7.5 x 5 cm size and label), with what's inside a real 28-tablet pack:
two blister strips of 14 tablets and a folded patient leaflet.

Parts (each can be shown/hidden in spoutyModel, and the cutaway slices through them):
  Carton, Carton inside, Strip 1 foil, Strip 1 blisters, Strip 1 tablets,
  Strip 2 foil, Strip 2 blisters, Strip 2 tablets, Leaflet

Run:  python make_medbox.py <med_0.png> <out.glb>
"""
import sys

import numpy as np
import trimesh
from PIL import Image, ImageDraw, ImageFont
from trimesh.visual.material import PBRMaterial
from trimesh.visual import TextureVisuals

LABEL, OUT = sys.argv[1], sys.argv[2]
W, H, D = 0.135, 0.075, 0.05          # carton: width (x), height (y), depth (z); label faces +z / -z
CARD = 0.0012                          # card thickness
BLUE = (41, 111, 181)
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font(path, size):
    return ImageFont.truetype(path, size)


# ------------------------------------------------------------------ carton artwork atlas (2048 x 1024)
atlas = Image.new("RGB", (2048, 1024), BLUE)
dr = ImageDraw.Draw(atlas)
front = Image.open(LABEL).convert("RGB").resize((1024, 512), Image.LANCZOS)
atlas.paste(front, (0, 0))                                         # front

# back panel
back = Image.new("RGB", (1024, 512), (246, 246, 242))
b = ImageDraw.Draw(back)
b.rectangle((0, 0, 1024, 70), fill=BLUE)
b.text((40, 100), "Furosemide 40 mg tablets", font=font(FONT_B, 52), fill=(30, 30, 30))
y = 185
for line in ("Each tablet contains 40 mg furosemide.",
             "Read the enclosed leaflet before use.",
             "Do not store above 25 °C. Store in the original package.",
             "Oral use.  POM"):
    b.text((40, y), line, font=font(FONT, 30), fill=(70, 70, 70))
    y += 46
rng = np.random.default_rng(7)
x = 700
while x < 980:                                                    # decorative barcode
    w = int(rng.integers(2, 7))
    b.rectangle((x, 400, x + w, 480), fill=(20, 20, 20))
    x += w + int(rng.integers(2, 6))
atlas.paste(back, (1024, 0))

# top, bottom, ends: blue with the name
for (x0, y0, x1, y1, txt, size) in ((0, 512, 1024, 768, "FUROSEMIDE 40 mg", 70),
                                     (0, 768, 1024, 1024, "28 tablets", 60),
                                     (1024, 512, 1536, 1024, "FUROSEMIDE", 56),
                                     (1536, 512, 2048, 1024, "40 mg", 70)):
    f = font(FONT_B, size)
    tw, th = dr.textbbox((0, 0), txt, font=f)[2:]
    dr.text(((x0 + x1 - tw) / 2, (y0 + y1 - th) / 2), txt, font=f, fill=(255, 255, 255))
atlas.save(OUT.replace(".glb", "_atlas.png"))


def rect_uv(px):
    """Atlas pixel rect (x0, y0, x1, y1) -> uv corners for (bl, br, tr, tl), v up."""
    x0, y0, x1, y1 = px
    u0, u1 = x0 / 2048, x1 / 2048
    v0, v1 = 1 - y1 / 1024, 1 - y0 / 1024
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def carton():
    hx, hy, hz = W / 2, H / 2, D / 2
    # each face: 4 corners (bl, br, tr, tl) seen from outside, plus its atlas rect
    faces = [
        ([(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)], (0, 0, 1024, 512)),        # front +z
        ([(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)], (1024, 0, 2048, 512)),  # back -z
        ([(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)], (0, 512, 1024, 768)),       # top +y
        ([(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)], (0, 768, 1024, 1024)),  # bottom -y
        ([(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)], (1024, 512, 1536, 1024)),  # left -x
        ([(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)], (1536, 512, 2048, 1024)),   # right +x
    ]
    v, uv, f = [], [], []
    for corners, px in faces:
        i = len(v)
        v += corners
        uv += rect_uv(px)
        f += [(i, i + 1, i + 2), (i, i + 2, i + 3)]
    mat = PBRMaterial(name="carton_print", baseColorTexture=atlas, roughnessFactor=0.55, metallicFactor=0.0)
    return trimesh.Trimesh(np.array(v), np.array(f), visual=TextureVisuals(uv=np.array(uv), material=mat), process=False)


def solid(mesh, rgba, rough=0.6, metal=0.0, blend=False):
    mat = PBRMaterial(baseColorFactor=rgba, roughnessFactor=rough, metallicFactor=metal,
                      alphaMode="BLEND" if blend else "OPAQUE", doubleSided=blend)
    mesh.visual = TextureVisuals(material=mat)
    return mesh


def boxm(sx, sy, sz, at=(0, 0, 0)):
    m = trimesh.creation.box((sx, sy, sz))
    m.apply_translation(at)
    return m


scene = trimesh.Scene()
scene.add_geometry(carton(), node_name="Carton", geom_name="Carton")
inside = boxm(W - 2 * CARD, H - 2 * CARD, D - 2 * CARD)
inside.invert()                                                     # faces point inwards: the inside of the card
scene.add_geometry(solid(inside, (196, 180, 150, 255), 0.9), node_name="Carton inside", geom_name="Carton inside")

# ------------------------------------------------------------------ blister strips (2 x 14 = 28 tablets)
SW, SH = 0.124, 0.064                  # strip size (fits inside the carton)
cols, rows = 7, 2
pitch_x, pitch_y = SW / cols, SH / rows
for s, z0 in ((1, 0.010), (2, -0.006)):
    foil = boxm(SW, SH, 0.0006, (0, 0, z0))
    scene.add_geometry(solid(foil, (200, 203, 210, 255), 0.35, 0.9), node_name=f"Strip {s} foil", geom_name=f"Strip {s} foil")
    domes, tabs = [], []
    for c in range(cols):
        for r in range(rows):
            cx = -SW / 2 + pitch_x * (c + 0.5)
            cy = -SH / 2 + pitch_y * (r + 0.5)
            dome = trimesh.creation.icosphere(subdivisions=3, radius=0.0068)
            dome.vertices[:, 2] = np.clip(dome.vertices[:, 2], 0, None) * 0.75      # flattened half bubble
            dome.apply_translation((cx, cy, z0 + 0.0003))
            domes.append(dome)
            tab = trimesh.creation.cylinder(radius=0.0045, height=0.0028, sections=32)
            tab.apply_translation((cx, cy, z0 + 0.0003 + 0.0015))
            tabs.append(tab)
    scene.add_geometry(solid(trimesh.util.concatenate(domes), (225, 235, 245, 90), 0.08, 0.0, blend=True),
                       node_name=f"Strip {s} blisters", geom_name=f"Strip {s} blisters")
    scene.add_geometry(solid(trimesh.util.concatenate(tabs), (245, 245, 240, 255), 0.7),
                       node_name=f"Strip {s} tablets", geom_name=f"Strip {s} tablets")

# ------------------------------------------------------------------ folded leaflet behind the strips
leaf = [boxm(0.122, 0.066, 0.0004, (0, 0, -0.016 - k * 0.0012)) for k in range(4)]
scene.add_geometry(solid(trimesh.util.concatenate(leaf), (250, 250, 250, 255), 0.85), node_name="Leaflet", geom_name="Leaflet")

scene.export(OUT)
print("wrote", OUT)
