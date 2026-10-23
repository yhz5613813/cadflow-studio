"""CAStudio cylinder semantic boundaries; millimetres. Adaptation layer for SimpleCADAPI."""
import math
import simplecadapi as scad
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps


def boundaries(body, radius, height):
    groups = {"interface.fixed_support": [], "interface.axial_load": [], "interface.external_pressure": []}
    for face in scad.ql.faces().resolve(body):
        surf = BRepAdaptor_Surface(face.wrapped)
        if surf.GetType() == GeomAbs_Plane:
            plane = surf.Plane()
            if abs(plane.Axis().Direction().Z()) > 1 - 1e-8:
                z = plane.Location().Z()
                if abs(z) < 1e-6:
                    groups["interface.fixed_support"].append(face)
                if abs(z-height) < 1e-6:
                    groups["interface.axial_load"].append(face)
        elif surf.GetType() == GeomAbs_Cylinder:
            cylinder = surf.Cylinder()
            axis = cylinder.Axis()
            if (abs(cylinder.Radius()-radius) < 1e-6 and
                abs(axis.Direction().Z()) > 1-1e-8 and
                math.hypot(axis.Location().X(), axis.Location().Y()) < 1e-6):
                groups["interface.external_pressure"].append(face)
    if any(not faces for faces in groups.values()):
        raise ValueError("Missing fixed, axial or external-pressure CAD boundary")
    return groups


def area(face):
    p = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face.wrapped, p)
    return p.Mass()


def bind_boundaries(body, radius, height, flange_width, hole_count, hole_radius):
    groups = boundaries(body, radius, height)
    expected = math.pi*(radius**2-(radius-flange_width)**2)-hole_count*math.pi*hole_radius**2
    for name, faces in groups.items():
        target = 2*math.pi*radius*height if name.endswith("external_pressure") else expected
        if abs(sum(area(f) for f in faces)-target) > max(target*1e-7, 1e-4):
            raise ValueError("Boundary area mismatch: "+name)
        body = scad.apply_tag_rselection(scope=body, targets=faces, tag=name)
    return body
