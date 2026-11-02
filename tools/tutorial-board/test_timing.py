import unittest
from timing import plan_frames

class TimingTests(unittest.TestCase):
    def test_actual_narration_fits_exactly_one_minute(self):
        durations = [5.44, 8.96, 7.12, 7.6, 7.68, 7.36, 5.12]
        frames = plan_frames(durations)
        self.assertEqual(sum(frames), 1800)
        for count, spoken in zip(frames, durations):
            self.assertGreater(count / 30 - .55, spoken)

    def test_rounding_and_other_frame_rates(self):
        self.assertEqual(sum(plan_frames([4.123, 7.89, 12.121], fps=24)), 1440)

    def test_invalid_or_overlong_audio_is_rejected(self):
        for durations in [[], [0], [-1], [float('nan')], [float('inf')], [60], [58, 1]]:
            with self.subTest(durations=durations), self.assertRaises(ValueError):
                plan_frames(durations)


class CaptionTests(unittest.TestCase):
    def test_phrases_preserve_measured_boundaries_and_every_word(self):
        from timing import phrase_captions
        texts = 'Read the description, then check the question.'.split()
        words = [dict(text=text, start=i*.31, end=i*.31+.2) for i,text in enumerate(texts)]
        phrases = phrase_captions(words, limit=24)
        self.assertEqual([w for p in phrases for w in p['words']], words)
        for phrase in phrases:
            self.assertEqual(phrase['start'], phrase['words'][0]['start'])
            self.assertEqual(phrase['end'], phrase['words'][-1]['end'])
            self.assertLessEqual(len(phrase['text']), 24)

    def test_character_limit_does_not_leave_an_orphan_word(self):
        from timing import phrase_captions
        words = [dict(text=w, start=i, end=i+1) for i,w in enumerate(
            'Understand the next step and let the rest keep moving.'.split())]
        phrases = phrase_captions(words)
        self.assertGreater(len(phrases[-1]['words']), 2)
        self.assertEqual([w for p in phrases for w in p['words']], words)

    def test_paced_by_narration(self):
        frames = plan_frames([5.0, 7.51], fps=60, total=None, pad=.4)
        self.assertEqual(frames, [324, 475])

    def test_desktop_frame_budget(self):
        self.assertEqual(sum(plan_frames([5.44,8.96,7.12,7.6,7.68,7.36,5.12], fps=60)), 3600)


class NarrationTests(unittest.TestCase):
    def test_tighten_shortens_only_long_silences(self):
        from timing import tighten
        rate = 1000
        tone = [8000, -8000] * 100          # 0.2 s of speech
        pause = [0] * 600                    # 0.6 s pause
        short = [0] * 100                    # 0.1 s pause
        out = tighten(pause + tone + pause + tone + short + tone + pause, rate, gap=.2, edge=.04)
        self.assertEqual(len(out), 40 + 200 + 200 + 200 + 100 + 200 + 40)
        self.assertEqual(sum(1 for x in out if x), 600)

    def test_written_names_take_the_spoken_timestamps(self):
        from timing import map_words
        spoken = [dict(text=t, start=i, end=i + .5) for i, t in enumerate(
            'Weirder shows your Herder projects board.'.split())]
        words = map_words('wherdr shows your herdr-projects board.', spoken,
                          {'weirder': 'wherdr', 'herder': 'herdr'})
        self.assertEqual([w['text'] for w in words], ['wherdr', 'shows', 'your', 'herdr-projects', 'board.'])
        self.assertEqual((words[0]['start'], words[0]['end']), (0, .5))
        self.assertEqual((words[3]['start'], words[3]['end']), (3, 4.5))
        self.assertEqual(words[4]['start'], 5)

    def test_missed_words_stay_in_order(self):
        from timing import map_words
        spoken = [dict(text='Open', start=0, end=.4), dict(text='Board.', start=1, end=1.5)]
        words = map_words('Open the Board.', spoken)
        self.assertEqual([w['start'] for w in words], [0, .4, 1])

if __name__ == '__main__':
    unittest.main()
