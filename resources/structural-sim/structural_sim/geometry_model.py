"""Geometry contract for independently editable integral cylinder components."""
from copy import deepcopy
import math
import re


def default_model():
    components = [
        dict(id='skin', kind='skin', name='蒙皮', thickness_mm=2.5),
        dict(id='frame.bottom', kind='flange', name='下端框', end='bottom', thickness_mm=12., width_mm=50., hole_count=18, hole_diameter_mm=15., bolt_circle_mm=970., phase_deg=0.),
        dict(id='frame.top', kind='flange', name='上端框', end='top', thickness_mm=12., width_mm=50., hole_count=18, hole_diameter_mm=15., bolt_circle_mm=970., phase_deg=0.),
    ]
    components += [dict(id=f'longitudinal.{i+1:03}', kind='longitudinal', name=f'纵筋 {i+1:02}', angle_deg=i*30., width_mm=8., height_mm=12.) for i in range(12)]
    components += [dict(id=f'ring.{i:03}', kind='ring', name=f'环筋 {i:02}', z_mm=12+476*i/6, width_mm=8., height_mm=12.) for i in range(1,6)]
    return dict(schema_version=1, units='mm', diameter_mm=1000., height_mm=500., components=components)


def validate_model(value):
    if not isinstance(value, dict) or value.get('schema_version') != 1 or value.get('units') != 'mm':
        raise ValueError('Unsupported cylinder geometry model')
    def number(obj, key, lo, hi):
        v=obj.get(key)
        if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError('Invalid geometry parameter: '+key)
        return float(v)
    diameter=number(value,'diameter_mm',100,10000); height=number(value,'height_mm',50,10000); radius=diameter/2
    parts=value.get('components')
    if not isinstance(parts,list) or len(parts)>200:raise ValueError('Invalid cylinder components')
    ids=[p.get('id') for p in parts if isinstance(p,dict)]
    if len(ids)!=len(parts) or any(not isinstance(i,str) or not re.fullmatch(r'[a-z][a-z0-9.]{0,63}',i) for i in ids) or len(ids)!=len(set(ids)):
        raise ValueError('Component IDs must be unique stable identifiers')
    if set(ids)!={p['id'] for p in default_model()['components']}:raise ValueError('Cylinder component topology is fixed; edit existing component parameters')
    by={p['id']:p for p in parts}
    if not all(k in by for k in ['skin','frame.bottom','frame.top']):raise ValueError('Cylinder requires skin and both end frames')
    if by['skin'].get('kind')!='skin' or sum(p.get('kind')=='skin' for p in parts)!=1:raise ValueError('Exactly one skin is required')
    skin=number(by['skin'],'thickness_mm',.5,min(50,radius/10))
    frames=[]
    for end in ['bottom','top']:
        p=by['frame.'+end]
        if p.get('kind')!='flange' or p.get('end')!=end:raise ValueError('End frame identity mismatch')
        t=number(p,'thickness_mm',1,min(height/4,100))
        w=number(p,'width_mm',skin+1,radius*.8)
        n=number(p,'hole_count',3,100)
        if int(n)!=n:raise ValueError('Hole count must be integral')
        hd=number(p,'hole_diameter_mm',1,w-1); bc=number(p,'bolt_circle_mm',1,diameter)
        number(p,'phase_deg',-360,360)
        if (bc-hd)/2 <= radius-w or (bc+hd)/2 >= radius-skin:
            raise ValueError('Bolt holes must remain inside frame and clear of skin')
        if bc*math.sin(math.pi/n)<=hd:raise ValueError('Bolt holes overlap')
        frames.append(p)
    if sum(p.get('kind')=='flange' for p in parts)!=2:raise ValueError('Exactly two end frames are required')
    bottom,top=frames
    longs=[];rings=[]
    for p in parts:
        kind=p.get('kind')
        if kind not in ['skin','flange','longitudinal','ring']:raise ValueError('Unknown component kind')
        if kind in ['longitudinal','ring']:
            if not p['id'].startswith(kind+'.'):raise ValueError('Component ID kind mismatch')
            number(p,'width_mm',1,50); number(p,'height_mm',1,min(radius/3,100))
            if kind=='longitudinal':
                number(p,'angle_deg',-360,360);longs.append(p)
            else:
                z=number(p,'z_mm',0,height)
                if z-p['width_mm']/2<=bottom['thickness_mm'] or z+p['width_mm']/2>=height-top['thickness_mm']:
                    raise ValueError('Ring must lie strictly between end frames')
                rings.append(p)
    if not longs or not rings:raise ValueError('Cylinder needs longitudinal and ring stiffeners')
    for i,a in enumerate(longs):
        for b in longs[i+1:]:
            delta=abs((a['angle_deg']-b['angle_deg']+180)%360-180)
            inner=radius-skin-max(a['height_mm'],b['height_mm'])
            if 2*inner*math.sin(math.radians(delta)/2) <= (a['width_mm']+b['width_mm'])/2:
                raise ValueError('Longitudinal stiffeners overlap')
    rings.sort(key=lambda p:p['z_mm'])
    if any(b['z_mm']-a['z_mm'] <= (a['width_mm']+b['width_mm'])/2 for a,b in zip(rings,rings[1:])):
        raise ValueError('Ring stiffeners overlap')
    result=deepcopy(value)
    for part in result['components']:
        if part['kind']=='flange':part['hole_count']=int(part['hole_count'])
    return result


def parameters(model=None):
    model=validate_model(default_model() if model is None else model)
    by={p['id']:p for p in model['components']}
    r=model['diameter_mm']/2; skin=by['skin']['thickness_mm']
    z0=by['frame.bottom']['thickness_mm']/2
    z1=model['height_mm']-by['frame.top']['thickness_mm']/2
    return model,by,r,skin,r-skin/2,z0,z1


def boundary_areas(model=None):
    model,by,r,skin,rm,z0,z1=parameters(model)
    areas={'skin':2*math.pi*r*model['height_mm']}
    for end in ['bottom','top']:
        p=by['frame.'+end]
        areas[end]=math.pi*(r*r-(r-p['width_mm'])**2)-p['hole_count']*math.pi*(p['hole_diameter_mm']/2)**2
    return areas


# Shared by CAD construction and the shell adapter.
normalize_model = validate_model


def offset_hole_phase(model=None, degrees=0.):
    """Diagnostic model; preserve IDs while recording the actual changed hole phase."""
    result=parameters(model)[0]
    if degrees:
        for part in result['components']:
            if part['kind']=='flange':part['phase_deg']=(part['phase_deg']+degrees+180)%360-180
    return result
