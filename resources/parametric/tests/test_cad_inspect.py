"""Analytical STEP and real-cylinder acceptance for the CAD inspection adapter."""
import hashlib
import io
import json
import math
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cad_inspect as cad
from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_SHELL
from OCP.TopoDS import TopoDS_Compound
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt


def box(x=2, y=3, z=4, shift=0):
    return BRepPrimAPI_MakeBox(gp_Pnt(shift, 0, 0), x, y, z).Shape()


def compound(*shapes):
    result = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def write_step(shape, path, unit="MM"):
    STEPControl_Writer()  # initialize OCCT's STEP parameters before changing units
    previous = Interface_Static.CVal_s("write.step.unit")
    try:
        assert Interface_Static.SetCVal_s("write.step.unit", unit)
        writer = STEPControl_Writer()
        assert writer.Transfer(shape, STEPControl_AsIs) == IFSelect_RetDone
        stream = io.BytesIO()
        assert writer.WriteStream(stream) == IFSelect_RetDone
        cad.disk_path(path).write_bytes(stream.getvalue())
    finally:
        Interface_Static.SetCVal_s("write.step.unit", previous)
    return path


class CadInspectionTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="castudio-cad-test-"))

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()))
        shutil.rmtree(cad.disk_path(self.root))

    def check_vector(self, actual, expected):
        for got, want in zip(actual, expected):
            self.assertAlmostEqual(got, want, places=6)

    def test_box_properties_source_and_identical_comparison(self):
        source = write_step(box(), self.root / "box.step")
        record = cad.inspect(source, self.root / "out", source)
        s = record["summary"]
        self.assertTrue(s["material_valid"])
        self.assertEqual(s["solid_count"], 1)
        self.assertAlmostEqual(s["material_volume_mm3"], 24)
        self.assertAlmostEqual(s["surface_area_mm2"], 52)
        self.check_vector(s["centroid_mm"], [1, 1.5, 2])
        self.check_vector(s["bbox_mm"]["size"], [2, 3, 4])
        self.assertEqual(s["bodies"][0]["id_scope"], "source-file")
        self.assertEqual(record["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(record["comparison"]["status"], "succeeded")
        self.assertAlmostEqual(record["comparison"]["missing_volume_mm3"], 0)
        self.assertAlmostEqual(record["comparison"]["excess_volume_mm3"], 0)
        self.assertEqual(record["comparison"]["exported_files"], {})
        self.assertNotIn(str(self.root), json.dumps(record))
        self.assertEqual(json.loads((self.root / "out/inspection.json").read_text(encoding="utf-8")), record)
        with self.assertRaises(FileExistsError):
            cad.inspect(source, self.root / "out")

    def test_inches_translate_to_millimetres(self):
        source = write_step(box(25.4, 50.8, 76.2), self.root / "inch.step", "INCH")
        record = cad.inspect(source, self.root / "out")
        self.assertIn("INCH", [v.upper() for v in record["source"]["input_units"]])
        self.assertTrue(record["summary"]["material_valid"])
        self.check_vector(record["summary"]["bbox_mm"]["size"], [25.4, 50.8, 76.2])
        self.assertAlmostEqual(record["summary"]["material_volume_mm3"], 25.4 * 50.8 * 76.2, places=5)

    def test_overlap_union_not_sum(self):
        source = write_step(compound(box(), box(shift=1)), self.root / "overlap.step")
        s = cad.inspect(source, self.root / "out")["summary"]
        self.assertTrue(s["material_valid"])
        self.assertEqual(s["solid_count"], 2)
        self.assertAlmostEqual(s["raw_solid_volume_sum_mm3"], 48)
        self.assertAlmostEqual(s["material_volume_mm3"], 36)
        self.assertAlmostEqual(s["overlap_volume_mm3"], 12)
        self.check_vector(s["centroid_mm"], [1.5, 1.5, 2])

    def test_translation_and_added_removed_material(self):
        baseline = write_step(box(), self.root / "baseline.step")
        shifted = write_step(box(shift=1), self.root / "shifted.step")
        changed = cad.inspect(shifted, self.root / "shifted-out", baseline)["comparison"]
        self.assertEqual(changed["status"], "succeeded")
        self.assertAlmostEqual(changed["missing_volume_mm3"], 12)
        self.assertAlmostEqual(changed["excess_volume_mm3"], 12)
        self.assertAlmostEqual(changed["volume_delta_mm3"], 0)
        self.assertAlmostEqual(changed["centroid_distance_mm"], 1)
        for key, name in changed["exported_files"].items():
            artifact = self.root / "shifted-out" / name
            _, model = cad.load_step(artifact)
            self.assertAlmostEqual(cad.summarize_model(model)["material_volume_mm3"], 12)
            self.assertEqual(changed["artifact_sha256"][name], hashlib.sha256(artifact.read_bytes()).hexdigest())
        larger = write_step(box(3, 3, 4), self.root / "larger.step")
        added = cad.inspect(larger, self.root / "added", baseline)["comparison"]
        removed = cad.inspect(baseline, self.root / "removed", larger)["comparison"]
        self.assertEqual(added["status"], "succeeded")
        self.assertEqual(removed["status"], "succeeded")
        self.assertAlmostEqual(added["missing_volume_mm3"], 0)
        self.assertAlmostEqual(added["excess_volume_mm3"], 12)
        self.assertAlmostEqual(removed["missing_volume_mm3"], 12)
        self.assertAlmostEqual(removed["excess_volume_mm3"], 0)
        self.assertEqual(set(added["exported_files"]), {"excess_material"})
        self.assertEqual(set(removed["exported_files"]), {"missing_material"})

    def test_shell_and_union_failure_never_claim_material(self):
        shell = cad._shapes(box(), TopAbs_SHELL)[0]
        source = write_step(shell, self.root / "shell.step")
        record = cad.inspect(source, self.root / "out")
        self.assertFalse(record["summary"]["material_valid"])
        self.assertIsNone(record["summary"]["material_volume_mm3"])
        self.assertIsNone(record["summary"]["centroid_mm"])
        solid = write_step(box(), self.root / "box.step")
        compared = cad.inspect(solid, self.root / "comparison", source)["comparison"]
        self.assertEqual(compared["status"], "unavailable")
        _, model = cad.load_step(solid)
        with patch.object(model, "_material_union", side_effect=RuntimeError("forced failure")):
            summary = cad.summarize_model(model)
        self.assertFalse(summary["material_valid"])
        self.assertIsNone(summary["material_volume_mm3"])
        self.assertTrue(summary["warnings"])

    def test_curved_thin_rings_against_analytical_volume(self):
        outer_radius, inner_radius, height, count = 500.0, 499.9, 2.0, 6
        def cylinders(radius):
            return compound(*(BRepPrimAPI_MakeCylinder(
                gp_Ax2(gp_Pnt(0, 0, i * 10), gp_Dir(0, 0, 1)), radius, height
            ).Shape() for i in range(count)))
        baseline = write_step(cylinders(inner_radius), self.root / "inner.step")
        source = write_step(cylinders(outer_radius), self.root / "outer.step")
        result = cad.inspect(source, self.root / "rings", baseline)["comparison"]
        # Factor the radius difference rather than subtracting two large squared
        # radii: this is the analytic annular volume, independent of GProp.
        expected = count * math.pi * (outer_radius - inner_radius) * (outer_radius + inner_radius) * height
        self.assertEqual(result["status"], "succeeded")
        self.assertAlmostEqual(result["missing_volume_mm3"], 0)
        self.assertAlmostEqual(result["excess_volume_mm3"], expected, delta=expected * 1e-9)
        self.assertAlmostEqual(result["volume_delta_mm3"], expected, delta=expected * 1e-9)
        self.assertEqual(result["volume_integration"]["method"], "adaptive_gauss")
        self.assertLessEqual(result["volume_integration"]["maximum_estimated_relative_error"], 1e-10)
        check = result["export_validation"]["excess_material.step"]
        self.assertAlmostEqual(check["material_volume_mm3"], expected, delta=expected * 1e-9)
        self.assertTrue(check["material_valid"])

    def test_long_unicode_paths_with_comparison_exports(self):
        folder = self.root
        while len(str(folder)) < 290:
            folder /= "long-project-directory"
        cad.disk_path(folder).mkdir(parents=True)
        baseline = write_step(box(), folder / "基准.step")
        source = write_step(box(shift=1), folder / "改参蒙皮.step")
        record = cad.inspect(source, folder / "检查结果", baseline)
        self.assertEqual(record["source"]["name"], "改参蒙皮.step")
        self.assertEqual(record["comparison"]["status"], "succeeded")
        self.assertTrue(cad.disk_path(folder / "检查结果/missing_material.step").is_file())

    @unittest.skipUnless(os.environ.get("CASTUDIO_CAD_TEST_CURRENT") and os.environ.get("CASTUDIO_CAD_TEST_BASELINE"), "real cylinder paths not configured")
    def test_actual_modified_cylinder_against_default(self):
        result = cad.inspect(os.environ["CASTUDIO_CAD_TEST_CURRENT"], self.root / "cylinder", os.environ["CASTUDIO_CAD_TEST_BASELINE"])
        self.assertTrue(result["summary"]["material_valid"])
        self.assertTrue(result["baseline"]["summary"]["material_valid"])
        self.assertEqual(result["summary"]["solid_count"], 1)
        self.assertEqual(result["comparison"]["status"], "succeeded")
        self.assertGreater(result["comparison"]["excess_volume_mm3"], 0)
        self.assertGreater(result["summary"]["material_volume_mm3"], result["baseline"]["summary"]["material_volume_mm3"])
        for validation in result["comparison"]["export_validation"].values():
            self.assertTrue(validation["material_valid"])
            self.assertLessEqual(validation["relative_error"], 1e-9)
        self.check_vector(result["summary"]["bbox_mm"]["size"], [1000, 1000, 500])
        print("CYLINDER_ACCEPTANCE=" + json.dumps({"source": result["source"], "baseline": result["baseline"]["sha256"], "volume_mm3": result["summary"]["material_volume_mm3"], "comparison": result["comparison"]}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
