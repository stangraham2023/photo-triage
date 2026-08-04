import type { Decision, PhotoRecord } from '../../core/types.ts';
import { ReasonChip } from './ReasonChip.tsx';

export interface PhotoCardProps {
  record: PhotoRecord;
  decision: Decision;
  thumbUrl: string;
  overridden: boolean;
  /** Number of frames in this photo's burst group, when it leads one. */
  stackSize?: number;
  onKeep: () => void;
  onReject: () => void;
  onZoom: () => void;
}

export function PhotoCard(props: PhotoCardProps) {
  const { record, decision, thumbUrl, overridden, stackSize } = props;
  const id = record.file.relPath;

  return (
    <figure className={`card${overridden ? ' card-overridden' : ''}`} data-testid={`card-${id}`}>
      <button className="thumb-button" onClick={props.onZoom} aria-label={`Zoom ${id}`}>
        <img className="thumb" src={thumbUrl} alt={id} loading="lazy" />
        {stackSize !== undefined && stackSize > 1 && (
          <span className="stack-badge">{stackSize} frames</span>
        )}
      </button>

      <figcaption>
        <div className="filename" title={id}>{id}</div>
        {decision.reasons.length > 0 && (
          <div className="chips">
            {decision.reasons.map((r, i) => <ReasonChip key={i} reason={r} />)}
          </div>
        )}
        {overridden && <div className="overridden-note">changed by you</div>}
        <div className="card-actions">
          <button
            onClick={props.onKeep}
            disabled={decision.verdict === 'good'}
          >
            Keep
          </button>
          <button
            onClick={props.onReject}
            disabled={decision.verdict === 'rejected'}
          >
            Reject
          </button>
        </div>
      </figcaption>
    </figure>
  );
}
