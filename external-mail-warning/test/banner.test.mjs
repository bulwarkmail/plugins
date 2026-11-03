// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { SenderWarning, warningLabel } from '../src/lib/banner.js';

afterEach(cleanup);

describe('external sender banner', () => {
  it('is a warning info bar naming the external senders', () => {
    render(React.createElement(SenderWarning, {
      externals: [{ name: 'Eve', email: 'eve@evil.test', domain: 'evil.test' }],
      fails: ['SPF', 'DMARC'],
    }));
    const bar = document.querySelector('.bk-infobar');
    expect(bar.getAttribute('data-tone')).toBe('warning');
    expect(bar.textContent).toBe('External sender · SPF, DMARC failedEve <eve@evil.test>');
    // The address can't lose its bracket to a line break or a right-to-left page.
    expect(bar.querySelector('bdi').textContent).toBe('<eve@evil.test>');
    expect(document.querySelector('[style]')).toBeNull();
  });

  it('shows only the failure line when no sender is external', () => {
    expect(warningLabel([], ['DKIM'])).toBe('DKIM failed');
    expect(warningLabel([{}, {}], [])).toBe('External senders');
  });

  it('draws nothing when there is nothing to warn about', () => {
    render(React.createElement(SenderWarning, { externals: [], fails: [] }));
    expect(document.body.textContent).toBe('');
  });
});
