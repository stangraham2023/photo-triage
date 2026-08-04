import { useEffect } from 'react';
import type { Decision, PhotoRecord } from '../../core/types.ts';
import { faceCropStyle } from './faceCrop.ts';
import { ReasonChip } from './ReasonChip.tsx';

export interface ZoomViewProps {
  record: PhotoRecord;
  decision: Decision;
  thumbUrl: string;
  onClose: () => void;
  onKeep: () => void;
  onReject: () => void;
}

const CROP_PX = 180;

export function ZoomView({ record, decision, thumbUrl, onClose, onKeep, onReject }: ZoomViewProps) {
  const url = thumbUrl;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key.toLowerCase() === 'g') onKeep();
      if (e.key.toLowerCase() === 'r') onReject();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onKeep, onReject]);

  return (
    <div className="zoom-backdrop" onClick={onClose} role="dialog" aria-label="Photo detail">
      <div className="zoom" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>{record.file.relPath}</strong>
          <button onClick={onClose} aria-label="Close">✕</button>
        </header>

        <img className="zoom-image" src={url} alt={record.file.relPath} />

        {decision.reasons.length > 0 && (
          <div className="chips">
            {decision.reasons.map((r, i) => <ReasonChip key={i} reason={r} />)}
          </div>
        )}

        {record.faces.length > 0 ? (
          <>
            <h3>Faces ({record.faces.length})</h3>
            <p className="muted">
              Check the call yourself — this is the crop the eye score was taken from.
            </p>
            <div className="face-crops">
              {record.faces.map((f, i) => (
                <figure key={i}>
                  <div
                    className="face-crop"
                    style={faceCropStyle(f.box, CROP_PX, url)}
                    data-testid={`face-crop-${i}`}
                  />
                  <figcaption>
                    eyes {f.eyeOpenScore.toFixed(2)}
                    {f.confidence < 0.6 && <span className="low-confidence"> · unsure</span>}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : (
          <p className="muted">No faces detected, so the eye check did not apply.</p>
        )}

        <div className="card-actions">
          <button onClick={onKeep} disabled={decision.verdict === 'good'}>Keep (G)</button>
          <button onClick={onReject} disabled={decision.verdict === 'rejected'}>Reject (R)</button>
        </div>
      </div>
    </div>
  );
}
