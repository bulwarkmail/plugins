// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { allStrings } from '../src/lib/i18n.js';

// The chat hands the context area's image flag to runChat (a second line of
// defence: a model that can't see images never gets one), and tells the
// lookups when the service refused images.

const seen = vi.hoisted(() => ({ calls: [] }));
vi.mock('../src/lib/chat.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    runChat: async (api, endpoint, prompt, opts) => {
      seen.calls.push(prompt);
      return { text: 'Done.', steps: [] };
    },
  };
});
const { AssistantPanel } = await import('../src/ui/Panel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { cleanup(); seen.calls.length = 0; });

const FEATURES = { attachmentText: true, attachmentImages: true, threads: true, listSelection: true };
const EMAIL = { id: 'M1', subject: 'Plan', from: [{ email: 'c@example.org' }], text: 'See attached.', attachments: [{ blobId: 'b2', name: 'whiteboard.jpg', type: 'image/jpeg', size: 30000, inline: false }] };

async function chatWith(config) {
  const api = fakeApi({
    translations: allStrings(),
    hostFeatures: FEATURES,
    handlers: {
      'admin.getAllConfig': async () => ({ anthropicBaseUrl: 'http://localhost:18099/anthropic/v1', ...config }),
      'email.getThreadCount': async () => 1,
      'email.getAttachmentImage': async () => ({ name: 'whiteboard.jpg', type: 'image/jpeg', width: 10, height: 10, data: 'AAAA', status: 'ok' }),
    },
  });
  await api.storage.set('consent:v2:anthropic:http://localhost:18099', true);
  await act(async () => { render(React.createElement(AssistantPanel, { api, email: EMAIL, selection: { text: '' }, focusRequest: 0 })); });
  const input = await screen.findByRole('textbox', { name: 'Message to the assistant' });
  await act(async () => { fireEvent.change(input, { target: { value: 'what is on it?' } }); });
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
  await waitFor(() => expect(seen.calls).toHaveLength(1));
  return { api, prompt: seen.calls[0] };
}

describe('images and the chat', () => {
  it('lets runChat send images only when the model can see them', async () => {
    expect((await chatWith({})).prompt.images).toBe(true);
    cleanup();
    seen.calls.length = 0;
    expect((await chatWith({ anthropicImages: 'no' })).prompt.images).toBe(false);
  });

  it('gives the lookups names only once runChat says the service refused images', async () => {
    const { api, prompt } = await chatWith({});
    const fresh = await prompt.runTool('read_attachment', { name: 'whiteboard.jpg' }, { id: 'c1' });
    expect(fresh.images).toHaveLength(1);
    const refused = await prompt.runTool('read_attachment', { name: 'whiteboard.jpg' }, { id: 'c2', imagesRefused: true });
    expect(refused).toBe('[Image: whiteboard.jpg. The AI service refused images in this chat.]');
    expect(api.calls('email.getAttachmentImage')).toHaveLength(1);
  });
});
