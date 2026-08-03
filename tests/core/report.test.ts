import { describe, it, expect } from 'vitest';
import { toCsv, summarize, toHtml } from '../../src/core/report.ts';
import type { Decision, PhotoRecord } from '../../src/core/types.ts';

const rec = (id: string): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0 },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: 'Test Cam' },
  scores: {
    blurGlobal: 70, blurSharpestRegion: 72, blurFaceMin: null,
    exposure: 80, eyeMin: null, faceCount: 0, phash: '0000000000000000',
  },
});

const good: Decision = { id: 'a.jpg', verdict: 'good', reasons: [], groupId: null, isGroupKeeper: true };
const bad: Decision = {
  id: 'b,with,commas.jpg', verdict: 'rejected',
  reasons: [{ code: 'blur', detail: 'blur 5 (threshold 35)', score: 5, threshold: 35 }],
  groupId: null, isGroupKeeper: true,
};

describe('toCsv', () => {
  it('writes a header plus one row per photo', () => {
    const lines = toCsv([rec('a.jpg'), rec('b,with,commas.jpg')], [good, bad]).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('relPath');
  });

  it('quotes fields containing commas so the CSV stays parseable', () => {
    expect(toCsv([rec('b,with,commas.jpg')], [bad])).toContain('"b,with,commas.jpg"');
  });
});

describe('summarize', () => {
  it('counts verdicts and reasons', () => {
    const s = summarize([good, bad]);
    expect(s.total).toBe(2);
    expect(s.good).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.byReason.blur).toBe(1);
  });
});

describe('toHtml', () => {
  it('escapes HTML in filenames rather than injecting it', () => {
    const evil: Decision = { ...good, id: '<script>x</script>.jpg' };
    const html = toHtml([rec('<script>x</script>.jpg')], [evil], summarize([evil]));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
