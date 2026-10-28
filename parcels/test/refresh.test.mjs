import { describe, expect, it } from 'vitest';
import { fakeApi } from '../../test-utils/fake-api.mjs';
import { VISIT_REFRESH_MS, createBackground } from '../src/lib/background.js';
import { MANUAL_REFRESH_MS, POLL_INTERVAL_MS, getParcel, newParcel, saveParcel } from '../src/lib/parcels.js';

const START = Date.parse('2026-10-21T18:00:00Z');
const number = '1Z999AA10123456784';
const source = { number, carrier: 'ups', carrierName: 'UPS', trackingUrl: 'https://ups.example/track' };

function setup() {
  let time = START;
  const asked = [];
  const statuses = ['in_transit', 'out_for_delivery', 'delivered'];
  const api = fakeApi();
  const tracker = { async trackMany(parcels) {
    asked.push(parcels.map(p => p.number));
    const outcomes = new Map();
    for (const p of parcels) outcomes.set(p.number, {
      result: { status: statuses[Math.min(asked.length - 1, statuses.length - 1)], text: '', events: [], location: '' },
    });
    return outcomes;
  }};
  const background = createBackground(api, { tracker, now: () => time });
  return { api, asked, background, setTime: v => { time = v; } };
}

describe('sidebar visit and manual refresh', () => {
  it('checks when opening webmail, throttles focus, still retains the 30-minute background interval', async () => {
    const { api, asked, background, setTime } = setup();
    await saveParcel(api.storage, newParcel(source, { now: START }));
    expect((await background.visit())?.polled).toBe(1);
    expect(asked).toHaveLength(1);

    setTime(START + VISIT_REFRESH_MS - 1);
    expect(await background.visit()).toBeNull();
    expect(asked).toHaveLength(1);

    setTime(START + VISIT_REFRESH_MS);
    expect((await background.visit())?.polled).toBe(1);
    expect(asked).toHaveLength(2);
    expect((await background.tick())?.polled).toBe(0);
    expect((await getParcel(api.storage, number)).status).toBe('out_for_delivery');
  });

  it('manual refresh uses a shorter throttle and never requests delivered or received parcels', async () => {
    const { api, asked, background, setTime } = setup();
    await saveParcel(api.storage, newParcel(source, { now: START }));
    await background.visit();
    setTime(START + MANUAL_REFRESH_MS - 1);
    expect((await background.tick())?.polled).toBe(0);
    setTime(START + MANUAL_REFRESH_MS);
    expect((await background.refresh())?.polled).toBe(1);
    expect(asked).toHaveLength(2);
    expect(await background.refresh()).toBeNull();
    setTime(START + 2 * MANUAL_REFRESH_MS);
    expect((await background.refresh())?.polled).toBe(1);
    expect((await getParcel(api.storage, number)).status).toBe('delivered');
    setTime(START + POLL_INTERVAL_MS);
    expect((await background.refresh())?.polled).toBe(0);
    expect(asked).toHaveLength(3);
  });

  it('does not bypass a provider retry-after from either automatic or manual refresh', async () => {
    const { api, background, asked, setTime } = setup();
    await saveParcel(api.storage, { ...newParcel(source, { now: START }), retryAt: START + 3600_000 });
    expect((await background.visit())?.polled).toBe(0);
    expect((await background.refresh())?.polled).toBe(0);
    setTime(START + 3600_000);
    expect((await background.refresh())?.polled).toBe(1);
    expect(asked).toHaveLength(1);
  });
});
