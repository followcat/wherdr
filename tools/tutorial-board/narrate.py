"""Synthesize each shot's narration with Matilda, then shorten its pauses.

The untouched take is kept as <id>.raw.wav; <id>.wav is the edited take that alignment
and rendering use. The voice's speed and pitch are never changed.
"""
import array,json,os,pathlib,re,urllib.request,urllib.error,wave
from timing import tighten
root=pathlib.Path(os.environ['TUTORIAL_OUT'])
plan=json.loads((root/'storyboard.json').read_text())
for shot in plan['segments']:
 raw=root/(shot['id']+'.raw.wav')
 if not raw.exists():
  req=urllib.request.Request('https://openrouter.ai/api/v1/audio/speech',data=json.dumps({'model':plan['model'],'voice':plan['voice'],'input':shot['narration'],'response_format':'pcm'}).encode(),headers={'Authorization':'Bearer '+os.environ['OPENROUTER_API_KEY'],'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=120) as r:
    ct=r.headers.get('Content-Type','');pcm=r.read()
  except urllib.error.HTTPError as e:
   print('HTTP',e.code,'stopped without retry');raise SystemExit(1)
  assert 'audio/pcm' in ct and len(pcm)%2==0
  match=re.search(r'rate=(\d+)',ct);rate=int(match.group(1)) if match else 24000
  with wave.open(str(raw),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(pcm)
 with wave.open(str(raw),'rb') as w:
  rate=w.getframerate();samples=array.array('h',w.readframes(w.getnframes()))
 edited=array.array('h',tighten(samples,rate,gap=plan.get('pause',.22)))
 with wave.open(str(root/(shot['id']+'.wav')),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(rate);w.writeframes(edited.tobytes())
 print(shot['id'],round(len(samples)/rate,2),'->',round(len(edited)/rate,2),'seconds',flush=True)
