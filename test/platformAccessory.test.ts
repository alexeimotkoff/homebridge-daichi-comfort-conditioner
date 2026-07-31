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
        functionFixture(364, 'powerfull', {title: 'Turbo', state: {isOn: false}, metaData: {bleTagInfo: {bleTag: 'powerfull', bleOnCommand: 'on'}}}),
      ],
    }],
    deviceInfo: {brand: 'Test', seria: 'Series', model: 'Model'},
    title: 'Test device',
    ...overrides,
  };
}

function deviceWithTurbo(isOn: boolean, overrides: Partial<Device> = {}): Device {
  const device = deviceFixture(overrides);
  return {
    ...device,
    pult: [{
      functions: device.pult[0].functions.map(pultFunction => pultFunction.id === 364
        ? {...pultFunction, state: {...pultFunction.state, isOn}}
        : pultFunction),
    }],
  };
}

async function withFakeTimers(action: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await action();
  } finally {
    vi.useRealTimers();
  }
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
    refreshDeviceState: vi.fn().mockResolvedValue(undefined),
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
    expect(controlDevice).toHaveBeenCalledTimes(1);
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.IsOn, 1, false);
    await expect(active.getHandler!()).resolves.toBe(identifiers.Active.INACTIVE);
  });

  it('logs every current function id for HAP writes beyond Active and SwingMode', async () => {
    const {identifiers, characteristics, platform} = createAccessory();
    const targetState = characteristics.get(identifiers.TargetHeaterCoolerState)!;
    Object.assign(characteristics.get(identifiers.Active)!, {iid: 10});
    Object.assign(characteristics.get(identifiers.CurrentHeaterCoolerState)!, {iid: 11});
    Object.assign(targetState, {
      UUID: '000000B2-0000-1000-8000-0026BB765291',
      iid: 12,
    });
    Object.assign(characteristics.get(identifiers.CurrentTemperature)!, {iid: 13});
    Object.assign(characteristics.get(identifiers.CoolingThresholdTemperature)!, {iid: 14});
    Object.assign(characteristics.get(identifiers.HeatingThresholdTemperature)!, {iid: 15});
    Object.assign(characteristics.get(identifiers.SwingMode)!, {iid: 16});
    Object.assign(characteristics.get(identifiers.RotationSpeed)!, {iid: 17});

    await targetState.setHandler!(identifiers.TargetHeaterCoolerState.COOL);

    expect(platform.log.debug).toHaveBeenCalledWith(
      'HAP SET: device=1001, characteristic=TargetHeaterCoolerState, ' +
      'uuid=000000B2-0000-1000-8000-0026BB765291, iid=12, value=2, ' +
      'functionIds={IsOn:1, SetTemp:2, FanFlow:3, FanSpeedAuto:4, FanSpeed:5, ' +
      'AutoMode:6, HeatMode:7, CoolMode:8, Turbo:364}, ' +
      'characteristicIids={Active:10, TargetHeaterCoolerState:12, CurrentHeaterCoolerState:11, ' +
      'CurrentTemperature:13, CoolingThresholdTemperature:14, HeatingThresholdTemperature:15, ' +
      'SwingMode:16, RotationSpeed:17}',
    );
  });

  it('logs current function and characteristic ids after a device refresh', () => {
    const {identifiers, characteristics, handler, platform} = createAccessory();
    Object.assign(characteristics.get(identifiers.Active)!, {iid: 10});
    Object.assign(characteristics.get(identifiers.CurrentHeaterCoolerState)!, {iid: 11});
    Object.assign(characteristics.get(identifiers.TargetHeaterCoolerState)!, {iid: 12});
    Object.assign(characteristics.get(identifiers.CurrentTemperature)!, {iid: 13});
    Object.assign(characteristics.get(identifiers.CoolingThresholdTemperature)!, {iid: 14});
    Object.assign(characteristics.get(identifiers.HeatingThresholdTemperature)!, {iid: 15});
    Object.assign(characteristics.get(identifiers.SwingMode)!, {iid: 16});
    Object.assign(characteristics.get(identifiers.RotationSpeed)!, {iid: 17});

    handler.logHapRefresh();

    expect(platform.log.debug).toHaveBeenCalledWith(
      'HAP REFRESH: device=1001, ' +
      'functionIds={IsOn:1, SetTemp:2, FanFlow:3, FanSpeedAuto:4, FanSpeed:5, ' +
      'AutoMode:6, HeatMode:7, CoolMode:8, Turbo:364}, ' +
      'characteristicIids={Active:10, TargetHeaterCoolerState:12, CurrentHeaterCoolerState:11, ' +
      'CurrentTemperature:13, CoolingThresholdTemperature:14, HeatingThresholdTemperature:15, ' +
      'SwingMode:16, RotationSpeed:17}, ' +
      'characteristicValues={Active:1, TargetHeaterCoolerState:0, CurrentHeaterCoolerState:1, ' +
      'CurrentTemperature:22, CoolingThresholdTemperature:22, HeatingThresholdTemperature:22, ' +
      'SwingMode:0, RotationSpeed:40}, ' +
      'state={powerState:true, curTemp:22, setTemp:22, mode:auto, fanSpeed:2, ' +
      'autoFanSpeedIsOn:false, swingMode:false, turboModeIsOn:false}',
    );
  });

  it('refreshes a missing function once and retries the original command', async () => {
    const fullDevice = deviceFixture();
    const initialDevice = deviceFixture({pult: [{
      functions: fullDevice.pult[0].functions.filter(fn => fn.id !== 8),
    }]});
    const subject = createAccessory(undefined, {device: initialDevice});
    subject.platform.refreshDeviceState.mockResolvedValueOnce(fullDevice);

    await subject.characteristics.get(subject.identifiers.TargetHeaterCoolerState)!
      .setHandler!(subject.identifiers.TargetHeaterCoolerState.COOL);

    expect(subject.platform.refreshDeviceState).toHaveBeenCalledWith(1001);
    expect(subject.controlDevice).toHaveBeenCalledWith(1001, CtrlMode.CoolMode, 8, true);
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
    platform.refreshDeviceState.mockResolvedValueOnce(device);
    const message = `Unknown functionId for device=1001, cmd=IsOn, deviceResponse=${JSON.stringify(device)}`;

    await expect(characteristics.get(identifiers.Active)!.setHandler!(identifiers.Active.INACTIVE))
      .rejects.toThrow(message);
    expect(controlDevice).not.toHaveBeenCalled();
    expect(platform.log.error).toHaveBeenCalledWith(`ctrl: ${message}`);
  });

  it('uses Promise handlers for RotationSpeed', async () => {
    const controlDevice = vi.fn().mockResolvedValue(deviceFixture());
    const {identifiers, characteristics} = createAccessory(controlDevice);
    const rotationSpeed = characteristics.get(identifiers.RotationSpeed)!;

    await expect(rotationSpeed.getHandler!()).resolves.toBe(40);
    await expect(rotationSpeed.setHandler!(60)).resolves.toBeUndefined();
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('disables active Turbo before changing the manual fan speed', async () => {
    await withFakeTimers(async () => {
      const controlDevice = vi.fn().mockResolvedValue(deviceWithTurbo(false));
      const {identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});

      const setting = characteristics.get(identifiers.RotationSpeed)!.setHandler!(60);
      await vi.runAllTimersAsync();
      await expect(setting).resolves.toBeUndefined();

      expect(controlDevice).toHaveBeenCalledTimes(2);
      expect(controlDevice).toHaveBeenNthCalledWith(1, 1001, CtrlMode.Turbo, 364, false);
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanSpeed, 5, 3);
    });
  });

  it('waits for Turbo shutdown and then one second before changing fan speed', async () => {
    await withFakeTimers(async () => {
      let completeTurbo!: (device: Device) => void;
      const controlDevice = vi.fn()
        .mockImplementationOnce(() => new Promise<Device>((resolve) => {
          completeTurbo = resolve;
        }))
        .mockResolvedValue(deviceWithTurbo(false));
      const {identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});

      const setting = characteristics.get(identifiers.RotationSpeed)!.setHandler!(60);
      await vi.advanceTimersByTimeAsync(5000);
      expect(controlDevice).toHaveBeenCalledTimes(1);

      completeTurbo(deviceWithTurbo(false));
      await vi.advanceTimersByTimeAsync(999);
      expect(controlDevice).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(setting).resolves.toBeUndefined();
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanSpeed, 5, 3);
    });
  });

  it('disables active Turbo before enabling automatic fan speed', async () => {
    await withFakeTimers(async () => {
      const controlDevice = vi.fn().mockResolvedValue(deviceWithTurbo(false));
      const {identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});

      const setting = characteristics.get(identifiers.RotationSpeed)!.setHandler!(0);
      await vi.runAllTimersAsync();
      await expect(setting).resolves.toBeUndefined();

      expect(controlDevice).toHaveBeenCalledTimes(2);
      expect(controlDevice).toHaveBeenNthCalledWith(1, 1001, CtrlMode.Turbo, 364, false);
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanSpeedAuto, 4, true);
    });
  });

  it('changes fan speed directly when Turbo is inactive or unavailable', async () => {
    const inactiveControl = vi.fn().mockResolvedValue(deviceFixture());
    const inactive = createAccessory(inactiveControl, {device: deviceWithTurbo(false)});
    const withoutTurbo = deviceFixture({pult: [{
      functions: deviceFixture().pult[0].functions.filter(pultFunction => pultFunction.id !== 364),
    }]});
    const absentControl = vi.fn().mockResolvedValue(withoutTurbo);
    const absent = createAccessory(absentControl, {device: withoutTurbo});

    await inactive.characteristics.get(inactive.identifiers.RotationSpeed)!.setHandler!(60);
    await absent.characteristics.get(absent.identifiers.RotationSpeed)!.setHandler!(60);

    expect(inactiveControl).toHaveBeenCalledTimes(1);
    expect(inactiveControl).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
    expect(absentControl).toHaveBeenCalledTimes(1);
    expect(absentControl).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('does not change fan speed when disabling Turbo fails', async () => {
    const controlDevice = vi.fn().mockRejectedValue(new Error('turbo failed'));
    const {identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});

    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(60)).rejects.toThrow('turbo failed');

    expect(controlDevice).toHaveBeenCalledTimes(1);
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.Turbo, 364, false);
  });

  it('does not disable Turbo when the displayed fan speed did not change', async () => {
    const controlDevice = vi.fn().mockResolvedValue(deviceWithTurbo(false));
    const {identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});

    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(40)).resolves.toBeUndefined();

    expect(controlDevice).not.toHaveBeenCalled();
  });

  it('uses the latest Turbo state received by the common device update path', async () => {
    await withFakeTimers(async () => {
      const controlDevice = vi.fn().mockResolvedValue(deviceWithTurbo(false));
      const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(false)});
      handler.updateDeviceState({
        id: 1001,
        pult: [{functions: [functionFixture(364, 'powerfull', {
          title: 'Turbo',
          state: {isOn: true},
          metaData: {bleTagInfo: {bleTag: 'powerfull', bleOnCommand: 'on'}},
        })]}],
      });

      const setting = characteristics.get(identifiers.RotationSpeed)!.setHandler!(60);
      await vi.runAllTimersAsync();
      await setting;

      expect(controlDevice).toHaveBeenNthCalledWith(1, 1001, CtrlMode.Turbo, 364, false);
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanSpeed, 5, 3);
    });
  });

  it('keeps the last valid Turbo state after an unusable or sparse update', async () => {
    await withFakeTimers(async () => {
      const controlDevice = vi.fn().mockResolvedValue(deviceWithTurbo(false));
      const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device: deviceWithTurbo(true)});
      handler.updateDeviceState({
        id: 1001,
        pult: [{functions: [functionFixture(364, 'powerfull', {
          title: 'Turbo',
          state: {isOn: null as never},
          metaData: {bleTagInfo: {bleTag: 'powerfull', bleOnCommand: 'on'}},
        })]}],
      });
      handler.updateDeviceState({id: 1001, curTemp: 23});

      const setting = characteristics.get(identifiers.RotationSpeed)!.setHandler!(60);
      await vi.runAllTimersAsync();
      await setting;

      expect(controlDevice).toHaveBeenNthCalledWith(1, 1001, CtrlMode.Turbo, 364, false);
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanSpeed, 5, 3);
    });
  });

  it('keeps Turbo state independent for each accessory instance', async () => {
    await withFakeTimers(async () => {
      const controlDevice = vi.fn().mockImplementation((deviceId: number) =>
        Promise.resolve(deviceId === 1001 ? deviceWithTurbo(false) : deviceWithTurbo(false, {id: 1002})));
      const first = createAccessory(controlDevice, {device: deviceWithTurbo(true)});
      const second = createAccessory(controlDevice, {device: deviceWithTurbo(false, {id: 1002})});

      await second.characteristics.get(second.identifiers.RotationSpeed)!.setHandler!(60);
      const firstSetting = first.characteristics.get(first.identifiers.RotationSpeed)!.setHandler!(60);
      await vi.runAllTimersAsync();
      await firstSetting;

      expect(controlDevice).toHaveBeenNthCalledWith(1, 1002, CtrlMode.FanSpeed, 5, 3);
      expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.Turbo, 364, false);
      expect(controlDevice).toHaveBeenNthCalledWith(3, 1001, CtrlMode.FanSpeed, 5, 3);
    });
  });

  it('reports zero RotationSpeed while the air conditioner is powered off', async () => {
    const {identifiers, characteristics} = createAccessory(undefined, {
      device: deviceFixture({state: {isOn: false}}),
    });

    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(0);
  });

  it('uses an active manual fan speed instead of a stale Auto state', async () => {
    const initialDevice = deviceFixture({pult: [{
      functions: [
        functionFixture(350, 'power', {state: {isOn: true}}),
        functionFixture(357, 'fanSpeed', {
          title: 'Auto',
          state: {isOn: true},
          metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
        }),
        functionFixture(358, 'fanSpeed', {
          title: 'Fan speed',
          state: {isOn: false, value: 1, valueRange: [1, 5]},
        }),
      ],
    }]});
    const {handler, identifiers, characteristics} = createAccessory(undefined, {device: initialDevice});

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [functionFixture(358, 'fanSpeed', {
          title: 'Fan speed',
          state: {isOn: true, value: 1, valueRange: [1, 5]},
        })],
      }],
    });

    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(20);
  });

  it('uses Auto state only from the linked function of the selected Fan speed', async () => {
    const controlDevice = vi.fn().mockResolvedValue(deviceFixture());
    const {handler, identifiers, characteristics} = createAccessory(controlDevice);

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [
          functionFixture(999, 'fanSpeed', {
            title: 'Auto',
            state: {isOn: true},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
          }),
          functionFixture(358, 'fanSpeed', {
            title: 'Fan speed',
            state: {isOn: true, value: 1, valueRange: [1, 5]},
            linkedFunction: functionFixture(357, 'fanSpeed', {
              title: 'Auto',
              state: {isOn: false},
              metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
            }),
          }),
        ],
      }],
    });

    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(20);
    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(0)).resolves.toBeUndefined();
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeedAuto, 357, true);
  });

  it.each([
    {label: 'below the range', isOn: true, value: 0},
    {label: 'above the range', isOn: true, value: 6},
    {label: 'not an integer step', isOn: true, value: 1.5},
    {label: 'reported by an inactive manual function', isOn: false, value: 1},
  ])('keeps the known manual fan speed when a new value is $label', async ({isOn, value}) => {
    const {handler, identifiers, characteristics} = createAccessory();

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [
          functionFixture(358, 'fanSpeed', {
            title: 'Fan speed',
            state: {isOn, value, valueRange: [1, 5]},
            linkedFunction: functionFixture(357, 'fanSpeed', {
              title: 'Auto',
              state: {isOn: false},
              metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
            }),
          }),
        ],
      }],
    });

    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(40);
  });

  it('reports Auto fan speed only when the selected Fan speed linked function is active', async () => {
    const {handler, identifiers, characteristics} = createAccessory();

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [
          functionFixture(358, 'fanSpeed', {
            title: 'Fan speed',
            state: {isOn: false, value: 1, valueRange: [1, 5]},
            linkedFunction: functionFixture(357, 'fanSpeed', {
              title: 'Auto',
              state: {isOn: true},
              metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
            }),
          }),
        ],
      }],
    });

    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(0);
  });

  it('keeps known characteristic state when an update contains unusable values', async () => {
    const {handler, identifiers, characteristics} = createAccessory(undefined, {
      device: deviceFixture({curTemp: 25, state: {isOn: false}}),
    });

    handler.updateDeviceState({
      id: 1001,
      curTemp: null,
      state: {isOn: null},
      pult: [{
        functions: [
          {
            id: 2,
            state: {isOn: true, value: null},
            metaData: {bleTagInfo: {bleTag: 'setTemp'}},
          },
          {
            id: 3,
            title: 'Vertical swing',
            state: {isOn: null},
            metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: 'vert_on'}},
          },
          {
            id: 4,
            title: 'Auto',
            state: {isOn: null},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
          },
          {
            id: 5,
            title: 'Fan speed',
            state: {isOn: null, value: null},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed'}},
          },
        ],
      }],
    } as never);

    handler.updateDeviceState({
      id: 1001,
      curTemp: 'invalid',
      state: {isOn: 'invalid'},
      pult: [{
        functions: [
          {
            id: 2,
            state: {isOn: true, value: 'invalid'},
            metaData: {bleTagInfo: {bleTag: 'setTemp'}},
          },
          {
            id: 3,
            title: 'Vertical swing',
            state: {isOn: 'invalid'},
            metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: 'vert_on'}},
          },
          {
            id: 4,
            title: 'Auto',
            state: {isOn: 'invalid'},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
          },
          {
            id: 5,
            title: 'Fan speed',
            state: {isOn: 'invalid', value: 'invalid', valueRange: 'invalid'},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed'}},
          },
          {
            id: 6,
            state: {isOn: 'invalid'},
            metaData: {bleTagInfo: {bleTag: 'mode', bleOnCommand: 'auto'}},
          },
        ],
      }],
    } as never);

    await expect(characteristics.get(identifiers.Active)!.getHandler!())
      .resolves.toBe(identifiers.Active.INACTIVE);
    await expect(characteristics.get(identifiers.CurrentTemperature)!.getHandler!()).resolves.toBe(25);
    await expect(characteristics.get(identifiers.CoolingThresholdTemperature)!.getHandler!()).resolves.toBe(22);
    await expect(characteristics.get(identifiers.SwingMode)!.getHandler!()).resolves.toBe(0);

    handler.updateDeviceState({id: 1001, state: {isOn: true}});

    await expect(characteristics.get(identifiers.TargetHeaterCoolerState)!.getHandler!())
      .resolves.toBe(identifiers.TargetHeaterCoolerState.AUTO);
    await expect(characteristics.get(identifiers.RotationSpeed)!.getHandler!()).resolves.toBe(40);
  });

  it('updates CurrentTemperature from a partial MQTT update while powered off', () => {
    const device = deviceFixture({curTemp: 25, state: {isOn: false}});
    const {handler, identifiers, characteristics} = createAccessory(undefined, {device});

    handler.updateDeviceState({id: 1001, curTemp: 26});

    expect(characteristics.get(identifiers.CurrentTemperature)!.updatedValues).toEqual([26]);
  });

  it('does not treat a device status as the air conditioner power state', async () => {
    const {handler, identifiers, characteristics} = createAccessory();

    handler.updateDeviceState({id: 1001, status: 'disconnected'});

    await expect(characteristics.get(identifiers.Active)!.getHandler!())
      .resolves.toBe(identifiers.Active.ACTIVE);
    await expect(characteristics.get(identifiers.CurrentHeaterCoolerState)!.getHandler!())
      .resolves.toBe(identifiers.CurrentHeaterCoolerState.IDLE);
  });

  it('learns FanSpeed and its value range from a full MQTT update', async () => {
    const initialDevice = deviceFixture({pult: [{
      functions: [functionFixture(350, 'power', {state: {isOn: true}})],
    }]});
    const updatedDevice = deviceFixture({pult: [{
      functions: [
        functionFixture(350, 'power', {state: {isOn: true}}),
        functionFixture(357, 'fanSpeed', {
          title: 'Auto',
          state: {isOn: false},
          metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
        }),
        functionFixture(358, 'fanSpeed', {
          title: 'Fan speed',
          state: {isOn: true, value: 2, valueRange: [1, 5]},
        }),
      ],
    }]});
    const controlDevice = vi.fn().mockResolvedValue(updatedDevice);
    const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device: initialDevice});

    handler.updateDeviceState(updatedDevice);
    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(60)).resolves.toBeUndefined();

    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 358, 3);
  });

  it('keeps the existing FanSpeed mapping after a partial MQTT update', async () => {
    const device = deviceFixture();
    const controlDevice = vi.fn().mockResolvedValue(device);
    const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device});

    handler.updateDeviceState({id: 1001, curTemp: 26});
    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(60)).resolves.toBeUndefined();

    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('keeps the existing FanSpeed mapping after a sparse pult update', async () => {
    const device = deviceFixture();
    const controlDevice = vi.fn().mockResolvedValue(device);
    const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device});

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [functionFixture(350, 'power', {state: {isOn: false}})],
      }],
    });
    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(60)).resolves.toBeUndefined();

    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('updates a changed FanSpeed id without dropping the existing value range', async () => {
    const device = deviceFixture();
    const controlDevice = vi.fn().mockResolvedValue(device);
    const {handler, identifiers, characteristics} = createAccessory(controlDevice, {device});

    handler.updateDeviceState({
      id: 1001,
      pult: [{
        functions: [functionFixture(358, 'fanSpeed', {
          title: 'Fan speed',
          state: {isOn: true, value: 2},
        })],
      }],
    });
    await expect(characteristics.get(identifiers.RotationSpeed)!.setHandler!(60)).resolves.toBeUndefined();

    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 358, 3);
  });

  it('processes Active and RotationSpeed sent concurrently without extra commands', async () => {
    const device = deviceFixture();
    const controlDevice = vi.fn().mockResolvedValue(device);
    const {identifiers, characteristics} = createAccessory(controlDevice, {device});

    await Promise.all([
      characteristics.get(identifiers.Active)!.setHandler!(identifiers.Active.ACTIVE),
      characteristics.get(identifiers.RotationSpeed)!.setHandler!(60),
    ]);

    expect(controlDevice).toHaveBeenCalledTimes(2);
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.IsOn, 1, true);
    expect(controlDevice).toHaveBeenCalledWith(1001, CtrlMode.FanSpeed, 5, 3);
  });

  it('uses the flow vert_on function for both SwingMode values regardless of title', async () => {
    const defaultDevice = deviceFixture();
    const device = deviceFixture({pult: [{
      functions: [
        ...defaultDevice.pult[0].functions.filter(fn => fn.id !== 3),
        functionFixture(360, 'flow', {
          title: 'Horizontal swing',
          metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: 'vert_on'}},
        }),
        functionFixture(359, 'flow', {
          title: 'Vertical swing',
          metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: 'horizont_on'}},
        }),
        functionFixture(361, 'flow', {
          title: '3D swing',
          metaData: {bleTagInfo: {bleTag: 'flow', bleOnCommand: '3d_on'}},
        }),
      ],
    }]});
    const controlDevice = vi.fn().mockResolvedValue(device);
    const {identifiers, characteristics} = createAccessory(controlDevice, {device});
    const swingMode = characteristics.get(identifiers.SwingMode)!;

    await swingMode.setHandler!(identifiers.SwingMode.SWING_ENABLED);
    await swingMode.setHandler!(identifiers.SwingMode.SWING_DISABLED);

    expect(controlDevice).toHaveBeenNthCalledWith(1, 1001, CtrlMode.FanFlow, 360, true);
    expect(controlDevice).toHaveBeenNthCalledWith(2, 1001, CtrlMode.FanFlow, 360, false);
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
      [CtrlMode.Turbo, expect.objectContaining({id: 364})],
    ]));
  });
});
