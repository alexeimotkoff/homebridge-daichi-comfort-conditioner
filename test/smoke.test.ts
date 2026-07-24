import { describe, expect, it } from 'vitest';

import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';

describe('plugin identity', () => {
  it('exports the Homebridge platform and plugin names', () => {
    expect(PLATFORM_NAME).toBe('DaichiComfortConditioner');
    expect(PLUGIN_NAME).toBe('@alexeimotkoff/homebridge-daichi-comfort-conditioner');
  });
});
