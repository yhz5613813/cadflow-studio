# /// script
# requires-python = ">=3.10"
# dependencies = ["simplecadapi"]
# [tool.simplecadapi]
# id = "castudio-stiffened-cylinder"
# revision = "1.0.0"
# ///
import marimo

app = marimo.App(width="medium")

with app.setup:
    import math
    import simplecadapi as scad
    from parametric_common import bind_boundaries


@app.cell
def _():
    # ---- params: 筒体 ----
    DIAMETER = 1000.0  # ui: slider(900, 1100, step=10, label="外径 mm")
    HEIGHT = 500.0  # ui: slider(400, 600, step=10, label="总高 mm")
    SKIN = 2.5  # ui: slider(2, 5, step=0.5, label="蒙皮厚 mm")
    return DIAMETER, HEIGHT, SKIN


@app.cell
def _():
    # ---- params: 翻边与螺栓孔 ----
    FLANGE_WIDTH = 50.0  # ui: slider(40, 70, step=5, label="翻边宽 mm")
    FLANGE_THICKNESS = 12.0  # ui: slider(10, 20, step=1, label="翻边厚 mm")
    HOLE_COUNT = 18  # ui: slider(12, 24, step=1, label="每端孔数")
    HOLE_DIAMETER = 15.0  # ui: slider(10, 20, step=1, label="孔径 mm")
    BOLT_CIRCLE = 970.0  # ui: slider(940, 975, step=5, label="孔分布圆 mm")
    return FLANGE_WIDTH, FLANGE_THICKNESS, HOLE_COUNT, HOLE_DIAMETER, BOLT_CIRCLE


@app.cell
def _():
    # ---- params: 加强筋 ----
    LONGITUDINAL_COUNT = 12  # ui: slider(8, 16, step=1, label="纵筋数")
    RING_COUNT = 5  # ui: slider(3, 7, step=1, label="环筋数")
    RIB_WIDTH = 8.0  # ui: slider(6, 12, step=1, label="筋宽 mm")
    RIB_HEIGHT = 12.0  # ui: slider(8, 16, step=1, label="筋高 mm")
    return LONGITUDINAL_COUNT, RING_COUNT, RIB_WIDTH, RIB_HEIGHT


@app.cell
def _(DIAMETER, HEIGHT, SKIN):
    # ---- feature: 筒皮 (build) ----
    envelope = scad.make_cylinder_rsolid(DIAMETER/2, HEIGHT)
    skin = scad.cut_rsolid(envelope, scad.make_cylinder_rsolid(DIAMETER/2-SKIN, HEIGHT))
    return envelope, skin


@app.cell
def _(DIAMETER, FLANGE_WIDTH, FLANGE_THICKNESS):
    # ---- feature: 翻边毛坯 (build) ----
    flange_blank = scad.cut_rsolid(scad.make_cylinder_rsolid(DIAMETER/2, FLANGE_THICKNESS), scad.make_cylinder_rsolid(DIAMETER/2-FLANGE_WIDTH, FLANGE_THICKNESS))
    return (flange_blank,)


@app.cell
def _(flange_blank, DIAMETER, FLANGE_WIDTH, FLANGE_THICKNESS, HOLE_COUNT, HOLE_DIAMETER, BOLT_CIRCLE):
    # ---- feature: 翻边孔阵列 (subtract) ----
    assert DIAMETER/2-FLANGE_WIDTH < (BOLT_CIRCLE-HOLE_DIAMETER)/2
    assert (BOLT_CIRCLE+HOLE_DIAMETER)/2 < DIAMETER/2
    flange = flange_blank
    for _i in range(HOLE_COUNT):
        _a = math.tau*_i/HOLE_COUNT
        _tool = scad.make_cylinder_rsolid(HOLE_DIAMETER/2, FLANGE_THICKNESS+2, bottom_face_center=(BOLT_CIRCLE/2*math.cos(_a), BOLT_CIRCLE/2*math.sin(_a), -1))
        flange = scad.cut_rsolid(flange, _tool)
    return (flange,)


@app.cell
def _(skin, flange, HEIGHT, FLANGE_THICKNESS):
    # ---- feature: 两端框 (add) ----
    framed = scad.union_rsolid(scad.union_rsolid(skin, flange), scad.translate_shape(flange, (0, 0, HEIGHT-FLANGE_THICKNESS)))
    return (framed,)


@app.cell
def _(framed, DIAMETER, HEIGHT, SKIN, FLANGE_THICKNESS, RIB_WIDTH, RIB_HEIGHT, LONGITUDINAL_COUNT):
    # ---- feature: 纵筋阵列 (add) ----
    _inner = DIAMETER/2-SKIN-RIB_HEIGHT
    _width = SKIN+RIB_HEIGHT
    _rib = scad.make_box_rsolid(_width, RIB_WIDTH, HEIGHT-2*FLANGE_THICKNESS, bottom_face_center=(_inner+_width/2, 0, FLANGE_THICKNESS))
    longitudinal = framed
    for _i in range(LONGITUDINAL_COUNT):
        longitudinal = scad.union_rsolid(longitudinal, scad.rotate_shape(_rib, 360*_i/LONGITUDINAL_COUNT))
    return (longitudinal,)


@app.cell
def _(longitudinal, DIAMETER, HEIGHT, SKIN, FLANGE_THICKNESS, RIB_WIDTH, RIB_HEIGHT, RING_COUNT):
    # ---- feature: 环筋阵列 (add) ----
    rings = longitudinal
    _ring = scad.cut_rsolid(scad.make_cylinder_rsolid(DIAMETER/2-SKIN+0.5, RIB_WIDTH), scad.make_cylinder_rsolid(DIAMETER/2-SKIN-RIB_HEIGHT, RIB_WIDTH))
    for _i in range(1, RING_COUNT+1):
        _z = FLANGE_THICKNESS+(HEIGHT-2*FLANGE_THICKNESS)*_i/(RING_COUNT+1)-RIB_WIDTH/2
        rings = scad.union_rsolid(rings, scad.translate_shape(_ring, (0, 0, _z)))
    return (rings,)


@app.cell
def _(rings, envelope):
    # ---- feature: 外径精确裁切 (intersect) ----
    trimmed = scad.intersect_rsolid(rings, envelope)
    return (trimmed,)


@app.cell
def _(trimmed, DIAMETER, HEIGHT, FLANGE_WIDTH, HOLE_COUNT, HOLE_DIAMETER):
    # ---- feature: 仿真语义边界 (tag) ----
    tagged = bind_boundaries(trimmed, DIAMETER/2, HEIGHT, FLANGE_WIDTH, HOLE_COUNT, HOLE_DIAMETER/2)
    return (tagged,)


@app.cell
def _(tagged):
    cylinder = scad.Part(part_id=scad.notebook_id(), body=tagged)
    return (cylinder,)


if __name__ == "__main__":
    app.run()
