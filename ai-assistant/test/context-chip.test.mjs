// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { AssistantPanel } from '../src/ui/Panel.jsx';
import { ContextChip, chipMinWidth, rowFit } from '../src/ui/panel/ContextChips.jsx';
import { ActionsMenu } from '../src/ui/panel/ActionsMenu.jsx';
import { allStrings } from '../src/lib/i18n.js';

// The chip row under the input: the context chip and the Actions button
// must never overlap, from the narrowest panel (200 px) to the widest (500 px).

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const EMAIL = { id: 'M1', subject: 'Lunch on Friday with the whole team?', receivedAt: '2026-10-12T09:00:00Z', from: [{ name: 'Carol', email: 'carol@example.org' }], text: 'Shall we?' };
// The chip row's width in a panel: the panel minus the box's padding, border and the Send button.
const rowAt = (panel) => panel - 24 - 22 - 36;

describe('how the chip row fits', () => {
  it('gives the chip its text when there is room, its icon when there is not, then shrinks Actions', () => {
    const actionsWidth = 104;
    expect(rowFit({ width: rowAt(500), actionsWidth, chip: true, removable: true })).toEqual({ chip: 'full', actions: 'full' });
    expect(rowFit({ width: rowAt(280), actionsWidth, chip: true, removable: true })).toEqual({ chip: 'icon', actions: 'full' });
    expect(rowFit({ width: rowAt(200), actionsWidth, chip: true, removable: true })).toEqual({ chip: 'icon', actions: 'icon' });
    // Unknown width (not measured yet): everything with text.
    expect(rowFit({ width: 0, actionsWidth, chip: true, removable: true })).toEqual({ chip: 'full', actions: 'full' });
    // Whatever the width, the pieces it keeps fit: chip + gap + Actions <= row.
    for (let panel = 200; panel <= 500; panel += 10) {
      const width = rowAt(panel);
      const fit = rowFit({ width, actionsWidth, chip: true, removable: true });
      const chip = fit.chip === 'full' ? chipMinWidth(true) : 28 + 6 + 20;
      const actions = fit.actions === 'full' ? actionsWidth : 32;
      expect(chip + 4 + actions, `${panel} px`).toBeLessThanOrEqual(width);
    }
  });
});

describe('the context chip', () => {
  it('puts the remove button after the text, not over it, and names itself in full', () => {
    render(React.createElement(ContextChip, { icon: 'mail', label: 'This message', detail: 'Lunch on Fri…', title: EMAIL.subject, removeLabel: 'Remove from context', onRemove: () => {} }));
    const chip = screen.getByRole('group', { name: `This message: ${EMAIL.subject}` });
    expect(chip.getAttribute('title')).toBe(`This message: ${EMAIL.subject}`);
    const x = screen.getByRole('button', { name: 'Remove from context' });
    expect(x.style.position).not.toBe('absolute');
    expect(x.style.flexShrink).toBe('0');
    // The label can shrink: it never paints past the chip.
    const label = chip.querySelector('[data-chip-label]');
    expect(label.style.minWidth).toBe('0px');
    expect(label.style.textOverflow).toBe('ellipsis');
    // The subject gives way before the label.
    const detail = chip.querySelector('[data-chip-detail]');
    expect(Number(detail.style.flexShrink)).toBeGreaterThan(Number(label.style.flexShrink || 1));
  });

  it('shows only its icon when told to, and keeps its name and the remove button', () => {
    render(React.createElement(ContextChip, { icon: 'mail', label: 'This message', detail: 'Lunch', title: EMAIL.subject, removeLabel: 'Remove from context', onRemove: () => {}, fit: 'icon' }));
    const chip = screen.getByRole('group', { name: `This message: ${EMAIL.subject}` });
    expect(chip.querySelector('[data-chip-detail]')).toBeNull();
    // The label is only there for screen readers.
    expect(chip.querySelector('[data-chip-label]').style.position).toBe('absolute');
    expect(screen.getByRole('button', { name: 'Remove from context' })).toBeTruthy();
  });
});

describe('the chip row in the panel', () => {
  // jsdom has no layout: give the row a width and a ResizeObserver that reports it.
  function withRowWidth(width) {
    const observers = [];
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.hasAttribute?.('data-chip-row') ? width.current : 0; } });
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.hasAttribute?.('data-assistant-actions') ? 104 : 0; } });
    return {
      resize: async (w) => { width.current = w; await act(async () => { for (const o of observers) o.cb([]); }); },
      restore: () => {
        delete globalThis.ResizeObserver;
        if (desc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', desc);
        if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offset);
      },
    };
  }

  it('turns the chip, then Actions, into icons as the panel narrows, and back', async () => {
    const width = { current: rowAt(500) };
    const env = withRowWidth(width);
    try {
      const api = fakeApi({ translations: allStrings(), handlers: { 'admin.getAllConfig': async () => ({ anthropicBaseUrl: 'http://localhost:18099/anthropic/v1' }) } });
      await act(async () => { render(React.createElement(AssistantPanel, { api, email: EMAIL, selection: { text: '' }, focusRequest: 0 })); });
      await screen.findByRole('textbox', { name: 'Message to the assistant' });
      const chip = () => document.querySelector('[data-context-chip]');
      const actions = () => document.querySelector('[data-assistant-actions]');
      await env.resize(rowAt(500));
      expect(chip().dataset.fit).toBe('full');
      expect(actions().hasAttribute('data-compact')).toBe(false);
      await env.resize(rowAt(280));
      expect(chip().dataset.fit).toBe('icon');
      expect(actions().hasAttribute('data-compact')).toBe(false);
      await env.resize(rowAt(200));
      expect(chip().dataset.fit).toBe('icon');
      expect(actions().hasAttribute('data-compact')).toBe(true);
      // Still reachable by name.
      expect(screen.getByRole('button', { name: 'Actions' })).toBeTruthy();
      expect(screen.getByRole('group', { name: /^This message: Lunch on Friday/ })).toBeTruthy();
      await env.resize(rowAt(500));
      expect(chip().dataset.fit).toBe('full');
      expect(actions().hasAttribute('data-compact')).toBe(false);
    } finally {
      env.restore();
    }
  });
});

describe('the Actions menu in a narrow panel', () => {
  // jsdom has no layout: place the menu where the browser put it in a 279 px frame, 7 px past the left edge.
  function renderedMenu(left, right) {
    const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
    Element.prototype.getBoundingClientRect = function box() {
      return this.getAttribute?.('role') === 'menu' ? { left, right, top: 0, bottom: 0, width: right - left, height: 0 } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    };
    const inner = window.innerWidth;
    window.innerWidth = 279;
    return () => {
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
      window.innerWidth = inner;
    };
  }

  async function openMenu() {
    render(React.createElement(ActionsMenu, { api: { i18n: { t: (k) => k } }, actions: ['summary'], actionLabel: (a) => a, onPick: () => {} }));
    await act(async () => { screen.getByRole('button', { name: /panel.actions/ }).click(); });
    return screen.getByRole('menu');
  }

  it('slides back inside the frame when it would start past the left edge', async () => {
    const restore = renderedMenu(-7, 203);
    try {
      expect((await openMenu()).style.transform).toBe('translateX(15px)');
    } finally { restore(); }
  });

  it('slides back when it would run past the right edge', async () => {
    const restore = renderedMenu(80, 290);
    try {
      expect((await openMenu()).style.transform).toBe('translateX(-19px)');
    } finally { restore(); }
  });

  it('stays put when it fits', async () => {
    const restore = renderedMenu(40, 250);
    try {
      expect((await openMenu()).style.transform).toBe('');
    } finally { restore(); }
  });
});
