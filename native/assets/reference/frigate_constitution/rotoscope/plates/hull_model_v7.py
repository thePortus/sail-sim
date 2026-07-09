import numpy as np, json
S='/private/tmp/claude-505/-Users-thomaei-git-apps-sail-sim-redux/bffda18c-a55a-406e-a3c2-19d345245637/scratchpad'
M=json.load(open(f'{S}/masters_v5.json'))
mMid,mFore,mAft=M['masterMid'],M['masterFore'],M['masterAft']
def wf(m,v): return float(np.interp(v,[a[0] for a in m],[a[1] for a in m]))
def catmull(anch,s):
    ys=[a[1] for a in anch]; i=int(np.clip(np.floor(s),0,len(ys)-2)); t=s-i
    p0=ys[max(i-1,0)];p1=ys[i];p2=ys[i+1];p3=ys[min(i+2,len(ys)-1)]
    return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
Beam =[(i,v) for i,v in enumerate([0.28,2.90,4.80,5.90,6.60,6.807,6.75,6.45,5.90,5.20,4.40])]
RailZ=[(i,v) for i,v in enumerate([7.35,7.00,6.50,6.10,5.85,5.70,5.85,6.05,6.20,6.35,6.55])]
Full =[(i,v) for i,v in enumerate([0.10,0.32,0.56,0.77,0.92,1.00,0.96,0.86,0.68,0.44,0.26])]
W=json.load(open(f'{S}/world_points.json'))
bb=[tuple(W['sternpost'][0])]+[tuple(p) for p in W['keel']]+[tuple(p) for p in W['stem']]
bbY=np.array([p[0] for p in bb]); bbZ=np.array([p[1] for p in bb])
def rabbet(Y):
    m=np.abs(bbY-Y)<1.4; return float(bbZ[m].min()) if m.any() else -6.42
def Ystn(s): return -26.651+s*5.3302
NV=46
def section(s):
    beam=catmull(Beam,s); railz=catmull(RailZ,s); c=float(np.clip(catmull(Full,s),0,1))
    endM=mFore if s<=5 else mAft
    Y=Ystn(s); zr=rabbet(Y)+0.10; out=[]
    for k in range(NV):
        v=k/(NV-1); x=beam*((1-c)*wf(endM,v)+c*wf(mMid,v))
        if k==0: x=0.0   # close keel to centerline (sided keel is a separate piece)
        out.append((round(x,4),round(Y,4),round(zr+v*(railz-zr),4)))
    return out

# ---- stem (bow) leading edge Y as a function of height z ----
stem=[p for p in W['stem']]            # (Y,z) at x=0, forefoot->head
sy=np.array([p[0] for p in stem]); sz=np.array([p[1] for p in stem])
o=np.argsort(sz); szs,sys_=sz[o],sy[o]
def Ystem(z):
    if z<=szs[0]: return float(sys_[0])
    if z>=szs[-1]: return float(sys_[-1])
    return float(np.interp(z,szs,sys_))
sec0=section(0.0)
stem_ring=[(0.0, round(Ystem(z),4), z) for (_,_,z) in sec0]

# ---- stern transom rings (appended to the SAME loft) ----
aft=section(10.0); TUCK=0.6
zA=[(0.6,27.60),(2.2,27.95),(3.5,28.55),(4.8,29.10),(6.0,29.50),(6.9,29.65),(7.2,29.68)]
xA=[(0.6,0.05),(1.4,1.5),(2.2,2.6),(3.5,3.5),(4.8,3.95),(6.0,4.05),(6.9,3.95),(7.2,3.6)]
rake=lambda z: float(np.interp(z,[a[0] for a in zA],[a[1] for a in zA]))
twid=lambda z: float(np.interp(z,[a[0] for a in xA],[a[1] for a in xA]))
postY=lambda z: 27.15+(27.60-27.15)*float(np.clip((z+6.8)/(TUCK+6.8),0,1))
target=[]; center=[]
for (x,y,z) in aft:
    if z<=TUCK: target.append((0.0,round(postY(z),4),z)); center.append((0.0,round(postY(z),4),z))
    else:       target.append((round(twid(z),4),round(rake(z),4),z)); center.append((0.0,round(rake(z),4),z))

# ---- assemble one ordered ring list bow->stern ----
fwd=[0.08,0.2,0.35,0.55,0.8]
mid=[i/8.0 for i in range(8,81)]           # 1.0..10.0 (denser)
counter=[ ( round((a[0]+t[0])/2,4), round((a[1]+t[1])/2,4), round((a[2]+t[2])/2,4) )
           for a,t in zip(aft,target) ]
rings=[stem_ring, sec0]+[section(s) for s in fwd]+[section(s) for s in mid]+[counter, target, center]
json.dump({'rings':rings,'NV':NV,'ribs':{str(i):section(i) for i in range(1,11)}}, open(f'{S}/hull_param.json','w'))
print('rings',len(rings),'NV',NV,'(stem + bow + main + transom)')
