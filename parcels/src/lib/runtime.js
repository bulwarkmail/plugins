// Share the poller across the sidebar and background hooks in one plugin
// runtime so visit/interval/manual refresh cannot start competing queries.
import { createBackground } from './background.js';

let background;
export function getBackground(api) {
  return (background ??= createBackground(api));
}
