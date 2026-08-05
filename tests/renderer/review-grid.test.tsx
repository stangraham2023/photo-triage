// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { Review } from '../../src/renderer/screens/Review.tsx';
import { PRESETS } from '../../src/core/presets.ts';
import type { PhotoRecord, Scores } from '../../src/core/types.ts';
import type { AnalysisPayload } from '../../src/shared/contract.ts';

const scores = (over: Partial<Scores> = {}): Scores => ({
  blurGlobal: 70, blurSharpestRegion: 70, blurFaceMin: null,
  exposure: 80, eyeMin: null, faceCount: 0, phash: '0000000000000000', ...over,
});

const rec = (id: string, over: Partial<Scores> = {}, faces: PhotoRecord['faces'] = []): PhotoRecord => ({
  file: { absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0, onDisk: true },
  meta: { captureTimeMs: 0, orientation: 1, cameraModel: null },
  faces,
  scores: scores(over),
});

const file = (id: string) =>
  ({ absPath: '/' + id, relPath: id, ext: 'jpg', bytes: 1, mtimeMs: 0, onDisk: true });

const payload = (
  records: PhotoRecord[], unreadable: string[] = [], notDownloaded: string[] = [],
): AnalysisPayload => ({
  runId: 'run-1',
  thumbUrls: Object.fromEntries(records.map((r) => [r.file.relPath, `triage-thumb://run-1/${r.file.relPath}.jpg`])),
  records,
  unreadable: unreadable.map(file),
  notDownloaded: notDownloaded.map((id) => ({ ...file(id), onDisk: false })),
  groups: [],
  cancelled: false,
});

const startAnalysis = vi.fn();

beforeEach(() => {
  startAnalysis.mockClear();
  (window as unknown as { triage: unknown }).triage = {
    startAnalysis, applyDecisions: vi.fn(), pickFolder: vi.fn(),
    cancelRun: vi.fn(), onProgress: vi.fn(() => () => {}),
  };
});
afterEach(cleanup);

const renderReview = (p: AnalysisPayload, onApply = vi.fn()) => {
  render(
    <Review payload={p} initialThresholds={PRESETS.event} onApply={onApply} onCancel={vi.fn()} />,
  );
  return onApply;
};

describe('review grid', () => {
  it('renders a card per photo', () => {
    renderReview(payload([rec('a.jpg'), rec('b.jpg')]));
    expect(screen.getByTestId('card-a.jpg')).toBeDefined();
    expect(screen.getByTestId('card-b.jpg')).toBeDefined();
  });

  it('shows the reason and its score on a flagged photo', () => {
    renderReview(payload([rec('bad.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]));
    const card = screen.getByTestId('card-bad.jpg');
    expect(within(card).getByText(/blur 5/)).toBeDefined();
    expect(within(card).getByText(/threshold 35/)).toBeDefined();
  });

  it('re-filters when a slider moves, without touching IPC', () => {
    renderReview(payload([rec('soft.jpg', { blurSharpestRegion: 25, blurGlobal: 25 })]));
    expect(within(screen.getByTestId('summary')).getByText(/0 keepers/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(/Sharpness/i, { selector: '#t-blur' }), {
      target: { value: '10' },
    });

    expect(within(screen.getByTestId('summary')).getByText(/1 keepers/)).toBeDefined();
    // The whole point: no re-analysis, no round trip to the main process.
    expect(startAnalysis).not.toHaveBeenCalled();
  });

  it('moves a photo to keepers when Keep is clicked', () => {
    renderReview(payload([rec('bad.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]));
    fireEvent.click(within(screen.getByTestId('card-bad.jpg')).getByText('Keep'));
    expect(within(screen.getByTestId('summary')).getByText(/1 keepers/)).toBeDefined();
    // The card itself is marked, not merely the running total.
    expect(within(screen.getByTestId('card-bad.jpg')).getByText(/changed by you/)).toBeDefined();
  });

  it('passes the overridden decisions to Apply, not the computed ones', () => {
    const onApply = renderReview(payload([rec('bad.jpg', { blurSharpestRegion: 5, blurGlobal: 5 })]));
    fireEvent.click(within(screen.getByTestId('card-bad.jpg')).getByText('Keep'));
    fireEvent.click(screen.getByText(/^Apply/));

    expect(onApply).toHaveBeenCalledTimes(1);
    const decisions = onApply.mock.calls[0]![0] as Array<{ id: string; verdict: string }>;
    expect(decisions.find((d) => d.id === 'bad.jpg')!.verdict).toBe('good');
  });

  it('states that nothing has been written yet', () => {
    renderReview(payload([rec('a.jpg')]));
    expect(screen.getByText(/Nothing has been written yet/)).toBeDefined();
  });

  it('lists unreadable photos without a thumbnail', () => {
    renderReview(payload([rec('a.jpg')], ['broken.jpg']));
    const card = screen.getByTestId('card-broken.jpg');
    expect(within(card).getByText(/could not be decoded/)).toBeDefined();
    expect(within(card).queryByRole('img')).toBeNull();
  });

  it('shows a frame count on a burst group leader', () => {
    const p = payload([rec('a.jpg'), rec('b.jpg')]);
    p.groups = [{ id: 'g1', memberIds: ['a.jpg', 'b.jpg'], keeperId: 'a.jpg' }];
    renderReview(p);
    expect(screen.getByText('2 frames')).toBeDefined();
  });
});

describe('zoom view', () => {
  it('opens with a crop per detected face and its eye score', () => {
    renderReview(payload([
      rec('p.jpg', { eyeMin: 0.05, faceCount: 1 }, [
        { box: { x: 0.3, y: 0.2, width: 0.2, height: 0.2 }, eyeOpenScore: 0.05, confidence: 0.9 },
      ]),
    ]));

    fireEvent.click(screen.getByLabelText('Zoom p.jpg'));
    expect(screen.getByTestId('face-crop-0')).toBeDefined();
    expect(screen.getByText(/eyes 0\.05/)).toBeDefined();
  });

  it('marks a low-confidence call as unsure', () => {
    renderReview(payload([
      rec('p.jpg', { eyeMin: 0.05, faceCount: 1 }, [
        { box: { x: 0.3, y: 0.2, width: 0.2, height: 0.2 }, eyeOpenScore: 0.05, confidence: 0.45 },
      ]),
    ]));
    fireEvent.click(screen.getByLabelText('Zoom p.jpg'));
    expect(screen.getByText(/unsure/)).toBeDefined();
  });

  it('says so when there were no faces to check', () => {
    renderReview(payload([rec('p.jpg')]));
    fireEvent.click(screen.getByLabelText('Zoom p.jpg'));
    expect(screen.getByText(/No faces detected/)).toBeDefined();
  });
});
