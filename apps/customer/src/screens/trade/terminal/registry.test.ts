import { describe, expect, it, vi } from 'vitest';
import { getPanel, isKnownPanel, listPanels, panelsVersion, registerPanel, subscribePanels, type PanelDefinition } from './registry';

const definition = (type: string, extra: Partial<PanelDefinition> = {}): PanelDefinition => ({
  type,
  title: type,
  about: 'A test panel.',
  status: 'live',
  component: () => null,
  ...extra,
});

describe('the panel registry', () => {
  it('lets a later panel plug in (scanner, heatmap, alerts, a Preview product) and unplug again', () => {
    const before = listPanels().length;
    const remove = registerPanel(definition('scanner'));
    const removePreview = registerPanel(definition('futures-desk', { status: 'preview' }));
    expect(isKnownPanel('scanner')).toBe(true);
    expect(getPanel('futures-desk')?.status).toBe('preview');
    expect(listPanels()).toHaveLength(before + 2);
    remove();
    removePreview();
    expect(isKnownPanel('scanner')).toBe(false);
    expect(listPanels()).toHaveLength(before);
  });

  it('tells subscribers (the Add panel menu) when something is added or removed', () => {
    const listener = vi.fn();
    const stop = subscribePanels(listener);
    const version = panelsVersion();
    const remove = registerPanel(definition('depth'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(panelsVersion()).toBe(version + 1);
    remove();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    registerPanel(definition('alerts'))();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('refuses a type that could not be saved in a workspace', () => {
    expect(() => registerPanel(definition('Bad Type'))).toThrow();
    expect(() => registerPanel(definition(''))).toThrow();
  });

  it('only removes the definition it added', () => {
    const first = registerPanel(definition('heatmap'));
    const second = registerPanel(definition('heatmap', { title: 'Newer' }));
    first();
    expect(getPanel('heatmap')?.title).toBe('Newer');
    second();
    expect(isKnownPanel('heatmap')).toBe(false);
  });
});
