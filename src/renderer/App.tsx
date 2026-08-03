import { useState } from 'react';
import { Setup } from './screens/Setup.tsx';
import { Progress } from './screens/Progress.tsx';
import { Done } from './screens/Done.tsx';
import type { RunConfig } from '../shared/contract.ts';
import type { RunResult } from '../main/orchestrator.ts';
import './styles.css';

type State =
  | { name: 'setup' }
  | { name: 'running' }
  | { name: 'done'; result: RunResult }
  | { name: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ name: 'setup' });

  const start = async (cfg: RunConfig) => {
    setState({ name: 'running' });
    try {
      setState({ name: 'done', result: await window.triage.startRun(cfg) });
    } catch (err) {
      setState({ name: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (state.name === 'running') return <Progress />;
  if (state.name === 'done') {
    return <Done result={state.result} onAgain={() => setState({ name: 'setup' })} />;
  }
  if (state.name === 'error') {
    return (
      <main>
        <h1>Something went wrong</h1>
        <pre className="error">{state.message}</pre>
        <button onClick={() => setState({ name: 'setup' })}>Back</button>
      </main>
    );
  }
  return <Setup onStart={(cfg) => void start(cfg)} />;
}
