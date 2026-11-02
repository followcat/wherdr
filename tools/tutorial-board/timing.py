"""Frame-accurate shot timing with room for the narration lead-in."""
import math

def plan_frames(durations, fps=30, total=60, pad=.42):
    if not durations or any(not math.isfinite(d) or d <= 0 for d in durations):
        raise ValueError('Narration durations must be finite and positive')
    if total is None:  # paced by the narration: each shot is its take plus `pad` seconds
        return [math.ceil((duration + pad) * fps) for duration in durations]
    padding = (total - sum(durations)) / len(durations)
    if padding < .75:
        raise ValueError('Shorten the narration; do not speed up the selected voice')
    frames = [round((duration + padding) * fps) for duration in durations]
    frames[-1] += round(total * fps) - sum(frames)
    return frames


def phrase_captions(words, limit=50):
    """Keep measured word boundaries while breaking captions at readable phrases."""
    import re
    phrases, pending = [], []
    for word in words:
        if word['end'] < word['start']:
            raise ValueError('Word timestamps must have nonnegative duration')
        if pending and len(' '.join(w['text'] for w in pending + [word])) > limit:
            phrases.append(pending)
            pending = []
        pending.append(word)
        text = ' '.join(w['text'] for w in pending)
        if re.search(r'[.!?]$', text) or (len(text) >= 20 and re.search(r'[,;:]$', text)):
            phrases.append(pending)
            pending = []
    if pending:
        phrases.append(pending)
    # Avoid an orphan word caused by the character limit, preserving every timestamp.
    for i in range(1, len(phrases)):
        before, after = phrases[i-1], phrases[i]
        while (len(' '.join(w['text'] for w in after)) < 18 and len(before) > 4
               and not re.search(r'[.!?]$', before[-1]['text'])):
            after.insert(0, before.pop())
    return [dict(start=p[0]['start'], end=p[-1]['end'],
                 text=' '.join(w['text'] for w in p), words=p) for p in phrases]


def tighten(samples, rate, gap=.22, edge=.04, floor=-45):
    """Shorten silent pauses to `gap` seconds and trim the ends to `edge`.

    Only runs below `floor` dBFS are cut, so speech itself, its pitch and its speed are
    untouched: this is the editing a narrator's take gets, not a time stretch.
    """
    window = max(1, rate // 100)
    limit = 32768 * 10 ** (floor / 20)
    quiet = []
    for i in range(0, len(samples), window):
        chunk = samples[i:i + window]
        quiet.append(math.sqrt(sum(x * x for x in chunk) / len(chunk)) < limit)
    keep, i = [], 0
    while i < len(quiet):
        j = i
        while j < len(quiet) and quiet[j] == quiet[i]:
            j += 1
        start, end = i * window, min(j * window, len(samples))
        if quiet[i]:
            room = round((edge if i == 0 or j == len(quiet) else gap) * rate)
            if end - start > room:
                # Keep both sides of the pause so word tails and breaths stay natural.
                half = room // 2
                keep.append((start, start + half))
                keep.append((end - (room - half), end))
                i = j
                continue
        keep.append((start, end))
        i = j
    return [x for a, b in keep for x in samples[a:b]]


def map_words(caption, spoken, written=None):
    """Give each written caption word the measured time of the matching spoken word.

    `spoken` comes from speech recognition and may spell names as they sound
    ("where-der", "herder projects"). `written` maps those sounds to the caption
    spelling. Unmatched written words take the span of the spoken words they replace.
    """
    import difflib, re
    written = written or {}
    def norm(text):
        text = re.sub(r"[^\w'-]", '', text.lower())
        return written.get(text, text)
    tokens = caption.split()
    heard = [norm(w['text']) for w in spoken]
    # A hyphenated caption word ("herdr-projects") is often heard as two words.
    flat, owner = [], []
    for i, token in enumerate(tokens):
        for part in norm(token).split('-'):
            flat.append(part); owner.append(i)
    heard_flat, source = [], []
    for i, token in enumerate(heard):
        for part in token.split('-'):
            heard_flat.append(part); source.append(i)
    times = [None] * len(tokens)
    for op, a, b, c, d in difflib.SequenceMatcher(None, flat, heard_flat, autojunk=False).get_opcodes():
        if op == 'insert' or c == d:
            continue
        for k in range(a, b):
            i = owner[k]
            if op == 'equal':
                first = last = spoken[source[c + k - a]]
            else:
                first, last = spoken[source[c]], spoken[source[d - 1]]
            start, end = first['start'], last['end']
            if times[i]:
                start, end = min(times[i][0], start), max(times[i][1], end)
            times[i] = (start, end)
    # Words recognition missed entirely sit between their neighbours.
    for i, t in enumerate(times):
        if t is None:
            before = next((times[j][1] for j in range(i - 1, -1, -1) if times[j]), spoken[0]['start'])
            after = next((times[j][0] for j in range(i + 1, len(times)) if times[j]), before)
            times[i] = (before, max(before, after))
    return [dict(text=token, start=s, end=e) for token, (s, e) in zip(tokens, times)]
