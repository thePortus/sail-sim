import numpy as np, json
S='/private/tmp/claude-505/-Users-thomaei-git-apps-sail-sim-redux/bffda18c-a55a-406e-a3c2-19d345245637/scratchpad'
M=json.load(open(f'{S}/masters_v5.json')); mMid,mFore,mAft=M['masterMid'],M['masterFore'],M['masterAft']
def wf(m,v): return float(np.interp(v,[a[0] for a in m],[a[1] for a in m]))
def catmull(anch,s):
    ys=[a[1] for a in anch]; i=int(np.clip(np.floor(s),0,len(ys)-2)); t=s-i
    p0=ys[max(i-1,0)];p1=ys[i];p2=ys[i+1];p3=ys[min(i+2,len(ys)-1)]
    return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
Beam =[(i,v) for i,v in enumerate([0.28,2.90,4.80,5.90,6.60,6.807,6.75,6.45,5.90,5.20,4.40])]
RailZ=[(i,v) for i,v in enumerate([7.35,7.00,6.50,6.10,5.85,5.70,5.85,6.05,6.20,6.35,6.55])]
Full =[(i,v) for i,v in enumerate([0.10,0.32,0.56,0.77,0.92,1.00,0.96,0.86,0.68,0.44,0.26])]
W=json.load(open(f'{S}/world_points.json'))
keel=sorted([(p[0],p[1]) for p in W['keel']]+[tuple(W['sternpost'][0])])
kY=np.array([p[0] for p in keel]); kZ=np.array([p[1] for p in keel])
YCUT=[(-6.30,-22.00),(0.0,-26.65),(4.7,-30.90)]  # only need forefoot region
def rabbet(Y):
    if Y<=-22.0: return float(np.interp(Y,[-30.9,-26.65,-22.0],[4.7,0.0,-6.30]))
    return float(np.interp(Y,kY,kZ))
def Ystn(s): return -26.651+s*5.3302
def section(s,NV=60):
    beam=catmull(Beam,s); railz=catmull(RailZ,s); c=float(np.clip(catmull(Full,s),0,1))
    endM=mFore if s<=5 else mAft; Y=Ystn(s); zr=rabbet(Y)+0.10; out=[]
    for k in range(NV):
        v=k/(NV-1); x=beam*((1-c)*wf(endM,v)+c*wf(mMid,v))
        out.append((x, zr+v*(railz-zr)))
    return out,Y,railz
def half_at(s,z):
    pts,Y,railz=section(s); zs=[p[1] for p in pts]; xs=[p[0] for p in pts]
    if z<=zs[0] or z>=zs[-1]: return None,Y
    return float(np.interp(z,zs,xs)),Y
RZmid=catmull(RailZ,5)
def sheer(s): return catmull(RailZ,s)-RZmid

# ---- DECKS: spar (weather) + gun ----
def deck(name, drop, camber, inset, s0, s1):
    ss=np.linspace(s0,s1,60); rings=[]
    for s in ss:
        railz=catmull(RailZ,s); dz=railz-drop
        hw,Y=half_at(s,dz)
        if hw is None: continue
        edge=max(0.2,hw-inset); NL=17; line=[]
        for j in range(NL):
            x=-edge+2*edge*j/(NL-1); zc=dz+camber*(1-(x/edge)**2)
            line.append((round(x,3),round(Y,3),round(zc,3)))
        rings.append(line)
    return {'name':name,'rings':rings,'NL':17}
spar=deck('SparDeck', 1.45, 0.22, 0.18, 0.7, 9.7)
gun =deck('GunDeck',  1.45+2.13, 0.20, 0.16, 0.7, 9.9)

# ---- WALES: main wale (~z-0.5) + sheer strake (~z+4.6), follow sheer ----
def wale(name, zc_mid, halfh, proud, s0, s1):
    ss=np.linspace(s0,s1,80); top=[]; bot=[]
    for s in ss:
        zc=zc_mid+sheer(s)
        hwT,Y=half_at(s,zc+halfh); hwB,_=half_at(s,zc-halfh)
        if hwT is None or hwB is None: continue
        top.append((round(hwT+proud,3),round(Y,3),round(zc+halfh,3)))
        bot.append((round(hwB+proud,3),round(Y,3),round(zc-halfh,3)))
    return {'name':name,'top':top,'bot':bot}
main_wale=wale('MainWale', -0.45, 0.42, 0.11, 0.9, 9.6)
sheer_wale=wale('SheerWale', 4.55, 0.30, 0.10, 0.9, 9.7)

json.dump({'decks':[spar,gun],'wales':[main_wale,sheer_wale]}, open(f'{S}/decks_wales.json','w'))
print('spar rings',len(spar['rings']),'gun rings',len(gun['rings']))
print('main wale pts',len(main_wale['top']),'sheer wale pts',len(sheer_wale['top']))
print('spar deck z @mid', round(catmull(RailZ,5)-1.45,2), 'gun deck z @mid', round(catmull(RailZ,5)-1.45-2.13,2))
