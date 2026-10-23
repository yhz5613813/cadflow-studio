"""Render the confirmed STEP tessellation with Blender Cycles. No AI image generation."""
import bpy, math, json, sys, hashlib, os
from pathlib import Path
from mathutils import Vector

def disk_path(p):
    value=os.path.abspath(p)
    if os.name=='nt' and not value.startswith('\\\\?\\'):
        value=('\\\\?\\UNC\\'+value[2:]) if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)



out=Path(sys.argv[sys.argv.index('--')+1]).resolve()
model=json.loads((out/'model.json').read_text(encoding='utf-8'))
scale=max(model['diameter_mm']/1000,model['height_mm']/500)
height=model['height_mm']/1000
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.device='CPU'
scene.cycles.samples=24
scene.cycles.use_adaptive_sampling=True
scene.cycles.adaptive_threshold=.06
scene.cycles.adaptive_min_samples=8
scene.cycles.use_denoising=True
scene.cycles.max_bounces=7
scene.render.resolution_x=1800
scene.render.resolution_y=1000
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.image_settings.color_mode='RGB'
scene.render.film_transparent=False
scene.unit_settings.system='METRIC'
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.world.color=(.3,.3,.3)
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.38,.43,.5,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.3

def material(name,color,metallic,roughness):
    m=bpy.data.materials.new(name);m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1)
    p.inputs['Metallic'].default_value=metallic
    p.inputs['Roughness'].default_value=roughness
    return m
aluminium=material('Satin aluminium',(.48,.53,.59),.78,.29)
sectionmat=material('Cut faces - warm highlight',(.56,.29,.09),.65,.34)
groundmat=material('Neutral studio floor',(.24,.28,.33),0,.7)
parts=[]
for name in ['cad-full','cad-cutaway']:
    bpy.ops.wm.stl_import(filepath=str(out/(name+'.stl')))
    obj=bpy.context.object;obj.name=name
    obj.scale=(.001,.001,.001)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    obj.data.materials.clear()
    obj.data.materials.append(aluminium)
    obj.data.materials.append(sectionmat)
    if name=='cad-cutaway':
        for poly in obj.data.polygons:
            co=[obj.data.vertices[i].co for i in poly.vertices]
            if all(abs(v.x)<1e-6 for v in co) or all(abs(v.y)<1e-6 for v in co):
                poly.material_index=1
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
    obj['source']='Current published STEP tessellation, mm to m scale'
    obj['display_only_section']=name=='cad-cutaway'
    parts.append(obj)

bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.003))
ground=bpy.context.object;ground.name='Studio floor';ground.data.materials.append(groundmat)
def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
def area(name,loc,power,size,color):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=color
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=tuple(v*scale for v in loc);data.energy=power*scale*scale;data.size=size*scale;aim(obj,(0,0,height*.4))
area('Large key softbox',(1.1,-1.4,2.6),180,2.2,(1,.96,.9))
area('Cool rim',(-1.4,.7,1.8),220,1.6,(.78,.87,1))
area('Front fill',(.3,-2,.6),60,1.8,(.9,.95,1))
area('Rear strip',(1.2,1,1.5),160,1.2,(1,1,1))
camdata=bpy.data.cameras.new('Engineering orthographic')
camera=bpy.data.objects.new('Engineering orthographic',camdata);scene.collection.objects.link(camera)
camera.location=Vector((1.65,-2.35,1.61))*scale+Vector((0,0,height*.48));aim(camera,(0,0,height*.48))
camdata.type='ORTHO';camdata.ortho_scale=2.04*scale;camdata.lens=52
scene.camera=camera
preview='--preview' in sys.argv
if preview:
    scene.render.resolution_percentage=40
    scene.cycles.samples=8
    scene.cycles.adaptive_min_samples=4
for active in parts:
    for obj in parts:obj.hide_render=obj!=active;obj.hide_set(obj!=active)
    scene.render.filepath=str(out/(('preview-' if preview else '')+active.name+'.png'))
    if not preview:bpy.ops.wm.save_as_mainfile(filepath=str(out/(active.name+'.blend')))
    bpy.ops.render.render(write_still=True)
disk_path(out/('preview-settings.json' if preview else 'render-settings.json')).write_text(json.dumps({
    'blender_version':bpy.app.version_string,'engine':'Cycles','samples':scene.cycles.samples,
    'adaptive_threshold':scene.cycles.adaptive_threshold,'adaptive_min_samples':scene.cycles.adaptive_min_samples,
    'resolution':[scene.render.resolution_x*scene.render.resolution_percentage//100,scene.render.resolution_y*scene.render.resolution_percentage//100],'material':'Satin aluminium, display-only warm cut faces',
    'camera':'Orthographic','geometry':'Existing confirmed CAD, no deformation',
    'images':['cad-full.png','cad-cutaway.png']},indent=2),encoding='utf-8')

if not preview:
    def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
    disk_path(out/'render-manifest.json').write_text(json.dumps({'source_sha256':sha(out/'cylinder.step'),'renderer':'Blender Cycles','full':'cad-full.png','cutaway':'cad-cutaway.png','image_sha256':{n:sha(out/n) for n in ['cad-full.png','cad-cutaway.png']}},indent=2),encoding='utf-8')
