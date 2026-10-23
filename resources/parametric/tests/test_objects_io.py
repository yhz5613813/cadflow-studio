"""Regression for CAD metadata under long Windows workspace paths."""
import json
import sys
import tempfile
import shutil
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from objects import disk_path, dump, digest

class ObjectFileTests(unittest.TestCase):
    def test_long_workspace_receipt_roundtrip(self):
        root=tempfile.mkdtemp(prefix="castudio-objects-")
        try:
            folder=Path(root)
            while len(str(folder))<280:
                folder=folder/"nested-project-folder"
            disk_path(folder).mkdir(parents=True)
            receipt=folder/"cylinder.bindings.json"
            value={"schema_version":2,"components":["蒙皮","环筋 02"]}
            dump(receipt,value)
            self.assertEqual(json.loads(disk_path(receipt).read_text(encoding="utf-8")),value)
            self.assertEqual(len(digest(receipt)),64)
        finally:
            self.assertTrue(Path(root).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()))
            shutil.rmtree(disk_path(root))

if __name__=="__main__":
    unittest.main()
