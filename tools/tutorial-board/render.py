"""Compose the tutorial frame by frame from verified UI captures.

Every frame is drawn here: the capture, the tutorial marks, the macOS-style pointer and
the header. FFmpeg then burns the captions and encodes. Actions in storyboard.json are
tied to spoken words, so the pointer moves and marks appear as the narration names them.
Environment: TUTORIAL_OUT (artifact folder), TUTORIAL_STILLS="12.5,30" writes PNG stills
at those seconds instead of the film, TUTORIAL_MARK overrides the mark style.
"""
import array, bisect, hashlib, json, math, os, pathlib, re, subprocess, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from timing import plan_frames
from fontpin import ensure_fonts

root = pathlib.Path(os.environ['TUTORIAL_OUT']).resolve(); os.chdir(root)
plan = json.loads((root / 'storyboard.json').read_text())
provenance = json.loads((root / 'capture.json').read_text())
for frame in provenance['frames']:
    assert hashlib.sha256((root / (frame['id'] + '.png')).read_bytes()).hexdigest() == frame['sha256']
fonts = ensure_fonts()  # pinned google/fonts commit, SHA-256 verified (fonts.json)
assert "'" not in str(fonts), 'the fonts folder path must not contain a quote (FFmpeg filter)'

FPS, W, H = 60, 1920, 1080
SCALE, OX, OY = .9, 96, 54                     # the UI sits in a 1728×972 inset
SW, SH = round(1920 * SCALE), round(1080 * SCALE)
BG, RULE, ACCENT = (18, 21, 27), (82, 96, 109), (52, 179, 235)
# Tutorial marks use a colour the app never uses, with rounded corners the app never has.
MARK = tuple(int(plan.get('mark_color', '#ffd23f')[i:i + 2], 16) for i in (1, 3, 5))
STYLE = os.environ.get('TUTORIAL_MARK', plan.get('mark', 'spotlight'))
LEAD, TAIL = plan.get('lead_in', .12), plan.get('tail', .3)

def font(family, size, weight):
    f = ImageFont.truetype(str(fonts / (family + '.ttf')), size)
    axes = f.get_variation_axes()
    f.set_variation_by_axes([weight if a['name'] in (b'Weight', 'Weight') else min(max(100, a['minimum']), a['maximum']) for a in axes])
    return f

screens = {f['id']: f for f in provenance['frames']}
cache = {}
def screen(id):
    if id not in cache:
        cache[id] = np.asarray(Image.open(root / (id + '.png')).convert('RGB').resize((SW, SH), Image.LANCZOS))
    return cache[id]
def place(box, pad=0):
    return (OX + box['x'] * SCALE - pad, OY + box['y'] * SCALE - pad,
            OX + (box['x'] + box['width']) * SCALE + pad, OY + (box['y'] + box['height']) * SCALE + pad)

# --- Timeline from the measured narration -------------------------------------------
shots = plan['segments']; spoken = []; takes = []
for shot in shots:
    with wave.open(str(root / (shot['id'] + '.wav')), 'rb') as w:
        rate = w.getframerate(); samples = array.array('h', w.readframes(w.getnframes()))
    takes.append(samples); spoken.append(len(samples) / rate)
counts = plan_frames(spoken, fps=FPS, total=None, pad=LEAD + TAIL)
alignment = json.loads((root / 'alignment.json').read_text())
starts = [sum(counts[:i]) / FPS for i in range(len(counts))]
total = sum(counts) / FPS

def anchor(i, word):
    """Global time at which shot i's narration starts saying `word` (exact spelling)."""
    if isinstance(word, (int, float)):
        return starts[i] + LEAD + word
    for phrase in alignment[shots[i]['id']]:
        for w in phrase['words']:
            if re.sub(r'[^\w-]', '', w['text']) == word:
                return starts[i] + LEAD + w['start']
    raise ValueError(f"{shots[i]['id']}: the narration never says {word!r}")

switches = [(0, shots[0]['screen'])]          # (time, screen id)
def screen_at(t):
    return [s for at, s in switches if at <= t][-1]
moves, marks = [], []                         # pointer moves and tutorial marks
pointer = (OX + 1380 * SCALE, OY + 760 * SCALE)
for i, shot in enumerate(shots):
    if shot.get('screen'):
        switches.append((starts[i], shot['screen'])); switches.sort()
    for action in shot.get('cursor', []):
        t0 = anchor(i, action['at'])
        box = screens[screen_at(t0)]['targets'][action['to']]
        x0, y0, x1, y1 = place(box)
        target = (x0 + min((x1 - x0) / 2, 100), (y0 + y1) / 2)
        distance = math.dist(pointer, target)
        # Fitts-like duration: long moves take longer, but never feel slow.
        duration = min(1.0, max(.5, .32 + .11 * math.log2(1 + distance / max(12, min(x1 - x0, y1 - y0)))))
        click = t0 + duration + .12
        moves.append(dict(start=t0, end=t0 + duration, click=click, a=pointer, b=target))
        switches.append((click + .1, action['then'])); switches.sort()
        pointer = target
    for mark in shot.get('marks', []):
        start = anchor(i, mark['at']) - .05
        end = anchor(i, mark['until']) - .05 if 'until' in mark else starts[i] + counts[i] / FPS
        box = screens[screen_at(start)]['targets'][mark['on']]
        x0, y0, x1, y1 = place(box, mark.get('pad', 8))
        x0, y0, x1, y1 = max(OX + 3, x0), max(OY + 3, y0), min(OX + SW - 3, x1), min(OY + SH - 3, y1)
        marks.append(dict(start=start, end=end, rect=(x0, y0, x1, y1), on=mark['on'], shot=shot['id']))
card = next(starts[i] + LEAD for i, s in enumerate(shots) if s.get('card'))

def ease(u):                                  # minimum-jerk profile: no abrupt start or stop
    u = min(1, max(0, u)); return u * u * u * (10 - 15 * u + 6 * u * u)
def ramp(t, start, end, rise=.25, fall=.2):
    return min(1, max(0, (t - start) / rise), max(0, (end + fall - t) / fall)) if start <= t <= end + fall else 0

def pointer_at(t):
    if not moves or t < moves[0]['start'] - .3:
        return None
    position = moves[0]['a']
    for m in moves:
        if t >= m['end']:
            position = m['b']
        elif t >= m['start']:
            (ax, ay), (bx, by) = m['a'], m['b']
            u = ease((t - m['start']) / (m['end'] - m['start']))
            # A gentle arc, as a wrist draws it, instead of a ruler-straight line.
            bend = .12 * math.dist(m['a'], m['b'])
            cx, cy = (ax + bx) / 2 - (by - ay) / max(1, math.dist(m['a'], m['b'])) * bend, (ay + by) / 2 + (bx - ax) / max(1, math.dist(m['a'], m['b'])) * bend
            position = ((1 - u) ** 2 * ax + 2 * (1 - u) * u * cx + u * u * bx, (1 - u) ** 2 * ay + 2 * (1 - u) * u * cy + u * u * by)
            break
    # Like a screen recorder's "hide when idle": the pointer leaves the marks unobstructed
    # a moment after each click and returns, where it was, just before the next move.
    alpha = min(1, (t - moves[0]['start'] + .3) / .3, max(0, (card + .3 - t) / .3))
    last = max((m for m in moves if m['click'] <= t), key=lambda m: m['click'], default=None)
    upcoming = next((m for m in moves if m['click'] > t), None)   # includes the move in progress
    if last:
        hidden = min(1, max(0, (t - last['click'] - 1.0) / .3))
        if upcoming: hidden = min(hidden, max(0, (upcoming['start'] - t) / .3))
        alpha *= 1 - hidden
    return (position, alpha) if alpha > 0 else None

# Every move must be seen from start to click, fully opaque from its first third.
for m in moves:
    for u in (.34, .5, .9, 1):
        seen = pointer_at(m['start'] + u * (m['click'] - m['start']))
        assert seen and seen[1] == 1, f"pointer hidden during the move at {m['start']:.2f} s"

# --- Drawing ---------------------------------------------------------------------------
Q = 4                                          # supersampling for the pointer
def make_pointer():
    pt = 1.45 * Q                              # pixels per point, macOS arrow proportions
    arrow = [(0, 0), (0, 15.6), (3.7, 12.1), (6.2, 17.9), (8.6, 16.9), (6.1, 11.2), (11.1, 11.2)]
    size = (int(18 * pt), int(24 * pt)); off = 2.5 * pt
    shape = [(off + x * pt, off + y * pt) for x, y in arrow]
    shadow = Image.new('L', size); ImageDraw.Draw(shadow).polygon([(x + .5 * pt, y + 1.1 * pt) for x, y in shape], fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(1.6 * pt))
    sprite = Image.new('RGBA', size, (0, 0, 0, 0)); sprite.putalpha(shadow)
    draw = ImageDraw.Draw(sprite)
    draw.polygon(shape, fill='white', outline='white', width=round(2.9 * pt))
    draw.line(shape + [shape[0]], fill='white', width=round(2.9 * pt), joint='curve')
    draw.polygon(shape, fill=(10, 10, 12, 255))
    return sprite, off
sprite, hotspot = make_pointer()
sprites = {}
def pointer_sprite(fx, fy, scale):
    key = (round(fx * Q) % Q, round(fy * Q) % Q, scale)
    if key not in sprites:
        s = sprite if scale == 1 else sprite.resize((round(sprite.width * scale), round(sprite.height * scale)), Image.LANCZOS)
        canvas = Image.new('RGBA', (s.width + Q, s.height + Q), (0, 0, 0, 0)); canvas.paste(s, key[:2])
        sprites[key] = canvas.reduce(Q)
    return sprites[key]

def perimeter(rect, radius, steps=240):
    """Points around a rounded rectangle, clockwise from the top-left corner's end."""
    x0, y0, x1, y1 = rect; r = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    corners = [((x1 - r, y0 + r), -90), ((x1 - r, y1 - r), 0), ((x0 + r, y1 - r), 90), ((x0 + r, y0 + r), 180)]
    points = []
    for (cx, cy), a in corners:
        for k in range(13):
            angle = math.radians(a + 90 * k / 12); points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    points.append(points[0])
    lengths = [0]
    for p, q in zip(points, points[1:]): lengths.append(lengths[-1] + math.dist(p, q))
    out = []
    for k in range(steps + 1):
        d = lengths[-1] * k / steps; j = min(len(lengths) - 2, max(0, bisect.bisect_left(lengths, d) - 1))
        u = (d - lengths[j]) / max(1e-9, lengths[j + 1] - lengths[j]); p, q = points[j], points[j + 1]
        out.append((p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u))
    return out

def draw_mark(frame, mark, progress, alpha):
    x0, y0, x1, y1 = mark['rect']; m = 8
    left, top = int(x0 - m), int(y0 - m); width, height = int(x1 - x0 + 2 * m) + 2, int(y1 - y0 + 2 * m) + 2
    path = perimeter((x0 - left, y0 - top, x1 - left, y1 - top), 10)
    if STYLE == 'marker':                      # a loose hand-drawn loop that overshoots its start
        seed = sum(map(ord, mark['on']))
        path = [(x + 1.4 * math.sin(k / 23 + seed), y + 1.4 * math.cos(k / 29 + seed)) for k, (x, y) in enumerate(path)]
        path += [(x + 3 * k / 18, y - 2 * k / 18) for k, (x, y) in enumerate(path[1:19])]
    shown = path[:max(2, round(len(path) * progress))]
    layer = Image.new('RGBA', (width * 2, height * 2), (0, 0, 0, 0)); draw = ImageDraw.Draw(layer)
    scaled = [(x * 2, y * 2) for x, y in shown]
    if STYLE != 'marker':                      # dark keyline keeps the mark readable on any UI
        draw.line(scaled, fill=(8, 9, 12, 150), width=10, joint='curve')
    draw.line(scaled, fill=MARK + (255,), width=5 if STYLE != 'marker' else 6, joint='curve')
    layer = layer.resize((width, height), Image.LANCZOS)
    region = frame[top:top + height, left:left + width]
    a = np.asarray(layer).astype(np.float32); k = a[..., 3:] / 255 * alpha
    region[:] = (region * (1 - k) + a[..., :3] * k).astype(np.uint8)

def spotlight(frame, active):
    """Dim the UI around the marked elements, so the mark reads as tutorial, not app."""
    level = max(a for _, _, a in active) * .45
    if level <= 0: return frame
    hole = Image.new('L', (SW, SH)); draw = ImageDraw.Draw(hole)
    for mark, _, a in active:
        x0, y0, x1, y1 = mark['rect']; draw.rounded_rectangle((x0 - OX, y0 - OY, x1 - OX, y1 - OY), 10, fill=round(255 * a))
    k = 1 - level * (1 - np.asarray(hole.filter(ImageFilter.GaussianBlur(1.2)), np.float32)[..., None] / 255)
    inset = frame[OY:OY + SH, OX:OX + SW]; inset[:] = (inset * k).astype(np.uint8)
    return frame

mono, title_font = font('jetbrainsmono', 19, 500), font('archivo', 23, 600)
def header(shot):
    image = Image.new('RGB', (W, OY), BG); draw = ImageDraw.Draw(image)
    draw.text((OX, 17), plan.get('label', 'WHERDR / BOARD / 01'), font=mono, fill=(154, 168, 181))
    draw.text((W - OX, 15), shot['title'], font=title_font, fill='white', anchor='ra')
    return np.asarray(image)
headers = [header(s) for s in shots]
end_title, end_label = font('archivo', 88, 700), font('jetbrainsmono', 22, 500)
def end_card():
    image = Image.new('RGB', (SW, SH), BG); draw = ImageDraw.Draw(image)
    draw.text((SW / 2, SH / 2 - 70), 'WHERDR', font=end_label, fill=(154, 168, 181), anchor='mm')
    draw.text((SW / 2, SH / 2), shots[-1]['card'], font=end_title, fill='white', anchor='mm')
    draw.rectangle((SW / 2 - 100, SH / 2 + 66, SW / 2 + 100, SH / 2 + 68), fill=ACCENT)
    draw.text((SW / 2, SH / 2 + 112), plan.get('end_label', 'FOR HERDR AND HERDR-PROJECTS'), font=end_label, fill=(154, 168, 181), anchor='mm')
    return np.asarray(image)
ending = end_card()

def compose(t):
    frame = np.empty((H, W, 3), np.uint8); frame[:] = BG
    i = max(k for k in range(len(shots)) if starts[k] <= t + 1e-9)
    frame[:OY] = headers[i]
    if t - starts[i] < .25 and i:             # titles cross-fade at each new shot
        u = (t - starts[i]) / .25; frame[:OY] = (headers[i - 1] * (1 - u) + headers[i] * u).astype(np.uint8)
    current = screen_at(t); inset = screen(current)
    changed = [at for at, s in switches if at <= t][-1]
    if changed > 0 and t - changed < .12:      # the UI's response to a click, softened over 7 frames
        u = (t - changed) / .12; inset = (screen(screen_at(changed - 1e-6)) * (1 - u) + inset * u).astype(np.uint8)
    frame[OY:OY + SH, OX:OX + SW] = inset
    active = [(m, min(1, (t - m['start']) / .35), ramp(t, m['start'], m['end'])) for m in marks if m['start'] <= t <= m['end'] + .2]
    if active and STYLE == 'spotlight':
        frame = spotlight(frame, active)
    for mark, progress, alpha in active:
        draw_mark(frame, mark, ease(progress), alpha)
    if t >= card:                              # the end card settles over the last frame
        u = ease((t - card) / .5); region = frame[OY:OY + SH, OX:OX + SW]
        region[:] = (region * (1 - u) + ending * u).astype(np.uint8)
    seen = pointer_at(t)
    if seen:
        (px, py), alpha = seen
        press = next((m for m in moves if m['click'] <= t < m['click'] + .35), None)
        scale = .9 if press and t < press['click'] + .09 else 1
        if press:                              # a small, quick ring marks the click
            u = (t - press['click']) / .35; ring = Image.new('RGBA', (80, 80), (0, 0, 0, 0))
            ImageDraw.Draw(ring).ellipse((40 - 6 - 24 * u, 40 - 6 - 24 * u, 40 + 6 + 24 * u, 40 + 6 + 24 * u), outline=MARK + (round(200 * (1 - u)),), width=3)
            cx, cy = press['b']; region = frame[int(cy) - 40:int(cy) + 40, int(cx) - 40:int(cx) + 40]
            a = np.asarray(ring, np.float32); k = a[..., 3:] / 255
            region[:] = (region * (1 - k) + a[..., :3] * k).astype(np.uint8)
        left, top = px - hotspot / Q * scale, py - hotspot / Q * scale
        image = pointer_sprite(left % 1, top % 1, scale); x, y = int(left), int(top)
        a = np.asarray(image, np.float32); k = a[..., 3:] / 255 * alpha
        region = frame[y:y + image.height, x:x + image.width]
        region[:] = (region * (1 - k[:region.shape[0], :region.shape[1]]) + a[:region.shape[0], :region.shape[1], :3] * k[:region.shape[0], :region.shape[1]]).astype(np.uint8)
    frame[OY - 1, OX - 1:OX + SW + 1] = RULE; frame[OY + SH, OX - 1:OX + SW + 1] = RULE
    frame[OY:OY + SH, OX - 1] = RULE; frame[OY:OY + SH, OX + SW] = RULE
    return frame

if os.environ.get('TUTORIAL_STILLS'):
    for value in os.environ['TUTORIAL_STILLS'].split(','):
        Image.fromarray(compose(float(value))).save(root / f'still-{STYLE}-{value}.png')
    raise SystemExit

# --- Captions, audio, film -------------------------------------------------------------
def ass_time(seconds):
    ticks = round(seconds * 100); return f'{ticks // 360000}:{ticks // 6000 % 60:02}:{ticks // 100 % 60:02}.{ticks % 100:02}'
events = []
for i, shot in enumerate(shots):
    for phrase in alignment[shot['id']]:
        events.append([starts[i] + LEAD + phrase['start'], starts[i] + LEAD + phrase['end'], phrase['text']])
for a, b in zip(events, events[1:]):          # no flicker between phrases; short hold after
    a[1] = b[0] if b[0] - a[1] < .4 else a[1] + .25
events[-1][1] = min(events[-1][1] + .25, total)
style = 'Style: Default,Inter,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H3C0B0D11,0,0,0,0,100,100,0,0,3,14,0,2,200,200,84,1'
(root / 'captions.ass').write_text('[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n'
    + style + '\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'
    + ''.join(f'Dialogue: 0,{ass_time(a)},{ass_time(b)},Default,,0,0,0,,{text}\n' for a, b, text in events))
track = np.zeros(sum(counts) * rate // FPS, np.float32)
for i, samples in enumerate(takes):
    voice = np.asarray(samples, np.float32)
    # Constant gain to a common loudness with peak headroom; no dynamic filter shifts timing.
    gain = min(.84 * 32768 / np.abs(voice).max(), 32768 * 10 ** (-19 / 20) / math.sqrt(float(np.mean(voice ** 2))))
    at = round((starts[i] + LEAD) * rate); track[at:at + len(voice)] = voice * gain
with wave.open(str(root / 'narration.wav'), 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(np.clip(track, -32767, 32767).astype('<i2').tobytes())
encoder = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
    '-i', 'narration.wav', '-vf', f"ass=captions.ass:fontsdir='{fonts}',format=yuv420p", '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-threads', '2',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', plan.get('output', 'wherdr-board-tutorial.mp4')], stdin=subprocess.PIPE)
for n in range(sum(counts)):
    encoder.stdin.write(compose(n / FPS).tobytes())
    if n % 600 == 0: print('frame', n, flush=True)
encoder.stdin.close(); assert encoder.wait() == 0
manifest = [dict(id=s['id'], start=round(starts[i], 4), duration=counts[i] / FPS, narration_start=round(starts[i] + LEAD, 4),
                 narration_duration=spoken[i], captions=alignment[s['id']]) for i, s in enumerate(shots)]
(root / 'timeline.json').write_text(json.dumps(dict(duration=total, fps=FPS, width=W, height=H, frames=sum(counts), shots=manifest,
    moves=[dict(start=round(m['start'], 3), click=round(m['click'], 3)) for m in moves],
    marks=[dict(on=m['on'], start=round(m['start'], 3), end=round(m['end'], 3)) for m in marks]), indent=2))
print(f'Rendered private tutorial: {total:.2f} s, {sum(counts)} frames.', flush=True)
