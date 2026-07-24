export const deviceFixture = {
  id: 1001,
  serial: 'TEST-SERIAL',
  status: 'connected',
  curTemp: 22,
  state: { isOn: true },
  pult: [{
    functions: [{
      id: 350,
      state: { isOn: true, value: 22, valueRange: [16, 30] },
      metaData: { bleTagInfo: { bleTag: 'TEST-TAG', bleOnCommand: 'on' } },
    }],
  }],
  deviceInfo: { brand: 'Test', seria: 'Test Series', model: 'Test Model' },
  title: 'Test Device',
};

export const controlEnvelopeFixture = {
  done: true,
  errors: null,
  data: { devices: [deviceFixture] },
};

export const offDeviceFixture = {
  ...deviceFixture,
  state: { isOn: false },
  pult: [{
    functions: [{
      ...deviceFixture.pult[0].functions[0],
      state: { isOn: false, value: 22, valueRange: [16, 30] },
    }],
  }],
};

export const offControlEnvelopeFixture = {
  done: true,
  errors: null,
  data: { devices: [offDeviceFixture] },
};

export const mqttModelFixture = {
  devices: [deviceFixture],
};

export const fanSpeedFunctionFixture = {
  id: 351,
  title: 'Fan speed',
  state: { isOn: true, value: 2, valueRange: [1, 5] },
  metaData: { bleTagInfo: { bleTag: 'fanSpeed' } },
};

export const negativeSetTempFunctionFixture = {
  id: 352,
  state: { isOn: true, value: -2, valueRange: [-10, 10] },
  metaData: { bleTagInfo: { bleTag: 'setTemp' } },
};
