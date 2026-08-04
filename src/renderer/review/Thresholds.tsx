import type { Thresholds } from '../../core/types.ts';

interface SliderSpec {
  key: 'blur' | 'faceBlur' | 'exposure' | 'eyes' | 'burstHammingMax';
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'blur', label: 'Sharpness', min: 0, max: 100, step: 1,
    hint: 'Higher rejects softer photos.' },
  { key: 'faceBlur', label: 'Face sharpness', min: 0, max: 100, step: 1,
    hint: 'Applies only to photos containing faces.' },
  { key: 'eyes', label: 'Eyes open', min: 0, max: 1, step: 0.01,
    hint: 'Higher also catches half-closed eyes.' },
  { key: 'exposure', label: 'Exposure', min: 0, max: 100, step: 1,
    hint: 'Higher rejects more blown or crushed frames.' },
  { key: 'burstHammingMax', label: 'Duplicate sensitivity', min: 0, max: 32, step: 1,
    hint: 'Higher groups less similar frames together.' },
];

export interface ThresholdsPanelProps {
  thresholds: Thresholds;
  onChange: (next: Thresholds) => void;
}

/**
 * No debouncing: recompute is pure arithmetic over scores that are already
 * cached, so the grid re-sorts within a frame even for a couple of thousand
 * photos. Debouncing would only add lag.
 */
export function ThresholdsPanel({ thresholds, onChange }: ThresholdsPanelProps) {
  const set = (key: keyof Thresholds, value: number | boolean) =>
    onChange({ ...thresholds, [key]: value });

  return (
    <aside className="thresholds">
      <h2>Strictness</h2>
      <p className="muted">
        Drag to change where the line sits. Nothing is re-analysed and nothing is
        written — the piles just re-sort.
      </p>

      {SLIDERS.map((s) => (
        <div className="slider" key={s.key}>
          <label htmlFor={`t-${s.key}`}>
            {s.label}
            <output>{thresholds[s.key]}</output>
          </label>
          <input
            id={`t-${s.key}`}
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={thresholds[s.key]}
            onChange={(e) => set(s.key, Number(e.target.value))}
          />
          <small>{s.hint}</small>
        </div>
      ))}

      <h3>Checks</h3>
      {([
        ['enableBlur', 'Sharpness'],
        ['enableEyes', 'Eyes'],
        ['enableExposure', 'Exposure'],
        ['enableDuplicates', 'Burst duplicates'],
      ] as const).map(([key, label]) => (
        <label className="check" key={key}>
          <input
            type="checkbox"
            checked={thresholds[key]}
            onChange={(e) => set(key, e.target.checked)}
          />
          {label}
        </label>
      ))}
    </aside>
  );
}
