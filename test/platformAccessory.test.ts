import {describe, expect, it, vi} from 'vitest';

import {DaichiComfortPlatformAccessory} from '../src/platformAccessory';
import {CtrlMode} from '../src/models/ctrlMode';
import {Device, PultFunction} from '../src/models/deviceModel';

type GetHandler = () => Promise<unknown>;
type SetHandler = (value: unknown) => Promise<void>;

class FakeCharacteristic {
  public getHandler: GetHandler | undefined;
  public setHandler: SetHandler | undefined;
  public readonly updatedValues: unknown[] = [];

  onGet(handler: GetHandler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: SetHandler) {
    this.setHandler = handler;
    return this;
  }

  removeOnGet() {
    this.getHandler = undefined;
    return this;
  }

  removeOnSet() {
    this.setHandler = undefined;
    return this;
  }

  on() {
    return this;
  }

  setProps() {
    return this;
  }

  updateValue(value: unknown) {
    this.updatedValues.push(value);
    return this;
  }
}

function functionFixture(id: number, bleTag: string, options: Partial<PultFunction> = {}): PultFunction {
  return {
    id,
    state: {isOn: false},
    metaData: {bleTagInfo: {bleTag}},
    ...options,
  };
}

function deviceFixture(overrides: Partial<Device> = {}): Device {
  return {
    id: 1001,
    serial: 'TEST-SERIAL',
    status: 'connected',
    curTemp: 22,
    state: {isOn: true},
    pult: [{
      functions: [
        functionFixture(1, 'power', {state: {isOn: true}}),
        functionFixture(2, 'setTemp', {state: {isOn: true, value: 22, valueRange: [16, 30]}}),
        functionFixture(3, 'flow', {title: 'Vertical swing', state: {isOn: false}, metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: 'vert_on'}}}),
        functionFixture(4, 'fanSpeed', {title: 'Auto', state: {isOn: false}, metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}}}),
        functionFixture(5, 'fanSpeed', {title: 'Fan speed', state: {isOn: true, value: 2, valueRange: [1, 5]}}),
        functionFixture(6, 'mode', {state: {isOn: true}, metaData: {bleTagInfo: {bleTag: 'mode', bleOnCommand: 'auto'}}}),
        functionFixture(7, 'mode', {title: 'Heat', state: {isOn: false}, metaData: {bleTagInfo: {bleTag: 'mode', bleOnCommand: 'heat'}}}),
        functionFixture(8, 'mode', {title: 'Cool', state: {isOn: false}, metaData: {bleTagInfo: {bleTag: 'mode', bleOnCommand: 'cool'}}}),
      ],
    }],
    deviceInfo: {brand: 'Test', seria: 'Series', model: 'Model'},
    title: 'Test device',
    ...overrides,
  };
}

function createAccessory(
  controlDevice = vi.fn().mockResolvedValue(deviceFixture()),
  options: { activate?: boolean; heaterServiceExists?: boolean; device?: Device } = {},
) {
  const identifiers = {
    AccessoryInformation: Symbol('AccessoryInformation'),
    HeaterCooler: Symbol('HeaterCooler'),
    Manufacturer: Symbol('Manufacturer'),
    Model: Symbol('Model'),
    SerialNumber: Symbol('SerialNumber'),
    Name: Symbol('Name'),
    Active: Object.assign(Symbol('Active'), {ACTIVE: 1, INACTIVE: 0}),
    TargetHeaterCoolerState: Object.assign(Symbol('TargetHeaterCoolerState'), {AUTO: 0, HEAT: 1, COOL: 2}),
    CurrentHeaterCoolerState: Object.assign(Symbol('CurrentHeaterCoolerState'), {INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3}),
    CurrentTemperature: Symbol('CurrentTemperature'),
    CoolingThresholdTemperature: Symbol('CoolingThresholdTemperature'),
    HeatingThresholdTemperature: Symbol('HeatingThresholdTemperature'),
    SwingMode: Object.assign(Symbol('SwingMode'), {SWING_ENABLED: 1, SWING_DISABLED: 0}),
    RotationSpeed: Symbol('RotationSpeed'),
  };
  const characteristics = new Map<symbol, FakeCharacteristic>();
  const getCharacteristic = (identifier: symbol) => {
    let characteristic = characteristics.get(identifier);
    if (!characteristic) {
      characteristic = new FakeCharacteristic();
      characteristics.set(identifier, characteristic);
    }
    return characteristic;
  };
  const service = {
    getCharacteristic,
    setCharacteristic: vi.fn().mockReturnThis(),
  };
  const accessory = {
    getService: vi.fn((identifier: symbol) => identifier === identifiers.AccessoryInformation ||
      (identifier === identifiers.HeaterCooler && options.heaterServiceExists !== false) ? service : undefined),
    addService: vi.fn(() => service),
    removeService: vi.fn(),
  };
  const getCtrlApi = vi.fn(() => ({controlDevice}));
  const platform = {
    Service: identifiers,
    Characteristic: identifiers,
    log: {debug: vi.fn(), error: vi.fn()},
    getCtrlApi,
  };

  const InactiveAccessory = DaichiComfortPlatformAccessory as unknown as new (
    platform: unknown,
    accessory: unknown,
    device: Device,
    activate: boolean,
  ) => DaichiComfortPlatformAccessory;
  const device = options.device ?? deviceFixture();
  const handler = new InactiveAccessory(platform, accessory, device, options.activate ?? true);

  return {identifiers, characteristics, controlDevice, getCtrlApi, handler, accessory, platform, service, device};
}

describe('DaichiComfortPlatformAccessory promise handlers', () => {
  it('defers Homebridge binding until activation and removes its created service on deactivation', () => {
    const {identifiers, characteristics, handler, accessory} = createAccessory(undefined, {
      activate: false,
      heaterServiceExists: false,
    });

    expect(accessory.getService).not.toHaveBeenCalled();
    handler.activate();
    expect(characteristics.get(identifiers.Active)?.getHandler).toBeTypeOf('function');

    handler.deactivate();

    expect(characteristics.get(identifiers.Active)?.getHandler).toBeUndefined();
    expect(accessory.removeService).toHaveBeenCalledTimes(1);
  });

  it('keeps another handler callbacks intact and restores its own callbacks on forced rebind', () => {
    const {identifiers, characteristics, handler: firstHandler, accessory, platform, device} = createAccessory(undefined, {
      activate: false,
      heaterServiceExists: true,
    });
    firstHandler.activate();
    const active = characteristics.get(identifiers.Active)!;
    const InactiveAccessory = DaichiComfortPlatformAccessory as unknown as new (
      platform: unknown,
      accessory: unknown,
      device: Device,
      activate: boolean,
    ) => DaichiComfortPlatformAccessory;
    const secondHandler = new InactiveAccessory(platform, accessory, device, false);
    secondHandler.activate();
    const secondGetHandler = active.getHandler;

    firstHandler.deactivate();

    expect(active.getHandler).toBe(secondGetHandler);
    secondHandler.deactivate();
    firstHandler.activate(true);

    expect(active.getHandler).toBeTypeOf('function');
    expect(active.getHandler).not.toBe(secondGetHandler);
  });

  it('preserves a handler-owned HeaterCooler service through forced rebind', () => {
    const {handler, accessory} = createAccessory(undefined, {activate: false, heaterServiceExists: false});
    handler.activate();

    handler.activate(true);

    expect(accessory.addService).toHaveBeenCalledTimes(1);
    expect(accessory.removeService).not.toHaveBeenCalled();
  });

  it('registers Active through onGet and onSet', async () => {
    const {identifiers, characteristics, getCtrlApi} = createAccessory();
    const active = characteristics.get(identifiers.Active)!;

    expect(active.getHandler).toBeTypeOf('function');
    expect(active.setHandler).toBeTypeOf('function');
    expect(getCtrlApi).not.toHaveBeenCalled();
    await expect(active.getHandler!()).resolves.toBe(identifiers.Active.ACTIVE);
  });

  it('awaits Active control, returns void, and applies the returned device state', async () => {
    let completeControl: (device: Device) => void = () => undefined;
    const controlDevice = vi.fn(() => new Promise<Device>(resolve => {
      completeControl = resolve;
    }));
    const {identifiers, characteristics} = createAccessory(controlDevice);
    const active = characteristics.get(identifiers.Active)!;

    const setting = active.setHandler!(identifiers.Active.INACTIVE);
    await expect(Promise.race([setting.then(() => 'done'), Promise.resolve('pending')])).resolves.toBe('pending');

    completeControl(deviceFixture({state: {isOn: false}}));

    await expect(setting).resolves.toBeUndefined();
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.IsOn, 1, false);
    await expect(active.getHandler!()).resolves.toBe(identifiers.Active.INACTIVE);
  });

  it('propagates control failures from Active onSet', async () => {
    const controlDevice = vi.fn().mockRejectedValue(new Error('control failed'));
    const {identifiers, characteristics} = createAccessory(controlDevice);

    await expect(characteristics.get(identifiers.Active)!.setHandler!(identifiers.Active.INACTIVE)).rejects.toThrow('control failed');
  });

  it('rejects Active onSet safely when the power function is missing', async () => {
    const device = deviceFixture({pult: [{
      functions: deviceFixture().pult[0].functions.filter(fn => fn.id !== 1),
    }]});
    const {identifiers, characteristics, controlDevice, platform} = createAccessory(undefined, {device});

    await expect(characteristics.get(identifiers.Active)!.setHandler!(identifiers.Active.INACTIVE))
      .rejects.toThrow('Unknown functionId for device=1001, cmd=IsOn');
    expect(controlDevice).not.toHaveBeenCalled();
    expect(platform.log.error).toHaveBeenCalledWith('ctrl: Unknown functionId for device=1001, cmd=IsOn');
  });

  it('uses Promise handlers for RotationSpeed', async () => {
    const controlDevice = vi.fn().mockResolvedValue(deviceFixture());
    const {identifiers, characteristics} = createAccessory(controlDevice);
    const rotationSpeed = characteristics.get(identifiers.RotationSpeed)!;

    await expect(rotationSpeed.getHandler!()).resolves.toBe(40);
    await expect(rotationSpeed.setHandler!(60)).resolves.toBeUndefined();
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('keeps the existing function selection unchanged', () => {
    const functions = DaichiComfortPlatformAccessory.getFunctionsDict(deviceFixture());

    expect(functions).toEqual(new Map([
      [CtrlMode.IsOn, expect.objectContaining({id: 1})],
      [CtrlMode.SetTemp, expect.objectContaining({id: 2})],
      [CtrlMode.FanFlow, expect.objectContaining({id: 3})],
      [CtrlMode.FanSpeedAuto, expect.objectContaining({id: 4})],
      [CtrlMode.FanSpeed, expect.objectContaining({id: 5})],
      [CtrlMode.AutoMode, expect.objectContaining({id: 6})],
      [CtrlMode.HeatMode, expect.objectContaining({id: 7})],
      [CtrlMode.CoolMode, expect.objectContaining({id: 8})],
    ]));
  });
});
