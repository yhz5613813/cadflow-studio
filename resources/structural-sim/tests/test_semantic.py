import copy,math,unittest
from structural_sim.semantic import validate_binding

class Boundaries(unittest.TestCase):
    def setUp(self):
        end=math.pi*(500**2-450**2)-18*math.pi*7.5**2
        self.b={'schema_version':1,'source_sha256':'a','equivalence':{'approved':True,'reference_step_data_sha256':'b','difference_volumes_mm3':[0,0],'tolerance_mm3':.1},'bindings':{
            'interface.fixed_support':{'shell_set':'bottom','face_count':1,'area_mm2':end},
            'interface.axial_load':{'shell_set':'top','face_count':1,'area_mm2':end},
            'interface.external_pressure':{'shell_set':'skin','face_count':1,'area_mm2':2*math.pi*500*500}}}
    def test_valid(self):validate_binding(self.b,'a','b')
    def test_wrong_pressure_area(self):
        self.b['bindings']['interface.external_pressure']['area_mm2']/=2
        with self.assertRaises(ValueError):validate_binding(self.b)
    def test_stale(self):
        with self.assertRaises(ValueError):validate_binding(self.b,'changed','b')
    def test_shape_difference(self):
        self.b['equivalence']['difference_volumes_mm3'][0]=1
        with self.assertRaises(ValueError):validate_binding(self.b)
    def test_mapped_deck_matches_legacy(self):
        import tempfile,json
        from pathlib import Path
        from structural_sim.cylinder import write_deck
        # Small representative quadratic shell patches: same physics, different mapping path.
        points=[[0,0,494],[1,0,494],[1,1,494],[0,1,494],[.5,0,494],[1,.5,494],[.5,1,494],[0,.5,494]]
        for z in [6]:points += [[x,y,z] for x,y,_ in points[:8]]
        points += [[500,0,10],[500,1,10],[500,1,11],[500,0,11],[500,.5,10],[500,1,10.5],[500,.5,11],[500,0,10.5]]
        mesh=dict(points=points,elements=[list(range(8)),list(range(8,16)),list(range(16,24))],kinds=['top','bottom','skin'],types=['S8R']*3)
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/'a';b=Path(t)/'b';a.mkdir();b.mkdir()
            for mode in ['static','nonlinear','buckling']:
                with self.subTest(mode=mode):
                    mesh.pop('semantic_bindings',None)
                    write_deck(a,mesh,mode);mesh['semantic_bindings']=self.b;write_deck(b,mesh,mode)
                    self.assertEqual((a/'analysis.inp').read_bytes(),(b/'analysis.inp').read_bytes())

if __name__=='__main__':unittest.main()
