import type { RunResult } from '../../main/orchestrator.ts';

const REASON_LABEL: Record<string, string> = {
  blur: 'out of focus',
  'eyes-closed': 'eyes closed',
  exposure: 'exposure',
  duplicate: 'burst duplicate',
};

export function Done({ result, onAgain }: { result: RunResult; onAgain: () => void }) {
  const s = result.summary;
  return (
    <main>
      <h1>{result.cancelled ? 'Cancelled' : 'Finished'}</h1>
      <ul className="stats">
        <li><strong>{s.good}</strong> keepers</li>
        <li><strong>{s.rejected}</strong> flagged for review</li>
        <li><strong>{s.unreadable}</strong> unreadable</li>
        <li><strong>{result.groups}</strong> burst group(s)</li>
      </ul>

      {Object.entries(s.byReason).length > 0 && (
        <>
          <h2>Why photos were flagged</h2>
          <ul className="stats">
            {Object.entries(s.byReason).map(([k, v]) => (
              <li key={k}><strong>{v}</strong> {REASON_LABEL[k] ?? k}</li>
            ))}
          </ul>
        </>
      )}

      {result.reportDir && <p className="muted">Reports: {result.reportDir}</p>}
      {result.cancelled && <p className="notice">Nothing was copied.</p>}

      <button className="primary" onClick={onAgain}>Sort another folder</button>
    </main>
  );
}
