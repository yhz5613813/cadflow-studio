"""Inspect STEP geometry with the bundled SimpleCADAPI and its OCCT kernel.

The SDK supplies material union, geometric properties and directional material
differences. This adapter normalizes STEP units, checks whether material values
are usable, and exposes a small file-based contract to CAStudio. SDK license and
copyright notices remain in resources/simplecadapi and THIRD_PARTY_NOTICES.md.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "simplecadapi" / "src"))

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.Bnd import Bnd_Box
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TColStd import TColStd_SequenceOfAsciiString
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.TopoDS import TopoDS_Compound
from simplecadapi.inspect.brep import (
    compare_global_properties_rdescriptor,
    compare_material_rdescriptor,
    index_shape_rbrepmodel,
)
from simplecadapi.inspect.brep.io import measure_shape_mass_rtuple


def disk_path(value: str | Path) -> Path:
    """Use Python's extended Windows path support; OCCT receives memory streams."""
    value = os.path.abspath(value)
    if os.name == "nt" and not value.startswith("\\\\?\\"):
        value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
    return Path(value)


def _finite(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("OCCT returned a non-finite property")
    return value


def _vector(value):
    return [_finite(v) for v in value]


def _bbox(shape):
    box = Bnd_Box()
    box.SetGap(0.0)
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        return None
    values = _vector(box.Get())
    return {"min": values[:3], "max": values[3:],
            "size": [values[i + 3] - values[i] for i in range(3)]}


def _shapes(shape, kind):
    indexed = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, indexed)
    return [indexed.FindKey(i) for i in range(1, indexed.Extent() + 1)]


def _closed(solid):
    shells = _shapes(solid, TopAbs_SHELL)
    return bool(shells) and all(BRep_Tool.IsClosed_s(shell) for shell in shells)


def _all_topology_is_solid(model):
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    for body in model.bodies:
        builder.Add(compound, body)
    return all(len(_shapes(model.root, kind)) == len(_shapes(compound, kind))
               for kind in (TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX))


def _body_record(model, index, body):
    valid, closed = bool(BRepCheck_Analyzer(body).IsValid()), _closed(body)
    descriptor = model.describe_entity(f"body:{index}")
    volume, center = measure_shape_mass_rtuple(body, "volume")
    area, _ = measure_shape_mass_rtuple(body, "area")
    usable = valid and closed and math.isfinite(volume) and volume > 0
    return {
        "id": descriptor["entity_id"], "id_scope": "source-file",
        "valid": valid, "closed": closed,
        "volume_mm3": _finite(volume) if usable else None,
        "surface_area_mm2": _finite(area),
        "centroid_mm": _vector(center) if usable else None,
        "bbox_mm": _bbox(body),
    }


def summarize_model(model, *, units_confirmed=True):
    """Return trusted material values only for valid, closed solid-only B-reps."""
    bodies = [_body_record(model, i, body) for i, body in enumerate(model.bodies)]
    area, _ = measure_shape_mass_rtuple(model.root, "area")
    result = {
        "valid_brep": bool(BRepCheck_Analyzer(model.root).IsValid()),
        "solid_count": len(bodies), "material_valid": False,
        "raw_solid_volume_sum_mm3": sum(b["volume_mm3"] for b in bodies)
            if all(b["volume_mm3"] is not None for b in bodies) else None,
        "material_volume_mm3": None, "overlap_volume_mm3": None,
        "surface_area_mm2": _finite(area), "surface_area_basis": "input-brep",
        "centroid_mm": None, "bbox_mm": _bbox(model.root), "bodies": bodies,
        "warnings": [],
    }
    warnings = result["warnings"]
    if not result["valid_brep"]:
        warnings.append("原始 B-rep 未通过 OCCT 有效性检查，不提供可信材料体积或质量。")
    if not bodies:
        warnings.append("没有封闭实体；曲面或开放壳体不提供材料体积和质量。")
    elif any(not b["valid"] or not b["closed"] or b["volume_mm3"] is None for b in bodies):
        warnings.append("存在无效、未闭合或非正体积实体，不提供整体材料体积或质量。")
    if bodies and not _all_topology_is_solid(model):
        warnings.append("模型含实体以外的曲面、边或顶点，整体材料范围未确认。")
    if not units_confirmed:
        warnings.append("未读取到 STEP 长度单位；不确认材料体积或质量。")
    if warnings:
        return result
    try:
        summary = model.summary()
        # The bundled SDK's summary uses this cached union, but its 'valid'
        # refers to the input root. Independently validate the actual union.
        # This is the sole adapter dependency on that pinned SDK internal API.
        material = model._material_union()
        merged_bodies = _shapes(material, TopAbs_SOLID)
        if (not BRepCheck_Analyzer(material).IsValid() or not merged_bodies
                or any(not _closed(body) for body in merged_bodies)):
            raise ValueError("Material union is not a valid closed solid set")
        volume = _finite(summary["volume"])
        raw = result["raw_solid_volume_sum_mm3"]
        tolerance = max(abs(raw), 1.0) * 1e-8
        if volume <= 0 or volume > raw + tolerance or volume < max(b["volume_mm3"] for b in bodies) - tolerance:
            raise ValueError("Material union volume is inconsistent with its solids")
        result.update(material_valid=True, material_volume_mm3=volume,
                      overlap_volume_mm3=max(0.0, raw - volume),
                      surface_area_mm2=_finite(summary["surface_area"]),
                      surface_area_basis="material-union",
                      centroid_mm=_vector(summary["centroid"]),
                      material_solid_count=int(summary["material_body_count"]))
    except Exception as error:
        print(f"CAD material validation failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        warnings.append(f"材料并集计算或校验失败（{type(error).__name__}）；不提供可信材料体积或质量。")
    return result


def load_step(source: str | Path):
    source = Path(source)
    if source.suffix.lower() not in {".step", ".stp"}:
        raise ValueError("Only STEP/STP geometry is supported")
    data = disk_path(source).read_bytes()
    reader = STEPControl_Reader()
    if reader.ReadStream(source.name, io.BytesIO(data)) != IFSelect_RetDone:
        raise ValueError("Could not parse STEP geometry")
    lengths, angles, solids = (TColStd_SequenceOfAsciiString() for _ in range(3))
    reader.FileUnits(lengths, angles, solids)
    input_units = sorted({lengths.Value(i).ToCString() for i in range(1, lengths.Length() + 1)})
    # OCCT's system length is expressed in millimetres. Set after ReadStream
    # creates the STEP model and before translating geometry into the kernel.
    reader.SetSystemLengthUnit(1.0)
    if reader.TransferRoots() < 1 or reader.NbShapes() < 1:
        raise ValueError("STEP transferred no geometry")
    model = index_shape_rbrepmodel(reader.OneShape())
    return ({"name": source.name, "sha256": hashlib.sha256(data).hexdigest(),
             "input_units": input_units}, model)


def compare_models(baseline, current, baseline_summary, current_summary, output):
    result = {"status": "unavailable", "missing_volume_mm3": None,
              "excess_volume_mm3": None, "volume_delta_mm3": None,
              "centroid_distance_mm": None, "boolean_valid": False,
              "volume_balance_valid": False, "exported_files": {},
              "artifact_sha256": {}, "export_validation": {}, "warnings": []}
    if not baseline_summary["material_valid"] or not current_summary["material_valid"]:
        result["warnings"].append("当前模型和基准模型都必须具有已验证材料实体，才能计算材料差异。")
        return result
    temporary = tempfile.mkdtemp(prefix="castudio-cad-diff-")
    try:
        # The SDK owns directional cuts and exports; a short staging directory
        # avoids native STEP writer path limits. Publish only validated outputs.
        global_difference = compare_global_properties_rdescriptor(baseline, current)
        difference = compare_material_rdescriptor(baseline, current, output_directory=temporary)
        if not difference["boolean_result_valid"] or not difference["volume_balance"]["valid"]:
            raise ValueError("Directional material difference failed validity/balance checks")
        result.update(status="succeeded", boolean_valid=True, volume_balance_valid=True,
                      missing_volume_mm3=_finite(difference["missing_material"]["volume"]),
                      excess_volume_mm3=_finite(difference["excess_material"]["volume"]),
                      volume_delta_mm3=-_finite(difference["volume_balance"]["expected_target_minus_current"]),
                      centroid_distance_mm=_finite(global_difference["centroid"]["distance"]),
                      surface_area_delta_mm2=_finite(global_difference["surface_area"]["absolute_delta"]),
                      bbox_size_delta_mm=_vector(global_difference["bounding_box"]["size_delta"]),
                      volume_integration=difference["volume_integration"],
                      volume_balance_error_mm3=_finite(difference["volume_balance"]["absolute_error"]),
                      volume_balance_tolerance_mm3=_finite(difference["volume_balance"]["tolerance"]))
        exports = []
        for key in ("missing_material", "excess_material"):
            generated = difference["exported_files"].get(key)
            if generated:
                name = key + ".step"
                # Validate the exact file the viewer will consume, including
                # units and material union after STEP translation.
                exported_metadata, exported_model = load_step(generated)
                exported_summary = summarize_model(exported_model, units_confirmed=bool(exported_metadata["input_units"]))
                expected_volume = difference[key]["volume"]
                actual_volume = exported_summary["material_volume_mm3"]
                if not exported_summary["material_valid"] or actual_volume is None:
                    raise ValueError("Difference STEP lost valid material on reimport")
                relative_error = abs(actual_volume - expected_volume) / max(abs(expected_volume), 1.0)
                if relative_error > 1e-9:
                    raise ValueError("Difference STEP material volume changed on reimport")
                # Never return a local absolute path from the SDK descriptor.
                data = Path(generated).read_bytes()
                exports.append((name, data))
                result["exported_files"][key] = name
                result["artifact_sha256"][name] = hashlib.sha256(data).hexdigest()
                result["export_validation"][name] = {"material_valid": True,
                    "expected_volume_mm3": expected_volume, "material_volume_mm3": actual_volume,
                    "relative_error": relative_error}
        for name, data in exports:
            disk_path(Path(output) / name).write_bytes(data)
    except Exception as error:
        print(f"CAD comparison failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        result.update(status="failed", missing_volume_mm3=None, excess_volume_mm3=None,
                      volume_delta_mm3=None, centroid_distance_mm=None,
                      boolean_valid=False, volume_balance_valid=False,
                      exported_files={}, artifact_sha256={}, export_validation={})
        result["warnings"].append(f"材料差异计算或校验失败（{type(error).__name__}）；未发布差异实体。")
    finally:
        # The target is the exact directory returned by mkdtemp, never a user path.
        resolved = Path(temporary).resolve()
        if not resolved.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError("Temporary directory escaped its expected parent")
        shutil.rmtree(resolved)
    return result


def inspect(source: str | Path, output: str | Path, baseline: str | Path | None = None):
    output = Path(output)
    disk_path(output).mkdir(parents=True, exist_ok=True)
    if any(disk_path(output / name).exists() for name in
           ("inspection.json", "missing_material.step", "excess_material.step")):
        raise FileExistsError("Inspection output already exists; use a new output directory")
    metadata, model = load_step(source)
    summary = summarize_model(model, units_confirmed=bool(metadata["input_units"]))
    result = {"schema_version": 1, "method": "occt-brep-v1",
              "units": {"length": "mm", "area": "mm2", "volume": "mm3"},
              "source": metadata, "summary": summary}
    if baseline is not None:
        baseline_metadata, baseline_model = load_step(baseline)
        baseline_summary = summarize_model(baseline_model, units_confirmed=bool(baseline_metadata["input_units"]))
        result["baseline"] = {**baseline_metadata, "summary": baseline_summary}
        result["comparison"] = compare_models(baseline_model, model, baseline_summary, summary, output)
    disk_path(output / "inspection.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return result


def main():
    parser = argparse.ArgumentParser(description="Inspect STEP material geometry using OCCT")
    parser.add_argument("source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline")
    args = parser.parse_args()
    inspect(args.source, args.output, args.baseline)
    print("CAD inspection complete: inspection.json", flush=True)


if __name__ == "__main__":
    main()
