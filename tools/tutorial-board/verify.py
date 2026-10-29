"""Check the actual encoded artifact, its provenance and narration timing."""
import array,hashlib,json,math,os,pathlib,subprocess
root=pathlib.Path(os.environ['TUTORIAL_OUT'])
plan=json.loads((root/'storyboard.json').read_text());movie=root/plan.get('output','wherdr-board-tutorial.mp4')
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(movie)]))
video=next(s for s in probe['streams'] if s['codec_type']=='video')
audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
assert (video['codec_name'],video['width'],video['height'],video['pix_fmt'])==('h264',1920,1080,'yuv420p')
timeline=json.loads((root/'timeline.json').read_text());count=timeline['frames']
assert video['r_frame_rate']=='60/1' and int(video['nb_frames'])==count
assert 50<=timeline['duration']<=66, 'Keep the film about one minute'
assert abs(float(probe['format']['duration'])-timeline['duration'])<.1 and audio['codec_name']=='aac'
data=movie.read_bytes();assert data.index(b'moov')<data.index(b'mdat'), 'Missing fast-start metadata'
assert plan['voice']=='matilda' and plan['pronunciation']=='where-der'
end=0
for shot in timeline['shots']:
    assert abs(shot['start']-end)<.002
    assert shot['narration_start']+shot['narration_duration']<=shot['start']+shot['duration']
    end=shot['start']+shot['duration']
assert abs(end-timeline['duration'])<.002
capture=json.loads((root/'capture.json').read_text());assert capture['session'].startswith('hwtest')
for frame in capture['frames']:
    assert hashlib.sha256((root/(frame['id']+'.png')).read_bytes()).hexdigest()==frame['sha256']
subprocess.run(['ffmpeg','-v','error','-i',str(movie),'-f','null','-'],check=True)
pcm=subprocess.check_output(['ffmpeg','-v','error','-i',str(movie),'-vn','-ar','16000','-f','s16le','-'])
samples=array.array('h',pcm);rms=math.sqrt(sum(x*x for x in samples)/len(samples))
assert 20*math.log10(rms/32768)>-30, 'Missing or inaudible narration'
assert max(abs(x) for x in samples)<32767, 'Clipped audio'
print(json.dumps({'pass':True,'duration':probe['format']['duration'],'frames':count,'size':len(data),'codec':'H.264/AAC','capture':'isolated hwtest session','rms_dbfs':round(20*math.log10(rms/32768),1)},indent=2))

# Validate the presentation timestamp of every encoded frame, not just its header.
frames=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
    '-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',str(movie)]))['frames']
assert len(frames)==count
assert all(abs(float(frame['best_effort_timestamp_time'])-i/60)<.000002 for i,frame in enumerate(frames))
for shot in timeline['shots']:
    previous=0
    for event in shot['captions']:
        assert previous <= event['start'] < event['end'] <= shot['narration_duration']+.1
        previous=event['end']
words=sum(len(e['text'].split()) for s in timeline['shots'] for e in s['captions'])
pace=words/timeline['duration']*60
assert 150<=pace<=175, f'Narration pace {pace:.0f} words/min is outside the brief'
print(f'All {count} frame timestamps and measured caption intervals verified; pace {pace:.0f} words/min.')

# Check muxed-audio placement against the original WAV waveform. This also catches
# an encoder delay or an accidental shift that a source-only alignment would miss.
for shot in timeline['shots']:
    raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(root/(shot['id']+'.wav')),
        '-ar','16000','-ac','1','-f','s16le','-'])
    original=array.array('h',raw)[4000:12000]
    energy=sum(x*x for x in original)
    expected=round(shot['narration_start']*16000)+4000
    scores=[]
    for shift in range(-160,161):
        candidate=samples[expected+shift:expected+shift+len(original)]
        norm=math.sqrt(energy*sum(x*x for x in candidate))
        scores.append((sum(a*b for a,b in zip(original,candidate))/norm,shift))
    correlation,shift=max(scores)
    assert correlation>.9 and abs(shift)<=160, 'Encoded narration is not aligned to the original WAV'
    print(shot['id'], 'waveform correlation', round(correlation,3), 'offset_ms', shift/16)
