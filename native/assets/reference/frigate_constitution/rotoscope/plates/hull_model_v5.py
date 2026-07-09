import numpy as np, json
S='/private/tmp/claude-505/-Users-thomaei-git-apps-sail-sim-redux/bffda18c-a55a-406e-a3c2-19d345245637/scratchpad'
M=json.load(open(f'{S}/masters_v4.json'))
mMid,mFore,mAft=M['masterMid'],M['masterFore'],M['masterAft']
def wf(m,v):
    return float(np.interp(v,[a[0] for a in m],[a[1] for a in m]))
def catmull(anchors,s):
    ys=[a[1] for a in anchors]; i=int(np.clip(np.floor(s),0,len(ys)-2)); t=s-i
    p0=ys[max(i-1,0)];p1=ys[i];p2=ys[i+1];p3=ys[min(i+2,len(ys)-1)]
    return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
Beam =[(i,v) for i,v in enumerate([0.35,2.90,4.80,5.90,6.60,6.807,6.75,6.45,5.90,5.20,4.40])]
RailZ=[(i,v) for i,v in enumerate([7.35,7.00,6.50,6.10,5.85,5.70,5.85,6.05,6.20,6.35,6.55])]
Full =[(i,v) for i,v in enumerate([0.10,0.32,0.56,0.77,0.92,1.00,0.96,0.86,0.68,0.44,0.26])]
W=json.load(open(f'{S}/world_points.json'))
bb=[tuple(W['sternpost'][0])]+[tuple(p) for p in W['keel']]+[tuple(p) for p in W['stem']]
bbY=np.array([p[0] for p in bb]); bbZ=np.array([p[1] for p in bb])
def rabbet(Y):
    m=np.abs(bbY-Y)<1.4; return float(bbZ[m].min()) if m.any() else -6.42
def Ystn(s): return -26.651+s*5.3302
def section(s,NV=46):
    beam=catmull(Beam,s); railz=catmull(RailZ,s); c=float(np.clip(catmull(Full,s),0,1))
    endM = mFore if s<=5 else mAft
    Y=Ystn(s); zr=rabbet(Y)+0.10; pts=[]
    for k in range(NV):
        v=k/(NV-1)
        x=beam*((1-c)*wf(endM,v)+c*wf(mMid,v))
        pts.append((round(x,4),round(Y,4),round(zr+v*(railz-zr),4)))
    return pts
ribs={i:section(i) for i in range(1,11)}
dense=[section(s/4.0) for s in range(4,41)]
json.dump({'ribs':{str(k):v for k,v in ribs.items()},'dense':dense,'NV':46},open(f'{S}/hull_param.json','w'))
print('rebuilt 3-master. ribs',len(ribs),'dense',len(dense))
