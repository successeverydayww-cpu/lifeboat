import json, subprocess, math, os, time
import numpy as np, soundfile as sf
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W,H,FPS=1920,1080,30
SR=44100
GOLD=(245,183,10); CREAM=(244,241,230)
GREEN1=(8,40,18); GREEN2=(16,74,36)
FT="/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
FB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

secs=json.load(open("voice/sections.json"))
LEAD=0.5
_speech=sum(s['voice_dur'] for s in secs)
TAIL=max(0.4,(90.0-_speech-LEAD*len(secs)-2.2-2.6)/(len(secs)-2))
slots=[]; t=0.0
for s in secs:
    tail=TAIL
    if s['label']=='intro': tail=2.2
    if s['label']=='close': tail=2.6
    d=LEAD+s['voice_dur']+tail
    slots.append({'start':t,'dur':round(d,3),'voice_at':t+LEAD,**s}); t+=d
TOTAL=t; print("total",round(TOTAL,2),flush=True)

# ---------- AUDIO ----------
dur=int(math.ceil(TOTAL*SR))
voice=np.zeros(dur,np.float32)
for sl in slots:
    a,sr=sf.read(f"voice/{sl['i']:02d}_{sl['label']}.wav",dtype='float32')
    if a.ndim>1: a=a.mean(axis=1)
    if sr!=SR: a=np.interp(np.arange(len(a))*SR/sr,np.arange(len(a)),a)
    i0=int(sl['voice_at']*SR); voice[i0:i0+len(a)]+=a[:max(0,dur-i0)]
voice=voice/(np.abs(voice).max()+1e-9)*0.9

# music: ONE slow-evolving pad, no rhythmic pulsing. 8s chords w/ 1.5s raised-cosine crossfades.
chords=[[130.8,164.8,196.0,261.6],[98.0,123.5,196.0,246.9],[110.0,130.8,164.8,220.0],[87.3,110.0,174.6,220.0]]
def chord_tone(ch,t,phase):
    out=np.zeros(len(t),np.float32)
    for f in ch:
        for m,c in [(1,1.0),(2,0.25),(3,0.10)]:
            out+=c*np.sin(2*np.pi*f*m*t+phase)
    return out
music=np.zeros(dur,np.float32)
seg=8.0; xf=1.5; k=0; s0=-xf
while s0<TOTAL:
    ch=chords[k%4]; k+=1
    s1=s0+seg
    a0=max(0.0,s0); a1=min(TOTAL,s1)
    if a1<=a0: break
    n=int((a1-a0)*SR); tt=np.arange(n)/SR+(a0-s0)
    # raised-cosine ramp up first 1.5s, flat middle, ramp down last 1.5s
    w=np.ones(n,np.float32)
    up=np.minimum(1,tt/xf); dn=np.clip((seg-tt)/xf,0,1)
    w=np.minimum(up,dn)
    i0=int(a0*SR)
    music[i0:i0+n]+=chord_tone(ch,tt,0.31*k)*w
    s0+=seg
music[:int(2*SR)]*=np.linspace(0,1,int(2*SR))          # global fade-in
music[-int(3*SR):]*=np.linspace(1,0,int(3*SR))         # global fade-out
# one-pole lowpass, very smooth
alpha=0.06; lp=np.zeros_like(music); acc=0.0
for i in range(len(music)):
    acc+=alpha*(music[i]-acc); lp[i]=acc
# music RMS target = 6% of voice RMS
vrms=np.sqrt((voice**2).mean())+1e-9
mrms=np.sqrt((lp**2).mean())+1e-9
music=lp*(vrms*0.06/mrms)
mix=voice+music
mix=mix/np.abs(mix).max()*0.97
sf.write("promo/mix.wav",mix,SR)
print("audio: voice RMS %.4f music RMS %.4f ratio %.3f"%(np.sqrt((voice**2).mean()),np.sqrt((music**2).mean()),np.sqrt((music**2).mean())/np.sqrt((voice**2).mean())),flush=True)

# ---------- VISUALS ----------
def make_bg():
    img=Image.new('RGB',(W,H)); d=ImageDraw.Draw(img)
    for y in range(H):
        k=y/H
        d.line([(0,y),(W,y)],fill=tuple(int(GREEN1[i]+(GREEN2[i]-GREEN1[i])*k) for i in range(3)))
    glow=Image.new('L',(W,H),0); gd=ImageDraw.Draw(glow)
    for rad,a in [(780,26),(560,18),(360,10)]:
        gd.ellipse([W/2-rad,-rad*0.6,W/2+rad,rad*1.2],fill=a)
    glow=glow.filter(ImageFilter.GaussianBlur(90))
    img=Image.composite(Image.new('RGB',(W,H),GOLD),img,glow.point(lambda p:p*2 if p<127 else 255))
    vg=Image.new('L',(W,H),0); vd=ImageDraw.Draw(vg)
    vd.rectangle([0,0,W,H],fill=110); vd.ellipse([-240,-180,W+240,H+180],fill=0)
    vg=vg.filter(ImageFilter.GaussianBlur(120))
    img=Image.composite(Image.new('RGB',(W,H),(0,0,0)),img,vg)
    return img
BG=make_bg()

PHONE_H=980; PHONE_X=120
def load_shot(name):
    im=Image.open(f"shots/{name}.png").convert('RGB')
    w=int(im.width*PHONE_H/im.height)
    return im.resize((w,PHONE_H),Image.LANCZOS)

F_TITLE=ImageFont.truetype(FT,96)
F_SUB=ImageFont.truetype(FT,44)
F_LAB=ImageFont.truetype(FB,30)
F_CAP=ImageFont.truetype(FB,50)
F_CAP2=ImageFont.truetype(FB,44)
F_CAP3=ImageFont.truetype(FB,40)
F_BRAND=ImageFont.truetype(FB,30)

LABELS={"intro":"THE APP","signup":"SIGN UP","home":"YOUR HOME","subjects":"SUBJECTS",
 "setup":"PRACTICE MODES","quiz":"REAL QUESTIONS","calc":"CALCULATOR","agent":"THE AGENT",
 "progress":"YOUR PROGRESS","novel":"JAMB NOVEL","tools":"MORE TOOLS","close":"GET STARTED"}

def wrap(d,text,font,maxw):
    lines=[]; cur=""
    for w_ in text.split():
        tt=(cur+" "+w_).strip()
        if d.textlength(tt,font=font)<=maxw: cur=tt
        else: lines.append(cur); cur=w_
    if cur: lines.append(cur)
    return lines

cap_cache={}
PANEL_X0,PANEL_X1=680,1840
def caption_overlay(text,label):
    ov=Image.new('RGBA',(W,H),(0,0,0,0)); d=ImageDraw.Draw(ov)
    maxw=PANEL_X1-PANEL_X0-140
    for f in (F_CAP,F_CAP2,F_CAP3):
        lines=wrap(d,text,f,maxw)
        if len(lines)<=4: break
    lh=int(f.size*1.32); th=len(lines)*lh
    plate_h=th+170
    y0=(H-plate_h)//2+20
    d.rounded_rectangle([PANEL_X0,y0,PANEL_X1,y0+plate_h],radius=30,fill=(4,20,10,215),outline=(245,183,10,120),width=2)
    d.rounded_rectangle([PANEL_X0+60,y0-32,PANEL_X0+60+d.textlength(LABELS[label],font=F_LAB)+44,y0+34],radius=30,fill=GOLD+(255,))
    d.text((PANEL_X0+82,y0-22),LABELS[label],font=F_LAB,fill=(10,40,20,255))
    y=y0+66
    for ln in lines:
        d.text((PANEL_X0+60,y),ln,font=f,fill=(255,255,255,255))
        y+=lh
    return ov

def end_card():
    card=BG.copy(); d=ImageDraw.Draw(card)
    d.ellipse([W/2-104,116,W/2+104,324],outline=GOLD,width=8)
    d.text((W/2-d.textlength("P",font=F_TITLE)/2,158),"P",font=F_TITLE,fill=GOLD)
    t1="PRIME SCHOLARS"
    d.text(((W-d.textlength(t1,font=F_TITLE))//2,368),t1,font=F_TITLE,fill=CREAM)
    t2="LEARNING TECHNOLOGIES"
    d.text(((W-d.textlength(t2,font=F_SUB))//2,486),t2,font=F_SUB,fill=GOLD)
    d.line([W/2-260,568,W/2+260,568],fill=(255,255,255,90),width=3)
    t3="Pass your exam, the smart way."
    d.text(((W-d.textlength(t3,font=F_SUB))//2,600),t3,font=F_SUB,fill=(255,255,255,255))
    t4="Install the app today"
    d.text(((W-d.textlength(t4,font=F_LAB))//2,706),t4,font=F_LAB,fill=GOLD)
    t5="prime-scholars-lt.successeverydayww-cpu.workers.dev"
    d.text(((W-d.textlength(t5,font=F_LAB))//2,756),t5,font=F_LAB,fill=(230,230,220,255))
    return card.convert('RGB')
END=end_card()

shots_cache={}
def get_shot(name):
    if name not in shots_cache: shots_cache[name]=load_shot(name)
    return shots_cache[name]

def rounded_mask(w,h,rad):
    m=Image.new('L',(w,h),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,w-1,h-1],radius=rad,fill=255)
    return m

def frame_at(t):
    sl=None
    for s in slots:
        if s['start']<=t<s['start']+s['dur']: sl=s; break
    if sl is None: sl=slots[-1]
    local=t-sl['start']; prog=min(1,local/sl['dur'])
    frame=BG.copy()
    if sl['label']=='close' and local>sl['dur']-2.6:
        card_t=(local-(sl['dur']-2.6))/2.6
        frame=Image.blend(frame,END,min(1,card_t*1.5))
    else:
        names=sl['shots']
        idx=min(int(prog*len(names)),len(names)-1)
        im=get_shot(names[idx])
        z=1.0+0.09*prog
        zw,zh=int(im.width*z),int(im.height*z)
        cx,cy=im.width/2,im.height*0.40
        x0=min(max(cx-zw/2,0),max(im.width-zw,0)); y0=min(max(cy-zh/2,0),max(im.height-zh,0))
        crop=im.crop((int(x0),int(y0),int(x0)+zw,int(y0)+zh))
        ph=PHONE_H; pw=crop.width*ph//crop.height
        cim=crop.resize((pw,ph),Image.BILINEAR)
        rise=int(14*prog)
        px=PHONE_X; py=50-rise
        # shadow
        sh=Image.new('RGBA',(pw+120,ph+120),(0,0,0,0))
        ImageDraw.Draw(sh).rounded_rectangle([60,60,pw+60,ph+60],radius=34,fill=(0,0,0,150))
        sh=sh.filter(ImageFilter.GaussianBlur(34))
        frame.paste(sh,(px-60,py-50),sh)
        cmask=rounded_mask(pw,ph,32)
        frame.paste(cim,(px,py),cmask)
        ImageDraw.Draw(frame).rounded_rectangle([px-5,py-5,px+pw+5,py+ph+5],radius=34,outline=GOLD,width=5)
        if sl['label'] not in cap_cache: cap_cache[sl['label']]=caption_overlay(sl['text'],sl['label'])
        ov=cap_cache[sl['label']]
        a=0.0
        if t>=sl['voice_at']-0.3: a=min(1,(t-(sl['voice_at']-0.3))/0.4)
        if sl['label']=='close' and local>sl['dur']-2.6:
            a*=max(0,1-(local-(sl['dur']-2.6))/0.8)
        if a>0.01:
            if a<1:
                r_,g_,b_,al=ov.split(); al=al.point(lambda p:int(p*a))
                ov=Image.merge('RGBA',(r_,g_,b_,al))
            frame=Image.alpha_composite(frame.convert('RGBA'),ov).convert('RGB')
    d=ImageDraw.Draw(frame)
    d.text((PHONE_X+8,14),"PRIME SCHOLARS LT",font=F_BRAND,fill=(255,236,160))
    d.rectangle([0,0,W,8],fill=(30,60,40))
    d.rectangle([0,0,int(W*t/TOTAL),8],fill=GOLD)
    return frame

out="promo/prime_scholars_promo_90s.mp4"
cmd=['ffmpeg','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-',
     '-i','promo/mix.wav','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p',
     '-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart',out]
proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=subprocess.DEVNULL)
NF=int(TOTAL*FPS)
t0=time.time()
for f in range(NF):
    fr=frame_at(f/FPS)
    proc.stdin.write(fr.tobytes())
    if f%450==0: print('frame',f,'/',NF,int(time.time()-t0),'s',flush=True)
proc.stdin.close(); proc.wait()
print("RENDER DONE rc=",proc.returncode,flush=True)
