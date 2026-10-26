# spoutyModel

Show a 3D model inside the Igloo room and handle it: turn it, resize it, move it along a wall, and cut it open.
It's the model-viewer companion to spoutyPreview, and it uses the same room outline and the same head-turn view.

## Start it

1. Double-click **start.bat**. It starts a small server (Python, standard library only) and opens the operator view.
2. In Igloo Core Engine add a **web layer** with this URL:
   `http://localhost:8010/index.html?view=igloo`
   Set the layer to **4096 × 2048**, with **Dynamic Resolution off**, and give it the same layer settings as your Spout layer.
3. To drive it from the room tablet, open `http://<room-PC-IP>:8010/` on the tablet. The server window shows the address.
   If Windows asks, allow Python through the firewall.

Every open page follows the latest change, so the tablet, your PC and the Igloo layer always show the same thing.

## Using it

| | |
|---|---|
| **Look around** | Drag, or use keys 1–4 to face front/right/back/left. Scroll to zoom. **R** resets. |
| **Handle the object** | Tap the model, or press **Tab**. Drag to turn it, scroll/pinch to resize, and right-drag/two fingers to move it. Tap empty space to finish. |
| **Turntable** | Spins the model slowly (**Space**). |
| **Placement** | Choose the wall, or *Move to the wall I'm facing*. Distance is measured from the room centre: the closer it sits to the wall, the less it skews for people standing off-centre. |
| **Cutaway** | Slices the model along a plane that turns with it: Side / Top / Front, plus a depth slider (**C** toggles it). |
| **Parts** | Show or hide each named part of the model. |
| **Backdrop** | Dark or light (**B**). Room edges (**E**) only appear on the operator screen, never in the room. |
| **Room** | Width, depth and height in metres, plus the projection-centre height (blank = half the height) and your eye height. |

**Open file…** or drag a file onto the window to load a model. You can use GLB, OBJ, FBX, STL, or the **.zip from Sketchfab's
"Download glTF"**, which is unpacked for you. Uploaded models are saved in `models/` and appear in the list.

## Standing inside a scene (Environment)

Big models such as rooms, wards or houses load as an **Environment** automatically. You can also switch any model with *Use as*.
The scene is shown at real size around you, and you look around it the same way.

| | |
|---|---|
| **Units** | *Auto* picks metres/cm/mm from the model's size. If the scene looks like a doll's house or a cathedral, pick the right one. |
| **Floor** | The lowest point of the model sits on the real floor. Raise or lower it if the scene has ground or a basement below its floor. |
| **Turn** | Lines the scene's walls up with the real walls. Turn the room edges on (**E**) while doing this. |
| **Stand X / Z**, **Tap to stand here**, **W A S D** | Sets where you stand in the scene (Shift = 1 m steps). **Centre** returns to the middle. |
| **Parts** | Hide ceilings, roofs or clutter that get in the way. |
| **Brightness** | Use this if the scene comes in too dark or too bright. |

The 360 image is only redrawn while something changes, so a heavy scene costs nothing while it sits still.
It looks right from the middle of the room, and a little skewed from the edges, the same as any 360 scene in the Igloo.

## The Furosemide box

`models/furosemide_box.glb` is the Furosemide 40 mg carton from Glenda's room. It's the same size and has the same label, with the pack's contents
modelled inside: two blister strips of 14 tablets and a folded leaflet. `tools/make_medbox.py` rebuilds it.
