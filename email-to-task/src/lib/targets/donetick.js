// Donetick (https://donetick.com), its external API (/eapi/v1) with an
// access token sent in the `secretkey` header.
//
// The external API only lists and creates chores: it has no projects and no
// priority, and no way to read one chore, so the dialog offers no project,
// hides the priority, and a task's existence can't be checked.

import { request, TaskError } from '../errors.js';
import { textToHtml } from '../message.js';
import { baseOn, noonOf, originOf } from './common.js';

function base(ctx) {
  return baseOn(ctx.origin, ctx.config.donetickUrl);
}

export const donetick = {
  id: 'donetick',
  credentialId: 'donetick',
  name: 'Donetick',
  priority: false,
  suggestedServer: (config) => originOf(config.donetickUrl) ?? undefined,

  async containers() {
    return [];
  },

  async create(ctx, task) {
    const body = {
      name: task.title.slice(0, 500),
      description: textToHtml(task.description),
      // Donetick reads a bare date as that day at the current UTC time.
      ...(task.due ? { dueDate: noonOf(task.due) } : {}),
    };
    const res = await request(ctx.api, 'donetick', `${base(ctx)}/eapi/v1/chore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      responseType: 'json',
    });
    const id = res.body?.id;
    if (id === undefined || id === null) throw new TaskError('server', { detail: 'no chore id in the answer' });
    return { taskId: String(id), url: `${base(ctx)}/chores/${encodeURIComponent(id)}` };
  },

  /** Always null: the API can't read one chore, and its list leaves out finished ones. */
  async exists() {
    return null;
  },
};
