import type { ApplyResult } from '../../main/orchestrator.ts';

export function Done({ result, onAgain }: { result: ApplyResult; onAgain: () => void }) {
  return (
    <main>
      <h1>Finished</h1>
      <ul className="stats">
        <li><strong>{result.copied}</strong> photos copied</li>
        {result.skipped > 0 && (
          <li><strong>{result.skipped}</strong> already present, skipped</li>
        )}
      </ul>
      <p className="muted">Reports: {result.reportDir}</p>
      <p className="notice">
        Your source folder was not modified. To reverse this run:
        <br />
        <code>npm run triage -- --undo "{result.manifestPath}"</code>
      </p>
      <button className="primary" onClick={onAgain}>Sort another folder</button>
    </main>
  );
}
