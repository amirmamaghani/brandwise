# tiny SVG helper: boxes with wrapped text, arrows, legend. Output is plain SVG with a white panel (readable on light and dark GitHub themes).
import html
PAL = {"human":("#FFF4D9","#D99A0B"),"agent":("#EFEAFF","#7357F2"),"code":("#E4EEFF","#3B7BE8"),"store":("#E2F5E9","#2E9D5B"),"world":("#F0F2F4","#7D8791"),"warn":("#FDE8E8","#D64545")}
class S:
    def __init__(s,w,h,title): s.w,s.h=w,h; s.o=[]; s.title=title
    def box(s,x,y,w,h,title,lines=(),kind="code",size=13,tsize=15):
        f,st=PAL[kind]; s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{f}" stroke="{st}" stroke-width="1.6"/>')
        n=len(lines); total=tsize+ (n*(size+4)); ty=y+ (h-total)/2 + tsize
        s.o.append(f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-size="{tsize}" font-weight="700" fill="#1f2933">{html.escape(title)}</text>')
        for i,l in enumerate(lines): s.o.append(f'<text x="{x+w/2}" y="{ty+8+(i+1)*(size+4)-2}" text-anchor="middle" font-size="{size}" fill="#3e4c59">{html.escape(l)}</text>')
    def group(s,x,y,w,h,label,kind="world"):
        f,st=PAL[kind]; s.o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{f}" fill-opacity="0.35" stroke="{st}" stroke-width="1.2" stroke-dasharray="6 5"/>')
        s.o.append(f'<text x="{x+14}" y="{y+22}" font-size="13" font-weight="700" fill="{st}" letter-spacing="0.5">{html.escape(label.upper())}</text>')
    def arrow(s,pts,label=None,lx=None,ly=None,dashed=False,color="#52606d"):
        d="M"+" L".join(f"{x} {y}" for x,y in pts)
        s.o.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8" {"stroke-dasharray=\"6 4\"" if dashed else ""} marker-end="url(#a)"/>')
        if label:
            x,y=(lx,ly) if lx is not None else ((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2-6)
            s.o.append(f'<text x="{x}" y="{y}" text-anchor="middle" font-size="12" fill="#52606d" font-style="italic">{html.escape(label)}</text>')
    def text(s,x,y,t,size=13,weight="400",anchor="start",fill="#3e4c59"): s.o.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" fill="{fill}">{html.escape(t)}</text>')
    def legend(s,x,y,items):
        for i,(k,t) in enumerate(items):
            f,st=PAL[k]; xx=x+i*165; s.o.append(f'<rect x="{xx}" y="{y-12}" width="18" height="14" rx="4" fill="{f}" stroke="{st}" stroke-width="1.4"/>'); s.text(xx+26,y,t,12)
    def save(s,path):
        head=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s.w} {s.h}" width="{s.w}" height="{s.h}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif" role="img" aria-label="{html.escape(s.title)}"><title>{html.escape(s.title)}</title><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#52606d"/></marker></defs><rect width="{s.w}" height="{s.h}" rx="16" fill="#ffffff" stroke="#d9dee3"/>'
        open(path,"w").write(head+"".join(s.o)+"</svg>\n")
