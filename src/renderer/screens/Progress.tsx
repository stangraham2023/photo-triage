import { useEffect, useState } from 'react';
import type { RunProgress } from '../../main/orchestrator.ts';

const LABEL: Record<RunProgress['phase'], string> = {
  scanning: 'Scanning folder',
  analysing: 'Analysing photos',
  copying: 'Copying files',
};

export function Progress() {
  const [p, setP] = useState<RunProgress | null>(null);

  useEffect(() => window.triage.onProgress(setP), []);

  const pct = p && p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <main>
      <h1>{p ? LABEL[p.phase] : 'Starting…'}</h1>
      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <p className="muted">
        {p && p.total > 0 ? `${p.done} of ${p.total}` : ''} {p?.current ?? ''}
      </p>
      <button onClick={() => window.triage.cancelRun()}>Cancel</button>
      <p className="notice">Cancelling is safe — nothing is copied until analysis finishes.</p>
    </main>
  );
}
