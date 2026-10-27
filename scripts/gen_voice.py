import json, os
import numpy as np, soundfile as sf
from piper import PiperVoice
from piper import SynthesisConfig
CFG=SynthesisConfig(length_scale=1.14)

v=PiperVoice.load("piper/en_US-ryan-high.onnx")
SR=22050

def tts(text,out):
    chunks=list(v.synthesize(text, syn_config=CFG))
    a=np.concatenate([np.asarray(c.audio_int16_array).ravel() for c in chunks]).astype(np.float32)/32768
    sr=chunks[0].sample_rate
    if sr!=SR:
        g=np.arange(len(a))*SR/sr
        a=np.interp(g,np.arange(len(a)),a)
    sf.write(out,a,SR)
    return len(a)/SR

SECTIONS=[
 ("intro",   ["01_landing"],
  "Meet Prime Scholars. The complete exam practice app, built for Nigerian students."),
 ("signup",  ["02_signup"],
  "Create your free account in seconds, and step right in."),
 ("home",    ["03_home"],
  "JAMB, WAEC, NECO and Post-UTME are all on your home screen, with the JAMB countdown always in view."),
 ("subjects",["04_subj"],
  "Choose any subject, from Mathematics to English, and practice chapter by chapter."),
 ("setup",   ["05_mode","06_count"],
  "Practice at your own pace, or take a timed CBT test. You choose the number of questions."),
 ("quiz",    ["07_quiz","08_breakdown"],
  "Real exam-standard questions, with instant marking, and a full explanation for every answer."),
 ("calc",    ["09_calc"],
  "And a JAMB-style calculator is built right in."),
 ("agent",   ["10_agent"],
  "Stuck on a question? Just ask the Prime Scholars Agent, and keep learning without leaving the app."),
 ("progress",["11_done","12_progress"],
  "Every session is scored. Watch your accuracy and your streak grow, day by day."),
 ("novel",   ["14_novel"],
  "The Lekki Headmaster guide is built in, with chapter summaries and practice questions."),
 ("tools",   ["15_search","16_updates"],
  "Search the whole question bank, bookmark tricky questions, and get verified updates from your school."),
 ("close",   ["17_subs"],
  "All of this, for two thousand naira for three months, or eight thousand for lifetime access. Prime Scholars. Pass your exam, the smart way."),
]

os.makedirs("voice",exist_ok=True)
info=[]
for i,(label,shots,text) in enumerate(SECTIONS):
    d=tts(text,f"voice/{i:02d}_{label}.wav")
    info.append({"i":i,"label":label,"shots":shots,"text":text,"voice_dur":round(d,2)})
    print(label,round(d,2),flush=True)

speech=sum(x['voice_dur'] for x in info)
print("speech total:",round(speech,1),"s; with gaps:",round(speech+1.0*len(info),1),"s")
json.dump(info,open("voice/sections.json","w"),indent=1)
