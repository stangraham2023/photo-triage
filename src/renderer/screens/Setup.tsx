import { useState } from 'react';
import type { RunConfig, FolderKind } from '../../shared/contract.ts';
import type { PresetName } from '../../core/types.ts';

/**
 * Writing output into the source folder would break the guarantee that the
 * source is never modified, so identical paths are rejected outright.
 */
export function canStart(cfg: Partial<RunConfig>): boolean {
  const { source, staging, review } = cfg;
  if (!source || !staging || !review) return false;
  if (source === staging || source === review) return false;
  if (staging === review) return false;
  return true;
}

const PRESET_HELP: Record<PresetName, string> = {
  event: 'All checks at balanced thresholds. Flags clearly shut eyes.',
  portrait: 'Strict on faces and eyes, lenient on background blur. Also flags half-closed eyes.',
  landscape: 'Eye checks off. Blur and exposure strict.',
};

export function Setup({ onStart }: { onStart: (cfg: RunConfig) => void }) {
  const [cfg, setCfg] = useState<Partial<RunConfig>>({
    preset: 'event', recurse: true, dryRun: false,
  });

  const pick = async (kind: FolderKind) => {
    const dir = await window.triage.pickFolder(kind);
    if (dir) setCfg((c) => ({ ...c, [kind]: dir }));
  };

  const folder = (kind: FolderKind, label: string, hint: string) => (
    <div className="field" key={kind}>
      <label>{label}</label>
      <div className="row">
        <button onClick={() => void pick(kind)}>Choose…</button>
        <span className="path">{cfg[kind] ?? <em>not set</em>}</span>
      </div>
      <small>{hint}</small>
    </div>
  );

  return (
    <main>
      <h1>Photo Triage</h1>

      {folder('source', 'Photos to sort', 'Opened read-only. Never modified.')}
      {folder('staging', 'Keepers go here', 'Good photos are copied here.')}
      {folder('review', 'Rejects go here', 'Flagged photos are copied here for you to check.')}

      <div className="field">
        <label htmlFor="preset">Preset</label>
        <select
          id="preset"
          value={cfg.preset}
          onChange={(e) => setCfg((c) => ({ ...c, preset: e.target.value as PresetName }))}
        >
          <option value="event">Event</option>
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
        <small>{PRESET_HELP[cfg.preset ?? 'event']}</small>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={cfg.recurse ?? true}
          onChange={(e) => setCfg((c) => ({ ...c, recurse: e.target.checked }))}
        />
        Include subfolders
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={cfg.dryRun ?? false}
          onChange={(e) => setCfg((c) => ({ ...c, dryRun: e.target.checked }))}
        />
        Dry run — analyse and report without copying anything
      </label>

      <p className="notice">
        Photos are sorted as soon as analysis finishes. The review screen, where
        you can change decisions before anything is written, comes next.
      </p>

      <button
        className="primary"
        disabled={!canStart(cfg)}
        onClick={() => onStart(cfg as RunConfig)}
      >
        Sort photos
      </button>
    </main>
  );
}
