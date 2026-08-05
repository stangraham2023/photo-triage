import { useMemo, useState } from 'react';
import type { Decision, PhotoId, PhotoRecord, Thresholds, Verdict } from '../../core/types.ts';
import type { AnalysisPayload } from '../../shared/contract.ts';
import {
  applyOverride, counts, effectiveDecisions, isOverridden, recompute, type ReviewState,
} from '../review/model.ts';
import { PhotoCard } from '../review/PhotoCard.tsx';
import { ThresholdsPanel } from '../review/Thresholds.tsx';
import { ZoomView } from '../review/ZoomView.tsx';

export interface ReviewProps {
  payload: AnalysisPayload;
  initialThresholds: Thresholds;
  onApply: (decisions: Decision[]) => void;
  onCancel: () => void;
}

export function Review({ payload, initialThresholds, onApply, onCancel }: ReviewProps) {
  const [state, setState] = useState<ReviewState>(() => recompute(payload, initialThresholds));
  const [zoomId, setZoomId] = useState<PhotoId | null>(null);

  const recordsById = useMemo(
    () => new Map(payload.records.map((r) => [r.file.relPath, r])),
    [payload.records],
  );

  const decisions = effectiveDecisions(state);
  const c = counts(state);

  const setThresholds = (next: Thresholds) =>
    setState((s) => recompute(s.payload, next, s.overrides));

  const override = (id: PhotoId, verdict: Verdict) =>
    setState((s) => applyOverride(s, id, verdict));

  // Only group leaders get a stack badge, so a burst reads as one entry with a
  // count rather than as N near-identical cards.
  const stackSizeFor = (id: PhotoId): number | undefined => {
    const group = state.groups.find((g) => g.keeperId === id);
    return group?.memberIds.length;
  };

  const section = (title: string, verdict: Verdict, list: Decision[]) => (
    <section>
      <h2>{title} <span className="count">{list.length}</span></h2>
      {list.length === 0 && <p className="muted">Nothing here.</p>}
      <div className="grid">
        {list.map((d) => {
          const record = recordsById.get(d.id);
          if (!record) return <UnreadableCard key={d.id} id={d.id} />;
          return (
            <PhotoCard
              key={d.id}
              record={record}
              decision={d}
              thumbUrl={payload.thumbUrls[d.id] ?? ''}
              overridden={isOverridden(state, d.id)}
              stackSize={verdict === 'good' ? stackSizeFor(d.id) : undefined}
              onKeep={() => override(d.id, 'good')}
              onReject={() => override(d.id, 'rejected')}
              onZoom={() => setZoomId(d.id)}
            />
          );
        })}
      </div>
    </section>
  );

  const zoomRecord = zoomId === null ? null : recordsById.get(zoomId) ?? null;
  const zoomDecision = decisions.find((d) => d.id === zoomId);

  return (
    <div className="review">
      <ThresholdsPanel thresholds={state.thresholds} onChange={setThresholds} />

      <main className="review-main">
        <header className="review-header">
          <div>
            <h1>Review</h1>
            <p className="muted" data-testid="summary">
              {c.good} keepers · {c.rejected} flagged · {c.unreadable} unreadable
              {c.overridden > 0 && ` · ${c.overridden} changed by you`}
            </p>
          </div>
          <div className="review-actions">
            <button onClick={onCancel}>Back</button>
            <button className="primary" onClick={() => onApply(decisions)}>
              Apply — copy {c.good} keepers
            </button>
          </div>
        </header>

        <p className="notice">Nothing has been written yet. Apply does the copying.</p>

        {section('Keepers', 'good', decisions.filter((d) => d.verdict === 'good'))}
        {section('Flagged', 'rejected', decisions.filter((d) => d.verdict === 'rejected'))}
        {section('Unreadable', 'unreadable', decisions.filter((d) => d.verdict === 'unreadable'))}

        {c.notDownloaded > 0 && (
          <section>
            <h2>Not downloaded <span className="count">{c.notDownloaded}</span></h2>
            <p className="notice">
              These are stored in the cloud by iCloud or OneDrive — the file name
              is on your Mac but the photo itself is not. They were skipped
              rather than opened, because opening one downloads it. To include
              them, select them in Finder, choose <strong>Download Now</strong>,
              and run the analysis again.
            </p>
            <div className="grid">
              {decisions.filter((d) => d.verdict === 'not-downloaded').map((d) => (
                <PlaceholderCard key={d.id} id={d.id} />
              ))}
            </div>
          </section>
        )}
      </main>

      {zoomRecord && zoomDecision && (
        <ZoomView
          record={zoomRecord}
          decision={zoomDecision}
          thumbUrl={payload.thumbUrls[zoomRecord.file.relPath] ?? ''}
          onClose={() => setZoomId(null)}
          onKeep={() => override(zoomRecord.file.relPath, 'good')}
          onReject={() => override(zoomRecord.file.relPath, 'rejected')}
        />
      )}
    </div>
  );
}

/** A cloud placeholder was never opened, so there is no thumbnail to show. */
function PlaceholderCard({ id }: { id: PhotoId }) {
  return (
    <figure className="card card-unreadable" data-testid={`card-${id}`}>
      <figcaption>
        <div className="filename" title={id}>{id}</div>
        <div className="chips"><span className="chip">stored in the cloud</span></div>
      </figcaption>
    </figure>
  );
}

/** Unreadable files have no record and no thumbnail — only a name. */
function UnreadableCard({ id }: { id: PhotoId }) {
  return (
    <figure className="card card-unreadable" data-testid={`card-${id}`}>
      <figcaption>
        <div className="filename" title={id}>{id}</div>
        <div className="chips"><span className="chip">could not be decoded</span></div>
      </figcaption>
    </figure>
  );
}

export type { PhotoRecord };
