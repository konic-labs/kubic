// The head row of the agent tree names the run's role. A view keeps the
// label it was built with through a reset (`/new`, `/resume` start another
// session's work under the same role), and an explicit reset label becomes
// the view's label from then on.
import { describe, expect, it } from 'vitest';
import { renderTreeLines, TreeView } from './tree.js';

describe('tree label', () => {
  it('keeps the label a view was built with across a reset', () => {
    const view = new TreeView(undefined, { label: 'reviewer' });
    expect(renderTreeLines(view.getState(), 100)[0]).toBe('◌ reviewer');
    view.reset(undefined, true);
    expect(view.getState().label).toBe('reviewer');
    expect(view.getState().collapsed).toBe(true);
    expect(renderTreeLines(view.getState(), 100)[0]).toBe('◌ reviewer');
  });

  it('makes an explicit reset label the view label from then on', () => {
    const view = new TreeView(undefined, { label: 'reviewer' });
    view.reset('tester');
    expect(view.getState().label).toBe('tester');
    view.reset();
    expect(view.getState().label).toBe('tester');
  });

  it('keeps the default label for a view built without one', () => {
    const view = new TreeView();
    view.reset(undefined, true);
    expect(view.getState().label).toBe('default');
  });
});
