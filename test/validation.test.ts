import { describe, expect, it } from 'vitest';

import {
  controlEnvelopeFixture,
  currentBuildingsResponseFixture,
  deviceFixture,
  fanSpeedFunctionFixture,
  mqttModelFixture,
  negativeSetTempFunctionFixture,
  nullableControlEnvelopeFixture,
  nullableDeviceFixture,
  offControlEnvelopeFixture,
  partialTemperatureMqttModelFixture,
} from './fixtures/daichi';
import { isBuildingsResponse, isControlEnvelope, isDevice, isMqttModel } from '../src/validation';

const validFunction = deviceFixture.pult[0].functions[0];

function deviceWithFunction(value: unknown) {
  return { ...deviceFixture, pult: [{ functions: [value] }] };
}

describe('API response validation', () => {
  it('accepts the current direct buildings data array', () => {
    expect(isBuildingsResponse(currentBuildingsResponseFixture)).toBe(true);
  });

  it('accepts a valid control envelope', () => {
    expect(isControlEnvelope(controlEnvelopeFixture)).toBe(true);
  });

  it('accepts a valid off control envelope', () => {
    expect(isControlEnvelope(offControlEnvelopeFixture)).toBe(true);
  });

  it('rejects a control envelope without devices', () => {
    expect(isControlEnvelope({ done: true, errors: null, data: {} })).toBe(false);
  });

  it('accepts a valid MQTT root model', () => {
    expect(isMqttModel(mqttModelFixture)).toBe(true);
  });

  it('accepts a partial MQTT temperature update without weakening control responses', () => {
    expect(isMqttModel(partialTemperatureMqttModelFixture)).toBe(true);
    expect(isControlEnvelope({
      done: true,
      errors: null,
      data: partialTemperatureMqttModelFixture,
    })).toBe(false);
  });

  it.each([
    { label: 'device id', device: { id: '1001', curTemp: 26 } },
    { label: 'temperature', device: { id: 1001, curTemp: '26' } },
    { label: 'status', device: { id: 1001, status: 1 } },
    { label: 'power state', device: { id: 1001, state: { isOn: 'false' } } },
    { label: 'pult', device: { id: 1001, pult: {} } },
  ])('rejects a partial MQTT update with malformed $label', ({ device }) => {
    expect(isMqttModel({ devices: [device] })).toBe(false);
  });

  it('accepts nullable fields from current Daichi device responses', () => {
    expect(isDevice(nullableDeviceFixture)).toBe(true);
    expect(isMqttModel({ devices: [nullableDeviceFixture] })).toBe(true);
    expect(isControlEnvelope(nullableControlEnvelopeFixture)).toBe(true);
  });

  it('accepts a device without a current temperature', () => {
    const deviceWithoutCurTemp: Record<string, unknown> = { ...deviceFixture };
    delete deviceWithoutCurTemp.curTemp;

    expect(isDevice(deviceWithoutCurTemp)).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite current temperature: %s', (curTemp) => {
    expect(isDevice({ ...deviceFixture, curTemp })).toBe(false);
  });

  it.each([
    {},
    { devices: {} },
  ])('rejects a MQTT model without an array of devices', (value) => {
    expect(isMqttModel(value)).toBe(false);
  });

  it.each([
    { ...deviceFixture, id: '1001' },
    { ...deviceFixture, serial: undefined },
    { ...deviceFixture, state: {} },
    { ...deviceFixture, pult: {} },
  ])('rejects a device with malformed mandatory consumed fields', (value) => {
    expect(isDevice(value)).toBe(false);
  });

  it.each([
    '22',
    NaN,
    Infinity,
  ])('rejects malformed function state.value: %s', (value) => {
    expect(isDevice(deviceWithFunction({
      ...validFunction,
      state: { ...validFunction.state, value },
    }))).toBe(false);
  });

  it.each([
    { label: 'non-array', valueRange: {} },
    { label: 'empty', valueRange: [] },
    { label: 'NaN member', valueRange: [16, NaN, 30] },
    { label: 'infinite member', valueRange: [16, Infinity, 30] },
  ])('rejects malformed function state.valueRange: $label', ({ valueRange }) => {
    expect(isDevice(deviceWithFunction({
      ...validFunction,
      state: { ...validFunction.state, valueRange },
    }))).toBe(false);
  });

  it('rejects an oversized function state.valueRange without throwing', () => {
    const valueRange = new Array(257).fill(1);
    const value = deviceWithFunction({
      ...validFunction,
      state: { ...validFunction.state, valueRange },
    });
    let result: boolean | undefined;

    expect(() => {
      result = isDevice(value);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('accepts valid fan-speed and negative set-temperature ranges', () => {
    expect(isDevice(deviceWithFunction(fanSpeedFunctionFixture))).toBe(true);
    expect(isDevice(deviceWithFunction(negativeSetTempFunctionFixture))).toBe(true);
  });

  it.each([
    { label: 'negative maximum', valueRange: [-5, -1] },
    { label: 'zero maximum', valueRange: [-1, 0] },
    { label: 'overflowing divisor', valueRange: [Number.MIN_VALUE] },
    { label: 'zero computed step', valueRange: [1, 101] },
  ])('rejects an unsafe fan-speed range: $label', ({ valueRange }) => {
    expect(isDevice(deviceWithFunction({
      ...fanSpeedFunctionFixture,
      state: { ...fanSpeedFunctionFixture.state, valueRange },
    }))).toBe(false);
  });

  it('rejects malformed function state.isOn', () => {
    expect(isDevice(deviceWithFunction({
      ...validFunction,
      state: { ...validFunction.state, isOn: 1 },
    }))).toBe(false);
  });

  it('rejects a malformed linked function', () => {
    expect(isDevice(deviceWithFunction({
      ...validFunction,
      linkedFunction: { id: 351 },
    }))).toBe(false);
  });

  it.each([
    {
      label: 'state value',
      value: {
        ...validFunction,
        state: { ...validFunction.state, value: {} },
      },
    },
    {
      label: 'BLE on command',
      value: {
        ...validFunction,
        metaData: { bleTagInfo: { ...validFunction.metaData.bleTagInfo, bleOnCommand: {} } },
      },
    },
    {
      label: 'linked function',
      value: {
        ...validFunction,
        linkedFunction: 'invalid',
      },
    },
  ])('rejects non-null malformed $label', ({ value }) => {
    expect(isDevice(deviceWithFunction(value))).toBe(false);
  });

  it('rejects a linked-function cycle without recursing forever', () => {
    const cyclicFunction: Record<string, unknown> = { ...validFunction };
    cyclicFunction.linkedFunction = cyclicFunction;

    expect(isDevice(deviceWithFunction(cyclicFunction))).toBe(false);
  });
});
