"""Derive phrase captions from the original WAVs using local word timestamps.

Install faster-whisper in an isolated environment. Models and cache stay in TUTORIAL_OUT.
Inspect alignment.json against the audio before rendering; never estimate by word count.
"""
import json, os, pathlib, subprocess
import numpy as np
from faster_whisper import WhisperModel
from timing import map_words, phrase_captions
root = pathlib.Path(os.environ['TUTORIAL_OUT'])
model = WhisperModel('small.en', device='cpu', compute_type='int8', cpu_threads=2,
                     download_root=str(root / 'models'))
result = {}
plan = json.loads((root / 'storyboard.json').read_text())
for shot in plan['segments']:
    pcm = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(root / (shot['id'] + '.wav')), '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'])
    segments, _ = model.transcribe(np.frombuffer(pcm, dtype=np.float32),
                                   word_timestamps=True, beam_size=5,
                                   initial_prompt='where-der, herder-projects, Herder. Board. Needs you.')
    words = [dict(text=w.word.strip(), start=round(w.start, 3), end=round(w.end, 3))
             for segment in segments for w in segment.words]
    # Captions keep the written spelling (wherdr, herdr-projects) on the measured times.
    result[shot['id']] = phrase_captions(map_words(shot['caption'], words, plan.get('spoken')))
    (root / 'alignment.json').write_text(json.dumps(result, indent=2))
    print(shot['id'], result[shot['id']], flush=True)
