import { useState } from 'react';
import { Setup } from './screens/Setup.tsx';
import { Progress } from './screens/Progress.tsx';
import { Review } from './screens/Review.tsx';
import { Done } from './screens/Done.tsx';
import { PRESETS } from '../core/presets.ts';
import type { AnalysisPayload, RunConfig } from '../shared/contract.ts';
import type { ApplyResult } from '../main/orchestrator.ts';
import type { Decision } from '../core/types.ts';
import './styles.css';

type State =
  | { name: 'setup' }
  | { name: 'analysing' }
  | { name: 'review'; payload: AnalysisPayload; cfg: RunConfig }
  | { name: 'applying' }
  | { name: 'done'; result: ApplyResult }
  | { name: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ name: 'setup' });

  const fail = (err: unknown) =>
    setState({ name: 'error', message: err instanceof Error ? err.message : String(err) });

  const start = async (cfg: RunConfig) => {
    setState({ name: 'analysing' });
    try {
      const payload = await window.triage.startAnalysis(cfg);
      if (payload.cancelled) {
        setState({ name: 'setup' });
        return;
      }
      setState({ name: 'review', payload, cfg });
    } catch (err) {
      fail(err);
    }
  };

  const apply = async (runId: string, decisions: Decision[]) => {
    setState({ name: 'applying' });
    try {
      setState({ name: 'done', result: await window.triage.applyDecisions({ runId, decisions }) });
    } catch (err) {
      fail(err);
    }
  };

  switch (state.name) {
    case 'analysing':
    case 'applying':
      return <Progress />;

    case 'review':
      return (
        <Review
          payload={state.payload}
          initialThresholds={PRESETS[state.cfg.preset]}
          onApply={(decisions) => void apply(state.payload.runId, decisions)}
          onCancel={() => setState({ name: 'setup' })}
        />
      );

    case 'done':
      return <Done result={state.result} onAgain={() => setState({ name: 'setup' })} />;

    case 'error':
      return (
        <main>
          <h1>Something went wrong</h1>
          <pre className="error">{state.message}</pre>
          <button onClick={() => setState({ name: 'setup' })}>Back</button>
        </main>
      );

    default:
      return <Setup onStart={(cfg) => void start(cfg)} />;
  }
}
