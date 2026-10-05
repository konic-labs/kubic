// Slice B: model selection, one-way escalation, thinking clamp+persist
// (issue #20; §38).
// RED: selectModel/escalateModel/clampThinking do not exist yet.
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  clampThinking,
  createLadder,
  escalateModel,
  loadThinkingLevel,
  saveThinkingLevel,
  selectModel,
  supportedThinking,
} from './model-select.js';
import { createModels, fauxProvider } from './pi-boundary.js';

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'));
  scratchDirs.push(dir);
  return dir;
}

function modelsWithFaux(): ReturnType<typeof createModels> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  return models;
}

describe('model selection + escalation + thinking (issue #20, slice B)', () => {
  it('selects explicit provider/id and fails named when unknown', () => {
    const models = modelsWithFaux();
    const fauxId = models.getModels('faux')[0]?.id ?? 'faux-model';
    const picked = selectModel(models, { provider: 'faux', id: fauxId });
    expect(picked.id).toBe(fauxId);
    expect(() => selectModel(models, { provider: 'nope', id: 'x' })).toThrow(
      /unknown provider/,
    );
    expect(() => selectModel(models, { provider: 'faux', id: 'nope' })).toThrow(
      /unknown model/,
    );
  });

  it('falls back to config default, then first available', () => {
    const models = modelsWithFaux();
    const fauxId = models.getModels('faux')[0]?.id ?? 'faux-model';
    expect(
      selectModel(models, undefined, { provider: 'faux', id: fauxId }).id,
    ).toBe(fauxId);
    const first = selectModel(models, undefined);
    expect(first.provider).toBe('faux');
  });

  it('escalation is one-way, recorded, and bounded', () => {
    const ladder = createLadder(['local/llama3', 'faux/big'], {
      maxEscalations: 2,
    });
    const first = escalateModel(
      ladder,
      'local/llama3',
      'faux/big',
      'needs more',
    );
    expect(first.to).toBe('faux/big');
    expect(ladder.record).toHaveLength(1);
    expect(() =>
      escalateModel(ladder, 'faux/big', 'local/llama3', 'cheaper'),
    ).toThrow(/one-way/);
    escalateModel(ladder, 'faux/big', 'faux/big', 'retry');
    expect(() =>
      escalateModel(ladder, 'faux/big', 'faux/big', 'again'),
    ).toThrow(/bounded/);
  });

  it('thinking clamps to model support and persists across attach', () => {
    const models = modelsWithFaux();
    const model = selectModel(models, undefined);
    const levels = supportedThinking(models, model);
    expect(Array.isArray(levels)).toBe(true);
    const clamped = clampThinking(models, model, 'max');
    expect(levels.includes(clamped)).toBe(true);
    const dir = scratch();
    const bridge = createNodeFileBridge('/');
    saveThinkingLevel(bridge, dir, 'high');
    expect(loadThinkingLevel(bridge, dir)).toBe('high');
    // Issue #361: session state is private — 0600 at creation.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'thinking.json')).mode & 0o777).toBe(0o600);
    }
    expect(loadThinkingLevel(bridge, scratch())).toBe(null);
    // Tampered sidecar: unknown level reads back null, never propagates.
    writeFileSync(
      join(dir, 'thinking.json'),
      JSON.stringify({ level: 'ultra' }),
    );
    expect(loadThinkingLevel(bridge, dir)).toBe(null);
    writeFileSync(join(dir, 'thinking.json'), 'not json');
    expect(loadThinkingLevel(bridge, dir)).toBe(null);
  });
});
