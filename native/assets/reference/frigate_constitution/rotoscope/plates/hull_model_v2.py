import numpy as np, json
S='/private/tmp/claude-505/-Users-thomaei-git-apps-sail-sim-redux/bffda18c-a55a-406e-a3c2-19d345245637/scratchpad'

# ---------- master sections: widthFrac(v), v=0 rabbet -> v=1 rail ----------
masterU = [  # full midship (from 1926 Lord section): hollow garboard, firm bilge, wall-side, tumblehome
 (0.000,0.038),(0.043,0.132),(0.084,0.250),(0.126,0.375),(0.167,0.477),(0.208,0.566),
 (0.249,0.646),(0.291,0.720),(0.332,0.793),(0.373,0.859),(0.415,0.918),(0.456,0.955),
 (0.497,0.984),(0.538,0.998),(0.580,1.000),(0.621,0.987),(0.662,0.962),(0.704,0.930),
 (0.745,0.893),(0.786,0.856),(0.828,0.823),(0.869,0.793),(0.910,0.776),(0.952,0.761),(1.000,0.749)]
masterV = [  # fine end: deep deadrise, hollow garboard, flaring topside (no tumblehome)
 (0.00,0.00),(0.06,0.03),(0.12,0.07),(0.20,0.14),(0.28,0.22),(0.36,0.31),(0.44,0.41),
 (0.52,0.52),(0.60,0.63),(0.68,0.73),(0.76,0.82),(0.84,0.90),(0.92,0.96),(1.00,1.00)]
def wf(master, v):
    vs=[m[0] for m in master]; fs=[m[1] for m in master]
    return float(np.interp(v, vs, fs))

# ---------- Catmull-Rom through faired station anchors ----------
def catmull(anchors, s):  # anchors: list of (x,y) at integer stations 0..10
    xs=[a[0] for a in anchors]; ys=[a[1] for a in anchors]
    i=int(np.clip(np.floor(s),0,len(xs)-2)); t=s-i
    p0=ys[max(i-1,0)]; p1=ys[i]; p2=ys[i+1]; p3=ys[min(i+2,len(ys)-1)]
    return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)

Beam    = [(i,v) for i,v in enumerate([0.35,2.90,4.80,5.90,6.60,6.807,6.70,6.20,5.30,3.90,1.90])]
RailZ   = [(i,v) for i,v in enumerate([7.35,7.00,6.50,6.10,5.85,5.70,5.85,6.05,6.20,6.35,6.55])]
Full    = [(i,v) for i,v in enumerate([0.15,0.35,0.60,0.80,0.93,1.00,0.97,0.88,0.72,0.50,0.32])]

# rabbet from the traced keel/stem backbone
W=json.load(open(f'{S}/world_points.json'))
bb=[tuple(W['sternpost'][0])]+[tuple(p) for p in W['keel']]+[tuple(p) for p in W['stem']]
bbY=np.array([p[0] for p in bb]); bbZ=np.array([p[1] for p in bb])
def rabbet(Y):
    m=np.abs(bbY-Y)<1.4
    return float(bbZ[m].min()) if m.any() else float(np.interp(Y, sorted(bbY), [z for _,z in sorted(zip(bbY,bbZ))]))

def Ystn(s): return -26.651 + s*5.3302

def section(s, NV=44):
    beam=catmull(Beam,s); railz=catmull(RailZ,s); c=np.clip(catmull(Full,s),0,1)
    Y=Ystn(s); zr=rabbet(Y)+0.10; zt=railz
    pts=[]
    for k in range(NV):
        v=k/(NV-1)
        x=beam*((1-c)*wf(masterV,v)+c*wf(masterU,v))
        z=zr+v*(zt-zr)
        pts.append((round(x,4),round(Y,4),round(z,4)))
    return pts

# stations for ribs (integers) and dense loft
ribs={i:section(i) for i in range(1,11)}
dense=[section(s/4.0) for s in range(4,41)]   # s=1.0 .. 10.0 every 0.25
json.dump({'ribs':{str(k):v for k,v in ribs.items()},'dense':dense,
           'NV':44}, open(f'{S}/hull_param.json','w'))
print('beam@mid',round(catmull(Beam,5),3),'rail@mid',round(catmull(RailZ,5),3),
      'rabbet@mid',round(rabbet(0),3))
print('beam(s) sampled:', [round(catmull(Beam,s),2) for s in range(11)])
print('rib count',len(ribs),'dense stations',len(dense))
