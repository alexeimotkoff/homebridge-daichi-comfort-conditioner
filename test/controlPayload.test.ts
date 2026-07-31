import { describe, expect, it } from 'vitest';

import { buildControlPayload } from '../src/controlPayload';
import { CtrlMode } from '../src/models/ctrlMode';

describe('buildControlPayload', () => {
  it.each([
    [true, { cmdId: 42, value: { functionId: 350, isOn: true, parameters: null }, conflictResolveData: null }],
    [false, { cmdId: 42, value: { functionId: 350, isOn: false, parameters: null }, conflictResolveData: null }],
  ])('builds the exact power payload for %s', (isOn, expected) => {
    expect(buildControlPayload(CtrlMode.IsOn, 350, isOn, 42)).toEqual(expected);
  });

  it.each([true, false])('builds the exact Turbo payload for %s', (isOn) => {
    expect(buildControlPayload(CtrlMode.Turbo, 364, isOn, 42)).toEqual({
      cmdId: 42,
      value: {functionId: 364, isOn, parameters: null},
      conflictResolveData: null,
    });
  });

  it.each([
    [CtrlMode.SetTemp, 24],
    [CtrlMode.FanSpeed, 60],
  ])('uses a numeric value for command %s', (cmd, value) => {
    expect(buildControlPayload(cmd, 351, value, 7)).toEqual({
      cmdId: 7,
      value: { functionId: 351, value, parameters: null },
      conflictResolveData: null,
    });
  });

  it('creates a command id within the supported range by default', () => {
    const payload = buildControlPayload(CtrlMode.IsOn, 350, true);

    expect(payload.cmdId).toBeGreaterThanOrEqual(0);
    expect(payload.cmdId).toBeLessThanOrEqual(99_999_999);
    expect(Number.isInteger(payload.cmdId)).toBe(true);
  });

  it.each([
    true,
    NaN,
    Infinity,
  ])('rejects a non-finite numeric value for SetTemp: %s', (value) => {
    expect(() => buildControlPayload(CtrlMode.SetTemp, 351, value, 7)).toThrow(TypeError);
  });

  it('rejects a numeric value for a boolean command', () => {
    expect(() => buildControlPayload(CtrlMode.IsOn, 350, 1, 7)).toThrow(TypeError);
  });
});
