"""CadFlow Studio parametric plate. Reads the adjacent parameter document.

Requires a supported CadFlow 0.2.0 environment. No mesh-only fallback.
"""
import hashlib
import json
import math
from pathlib import Path


def main():
    parameter_file = Path(__file__).with_suffix('.parameters.json')
    raw = parameter_file.read_bytes()
    document = json.loads(raw)
    values = {p['name']: p['value'] for p in document['parameters']}
    if document['version'] != 1 or set(values) != {'width', 'height', 'thickness', 'hole_diameter'}:
        raise ValueError('Unsupported plate parameter schema')
    for p in document['parameters']:
        value = p['value']
        if p['unit'] != 'mm' or type(value) not in (float, int) or not math.isfinite(value) or not p['min'] <= value <= p['max']:
            raise ValueError(f"Invalid millimetre parameter: {p['name']}")
    w, h, t, d = (values[k] for k in ('width', 'height', 'thickness', 'hole_diameter'))
    if min(w, h, t, d) <= 0 or min(w, h) - d < 2:
        raise ValueError('The bore must leave at least 1 mm of material on each side')
    print('Parameters (mm):', values, flush=True)
    import cadflow as cad
    output = Path('artifacts') / 'plate'
    output.mkdir(parents=True, exist_ok=True)
    with cad.Model() as model:
        blank = model.box(w, h, t)
        bore = model.translate(model.cylinder(radius=d / 2, height=t + 4), w / 2, h / 2, -2)
        part = model.cut(blank, bore)
        validation = part.validate()
        expected_volume = (w * h - math.pi * (d / 2) ** 2) * t
        if not validation.ok or part.topology.get('solids') != 1:
            raise RuntimeError(f'Invalid solid: {validation.to_dict()}')
        if abs(part.volume - expected_volume) > max(1e-3, expected_volume * 1e-7):
            raise RuntimeError('Model volume differs from the analytical plate volume')
        part.export_step(str(output / 'plate.step'))
        part.export_stl(str(output / 'plate.stl'), binary=True)
        reopened = model.import_step(str(output / 'plate.step'))
        if abs(reopened.volume - part.volume) > max(1e-3, part.volume * 1e-7):
            raise RuntimeError('STEP reimport volume mismatch')
        report = {
            'kind': 'cadflow-plate-validation', 'units': {'length': 'mm', 'volume': 'mm3'},
            'parameters': values, 'parameter_sha256': hashlib.sha256(raw).hexdigest(),
            'cad_geometry_validated': True, 'volume': part.volume,
            'expected_volume': expected_volume, 'bbox': list(part.bbox),
            'topology': dict(part.topology), 'reimported_volume': reopened.volume,
        }
        (output / 'validation.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
