import { describe, expect, it, vi } from 'vitest';

import { DaichiComfortHomebridgePlatform } from '../src/platform';
import { DaichiComfortPlatformAccessory } from '../src/platformAccessory';
import { Device } from '../src/models/deviceModel';
import { MqttUser } from '../src/models/mqttUser';

type EventHandler = () => void;

function deviceFixture(overrides: Partial<Device> = {}): Device {
  return {
    id: 1001,
    serial: 'TEST-SERIAL',
    status: 'connected',
    curTemp: 22,
    state: { isOn: true },
    pult: [],
    deviceInfo: undefined,
    title: 'Test device',
    ...overrides,
  };
}

function createPlatform(options: {
  devices?: Device[];
  cached?: Array<{ UUID: string; displayName: string; context: Record<string, unknown> }>;
  loginError?: Error;
  loadMqttUserError?: Error;
  getDevicesError?: Error;
  mqttStartError?: Error;
  configDevices?: string[];
  createAccessoryHandler?: (
    platform: DaichiComfortHomebridgePlatform,
    accessory: unknown,
    device: Device,
  ) => { updateDeviceState: (device: Device) => void; activate?: () => void };
} = {}) {
  const eventHandlers = new Map<string, EventHandler>();
  const registered: unknown[][] = [];
  const unregistered: unknown[][] = [];
  const createdAccessories: Array<{ UUID: string; displayName: string; context: Record<string, unknown> }> = [];
  const handlerByDeviceId = new Map<number, {
    updateDeviceState: ReturnType<typeof vi.fn>;
    logHapRefresh: ReturnType<typeof vi.fn>;
  }>();
  let mqttHandler: ((device: Device) => void) | undefined;

  const httpApi = {
    login: options.loginError ? vi.fn().mockRejectedValue(options.loginError) : vi.fn().mockResolvedValue(undefined),
    loadMqttUser: options.loadMqttUserError
      ? vi.fn().mockRejectedValue(options.loadMqttUserError)
      : vi.fn().mockResolvedValue(new MqttUser('mqtt-user', 'mqtt-password', 7)),
    getDevices: options.getDevicesError
      ? vi.fn().mockRejectedValue(options.getDevicesError)
      : vi.fn().mockResolvedValue(options.devices ?? [deviceFixture()]),
    getDevice: vi.fn((id: number) => Promise.resolve(deviceFixture({ id }))),
    controlDevice: vi.fn(),
  };
  const mqttClient = {
    start: vi.fn((_user: MqttUser, onDeviceUpdate: (device: Device) => void) => {
      mqttHandler = onDeviceUpdate;
      if (options.mqttStartError) {
        throw options.mqttStartError;
      }
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const dependencies = {
    httpApi,
    mqttClient,
    createAccessoryHandler: vi.fn(options.createAccessoryHandler ?? ((_platform: unknown, _accessory: unknown, device: Device) => {
      const handler = {
        updateDeviceState: vi.fn(),
        logHapRefresh: vi.fn(),
      };
      handlerByDeviceId.set(device.id, handler);
      return handler;
    })),
  };
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: vi.fn((serial: string) => `uuid:${serial}`) },
    },
    on: vi.fn((event: string, handler: EventHandler) => eventHandlers.set(event, handler)),
    platformAccessory: vi.fn(function(this: unknown, displayName: string, UUID: string) {
      const accessory = { displayName, UUID, context: {} };
      createdAccessories.push(accessory);
      return accessory;
    }),
    registerPlatformAccessories: vi.fn((_plugin: string, _platform: string, accessories: unknown[]) => registered.push(accessories)),
    unregisterPlatformAccessories: vi.fn((_plugin: string, _platform: string, accessories: unknown[]) => unregistered.push(accessories)),
  };
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const config = {
    name: 'Daichi Comfort',
    username: 'user@example.test',
    password: 'password',
    devices: options.configDevices?.map((name) => ({ name })),
  };
  const platform = new DaichiComfortHomebridgePlatform(log as never, config, api as never, dependencies);
  for (const accessory of options.cached ?? []) {
    platform.configureAccessory(accessory as never);
  }

  return {
    api,
    createdAccessories,
    dependencies,
    eventHandlers,
    handlerByDeviceId,
    httpApi,
    log,
    mqttClient,
    platform,
    registered,
    unregistered,
    sendMqtt: (device: Device) => mqttHandler?.(device),
  };
}

describe('DaichiComfortHomebridgePlatform discovery lifecycle', () => {
  it('refreshes device state every five minutes and stops refreshing on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const subject = createPlatform();
      await subject.platform.discoverDevices();
      const refreshedDevice = deviceFixture({ curTemp: 26 });
      subject.httpApi.getDevice.mockResolvedValueOnce(refreshedDevice);

      await vi.advanceTimersByTimeAsync(300_000);

      expect(subject.httpApi.getDevice).toHaveBeenCalledWith(1001);
      expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState).toHaveBeenCalledWith(refreshedDevice);
      expect(subject.handlerByDeviceId.get(1001)?.logHapRefresh).toHaveBeenCalledOnce();

      subject.eventHandlers.get('shutdown')?.();
      subject.httpApi.getDevice.mockClear();
      await vi.advanceTimersByTimeAsync(300_000);

      expect(subject.httpApi.getDevice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new refresh when discovery replaces a handler during an older refresh', async () => {
    const subject = createPlatform();
    await subject.platform.discoverDevices();
    let resolveOldRefresh: (device: Device) => void = () => undefined;
    subject.httpApi.getDevice.mockImplementationOnce(() => new Promise<Device>((resolve) => {
      resolveOldRefresh = resolve;
    }));
    const oldRefresh = subject.platform.refreshDeviceState(1001);

    await subject.platform.discoverDevices();
    const newHandler = subject.handlerByDeviceId.get(1001)!;
    const refreshedDevice = deviceFixture({ curTemp: 27 });
    subject.httpApi.getDevice.mockResolvedValueOnce(refreshedDevice);
    const newRefresh = subject.platform.refreshDeviceState(1001);
    const getDeviceCallCount = subject.httpApi.getDevice.mock.calls.length;

    resolveOldRefresh(deviceFixture({ curTemp: 23 }));
    const [, newRefreshResult] = await Promise.all([oldRefresh, newRefresh]);

    expect(getDeviceCallCount).toBe(2);
    expect(newHandler.updateDeviceState).toHaveBeenCalledWith(refreshedDevice);
    expect(newRefreshResult).toEqual(refreshedDevice);
  });

  it('reuses a cached accessory without unregistering or registering it', async () => {
    const cached = { UUID: 'uuid:TEST-SERIAL', displayName: 'Old name', context: {} };
    const subject = createPlatform({ cached: [cached] });

    await subject.platform.discoverDevices();

    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
    expect(subject.dependencies.createAccessoryHandler).toHaveBeenCalledWith(subject.platform, cached, expect.objectContaining({ id: 1001 }));
    expect(cached.context.device).toEqual(expect.objectContaining({ id: 1001 }));
  });

  it('registers a genuinely new device and retains its serial UUID', async () => {
    const subject = createPlatform();

    await subject.platform.discoverDevices();

    expect(subject.api.hap.uuid.generate).toHaveBeenCalledWith('TEST-SERIAL');
    expect(subject.createdAccessories).toEqual([expect.objectContaining({ UUID: 'uuid:TEST-SERIAL' })]);
    expect(subject.registered).toHaveLength(1);
    expect(subject.unregistered).toEqual([]);
  });

  it('publishes both account devices when the configured device list is empty', async () => {
    const firstDevice = deviceFixture({
      id: 1001,
      serial: 'FIRST-SERIAL',
      title: 'Living room',
    });
    const secondDevice = deviceFixture({
      id: 1002,
      serial: 'SECOND-SERIAL',
      title: 'Bedroom',
    });
    const subject = createPlatform({
      devices: [firstDevice, secondDevice],
      configDevices: [],
    });

    await subject.platform.discoverDevices();

    expect(subject.createdAccessories).toEqual([
      expect.objectContaining({UUID: 'uuid:FIRST-SERIAL', displayName: 'Living room'}),
      expect.objectContaining({UUID: 'uuid:SECOND-SERIAL', displayName: 'Bedroom'}),
    ]);
    expect(subject.registered).toHaveLength(1);
    expect(subject.registered[0]).toHaveLength(2);
    expect(subject.handlerByDeviceId.has(1001)).toBe(true);
    expect(subject.handlerByDeviceId.has(1002)).toBe(true);
    expect(subject.platform.accessories).toHaveLength(2);
  });

  it('periodically refreshes both account devices independently', async () => {
    vi.useFakeTimers();
    try {
      const firstDevice = deviceFixture({
        id: 1001,
        serial: 'FIRST-SERIAL',
        title: 'Living room',
      });
      const secondDevice = deviceFixture({
        id: 1002,
        serial: 'SECOND-SERIAL',
        title: 'Bedroom',
      });
      const subject = createPlatform({devices: [firstDevice, secondDevice]});

      await subject.platform.discoverDevices();
      subject.httpApi.getDevice.mockClear();
      await vi.advanceTimersByTimeAsync(300_000);

      expect(subject.httpApi.getDevice).toHaveBeenCalledTimes(2);
      expect(subject.httpApi.getDevice).toHaveBeenCalledWith(1001);
      expect(subject.httpApi.getDevice).toHaveBeenCalledWith(1002);
      expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState)
        .toHaveBeenCalledWith(expect.objectContaining({id: 1001}));
      expect(subject.handlerByDeviceId.get(1002)?.updateDeviceState)
        .toHaveBeenCalledWith(expect.objectContaining({id: 1002}));
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes, routes MQTT, and periodically refreshes only the configured device', async () => {
    vi.useFakeTimers();
    try {
      const firstDevice = deviceFixture({
        id: 1001,
        serial: 'FIRST-SERIAL',
        title: 'Living room',
      });
      const secondDevice = deviceFixture({
        id: 1002,
        serial: 'SECOND-SERIAL',
        title: 'Bedroom',
      });
      const subject = createPlatform({
        devices: [firstDevice, secondDevice],
        configDevices: ['Living room'],
      });

      await subject.platform.discoverDevices();

      expect(subject.createdAccessories).toEqual([
        expect.objectContaining({UUID: 'uuid:FIRST-SERIAL', displayName: 'Living room'}),
      ]);
      expect(subject.registered).toHaveLength(1);
      expect(subject.registered[0]).toHaveLength(1);
      expect(subject.handlerByDeviceId.has(1001)).toBe(true);
      expect(subject.handlerByDeviceId.has(1002)).toBe(false);

      subject.sendMqtt({...firstDevice, curTemp: 18});
      subject.sendMqtt({...secondDevice, curTemp: 19});

      expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState)
        .toHaveBeenCalledOnce();
      expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState)
        .toHaveBeenCalledWith(expect.objectContaining({id: 1001, curTemp: 18}));
      expect(subject.log.debug).toHaveBeenCalledWith('Ignored MQTT update for unknown device: 1002');

      subject.httpApi.getDevice.mockClear();
      await vi.advanceTimersByTimeAsync(300_000);

      expect(subject.httpApi.getDevice).toHaveBeenCalledTimes(1);
      expect(subject.httpApi.getDevice).toHaveBeenCalledWith(1001);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a cached account device excluded by the configured device list', async () => {
    const firstDevice = deviceFixture({
      id: 1001,
      serial: 'FIRST-SERIAL',
      title: 'Living room',
    });
    const secondDevice = deviceFixture({
      id: 1002,
      serial: 'SECOND-SERIAL',
      title: 'Bedroom',
    });
    const firstCached = {UUID: 'uuid:FIRST-SERIAL', displayName: 'Living room', context: {}};
    const secondCached = {UUID: 'uuid:SECOND-SERIAL', displayName: 'Bedroom', context: {}};
    const subject = createPlatform({
      devices: [firstDevice, secondDevice],
      configDevices: ['Living room'],
      cached: [firstCached, secondCached],
    });

    await subject.platform.discoverDevices();

    expect(subject.createdAccessories).toEqual([]);
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([[secondCached]]);
    expect(subject.platform.accessories).toEqual([firstCached]);
    expect(subject.handlerByDeviceId.has(1001)).toBe(true);
    expect(subject.handlerByDeviceId.has(1002)).toBe(false);
  });

  it('removes cached accessories absent after successful discovery, including an empty filtered result', async () => {
    const stale = { UUID: 'uuid:STALE', displayName: 'Stale', context: {} };
    const subject = createPlatform({
      cached: [stale],
      configDevices: ['Another device'],
    });

    await subject.platform.discoverDevices();

    expect(subject.unregistered).toEqual([[stale]]);
  });

  it('keeps cached accessories when discovery fails', async () => {
    const cached = { UUID: 'uuid:TEST-SERIAL', displayName: 'Cached', context: {} };
    const subject = createPlatform({ cached: [cached], getDevicesError: new Error('SECRET_DEVICES') });

    await subject.platform.discoverDevices();

    expect(subject.unregistered).toEqual([]);
    expect(subject.log.error).toHaveBeenCalledWith('Device discovery failed: devices');
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain('SECRET_DEVICES');
  });

  it.each([
    ['login', 'login', 'SECRET_LOGIN', { loginError: new Error('SECRET_LOGIN') }],
    ['MQTT user load', 'mqtt credentials', 'SECRET_MQTT_USER', { loadMqttUserError: new Error('SECRET_MQTT_USER') }],
  ])('keeps cached accessories when %s fails', async (_description, stage, secret, failure) => {
    const cached = { UUID: 'uuid:TEST-SERIAL', displayName: 'Cached', context: {} };
    const subject = createPlatform({ cached: [cached], ...failure });

    await subject.platform.discoverDevices();

    expect(subject.unregistered).toEqual([]);
    expect(subject.registered).toEqual([]);
    expect(subject.log.error).toHaveBeenCalledWith(`Device discovery failed: ${stage}`);
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain(secret);
  });

  it('keeps cached accessories intact when MQTT start throws', async () => {
    const stale = { UUID: 'uuid:STALE', displayName: 'Stale', context: {} };
    const subject = createPlatform({ cached: [stale], mqttStartError: new Error('SECRET_MQTT_START') });

    await subject.platform.discoverDevices();

    expect(subject.mqttClient.start).toHaveBeenCalledTimes(1);
    expect(subject.unregistered).toEqual([]);
    expect(subject.registered).toEqual([]);
    expect(subject.log.error).toHaveBeenCalledWith('Device discovery failed: mqtt start');
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain('SECRET_MQTT_START');
  });

  it('removes duplicate cached UUIDs but retains the first cached accessory', async () => {
    const canonical = { UUID: 'uuid:TEST-SERIAL', displayName: 'Canonical', context: {} };
    const duplicate = { UUID: 'uuid:TEST-SERIAL', displayName: 'Duplicate', context: {} };
    const subject = createPlatform({ cached: [canonical, duplicate] });

    await subject.platform.discoverDevices();

    expect(subject.dependencies.createAccessoryHandler).toHaveBeenCalledWith(subject.platform, canonical, expect.any(Object));
    expect(subject.unregistered).toEqual([[duplicate]]);
    expect(subject.registered).toEqual([]);
  });

  it('keeps duplicate cached UUIDs when discovery fails', async () => {
    const canonical = { UUID: 'uuid:TEST-SERIAL', displayName: 'Canonical', context: {} };
    const duplicate = { UUID: 'uuid:TEST-SERIAL', displayName: 'Duplicate', context: {} };
    const subject = createPlatform({ cached: [canonical, duplicate], getDevicesError: new Error('upstream failure') });

    await subject.platform.discoverDevices();

    expect(subject.unregistered).toEqual([]);
  });

  it('retains previous routing and cached accessories when handler creation throws', async () => {
    const firstDevice = deviceFixture();
    const subject = createPlatform({ devices: [firstDevice] });
    await subject.platform.discoverDevices();
    const previousHandler = subject.handlerByDeviceId.get(firstDevice.id)!;
    subject.httpApi.getDevices.mockResolvedValueOnce([deviceFixture({ id: 1002, serial: 'SECOND-SERIAL' })]);
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => {
      throw new Error('handler failed');
    });

    await subject.platform.discoverDevices();
    subject.sendMqtt({ ...firstDevice, curTemp: 18 });

    expect(previousHandler.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ curTemp: 18 }));
    expect(subject.unregistered).toEqual([]);
    expect(subject.registered).toHaveLength(1);
  });

  it('starts one MQTT client after successful discovery and routes each device update by id', async () => {
    const firstDevice = deviceFixture({id: 1001, serial: 'FIRST-SERIAL', curTemp: 22});
    const secondDevice = deviceFixture({id: 1002, serial: 'SECOND-SERIAL', curTemp: 21});
    const subject = createPlatform({devices: [firstDevice, secondDevice]});

    await subject.platform.discoverDevices();
    await subject.platform.discoverDevices();
    subject.sendMqtt({...firstDevice, curTemp: 18});
    subject.sendMqtt({...secondDevice, curTemp: 19});

    expect(subject.mqttClient.start).toHaveBeenCalledTimes(1);
    expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState)
      .toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id: 1001, curTemp: 18}));
    expect(subject.handlerByDeviceId.get(1002)?.updateDeviceState)
      .toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id: 1002, curTemp: 19}));
  });

  it('ignores an MQTT update for an unknown device id', async () => {
    const subject = createPlatform();
    await subject.platform.discoverDevices();

    subject.sendMqtt(deviceFixture({ id: 9999, serial: 'UNKNOWN' }));

    expect(subject.handlerByDeviceId.get(1001)?.updateDeviceState).not.toHaveBeenCalled();
    expect(subject.log.debug).toHaveBeenCalledWith('Ignored MQTT update for unknown device: 9999');
  });

  it('stops MQTT cleanly on Homebridge shutdown', async () => {
    const subject = createPlatform();
    await subject.platform.discoverDevices();

    subject.eventHandlers.get('shutdown')?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subject.mqttClient.stop).toHaveBeenCalledTimes(1);
  });

  it('does not mutate accessories or start MQTT when shutdown wins a pending discovery race', async () => {
    const stale = { UUID: 'uuid:STALE', displayName: 'Stale', context: {} };
    const subject = createPlatform({ cached: [stale] });
    let resolveDevices: (devices: Device[]) => void = () => undefined;
    let signalGetDevices: () => void = () => undefined;
    const getDevicesStarted = new Promise<void>((resolve) => {
      signalGetDevices = resolve;
    });
    subject.httpApi.getDevices.mockImplementationOnce(() => new Promise<Device[]>((resolve) => {
      resolveDevices = resolve;
      signalGetDevices();
    }));

    const discovery = subject.platform.discoverDevices();
    await getDevicesStarted;
    subject.eventHandlers.get('shutdown')?.();
    resolveDevices([deviceFixture()]);
    await discovery;

    expect(subject.mqttClient.start).not.toHaveBeenCalled();
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
  });

  it('stops MQTT if shutdown is raised synchronously while MQTT starts', async () => {
    const subject = createPlatform();
    subject.mqttClient.start.mockImplementationOnce(() => {
      subject.eventHandlers.get('shutdown')?.();
    });

    await subject.platform.discoverDevices();
    await Promise.resolve();

    expect(subject.mqttClient.stop).toHaveBeenCalledTimes(1);
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
  });

  it('catches a rejected MQTT stop on shutdown', async () => {
    const subject = createPlatform();
    await subject.platform.discoverDevices();
    subject.mqttClient.stop.mockRejectedValueOnce(new Error('stop failed'));

    subject.eventHandlers.get('shutdown')?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subject.log.warn).toHaveBeenCalledWith('Failed to stop MQTT client');
  });

  it('lets only the latest concurrent discovery commit accessories, routing, and MQTT', async () => {
    const stale = { UUID: 'uuid:STALE', displayName: 'Stale', context: {} };
    const firstDevice = deviceFixture({ id: 1001, serial: 'FIRST-SERIAL' });
    const secondDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL' });
    const subject = createPlatform({ cached: [stale] });
    let resolveFirstDevices: (devices: Device[]) => void = () => undefined;
    let firstGetDevicesStarted: () => void = () => undefined;
    const firstGetDevices = new Promise<void>((resolve) => {
      firstGetDevicesStarted = resolve;
    });
    subject.httpApi.getDevices
      .mockImplementationOnce(() => new Promise<Device[]>((resolve) => {
        resolveFirstDevices = resolve;
        firstGetDevicesStarted();
      }))
      .mockResolvedValueOnce([secondDevice]);

    const slowDiscovery = subject.platform.discoverDevices();
    await firstGetDevices;
    await subject.platform.discoverDevices();
    resolveFirstDevices([firstDevice]);
    await slowDiscovery;
    subject.sendMqtt({ ...secondDevice, curTemp: 19 });

    expect(subject.mqttClient.start).toHaveBeenCalledTimes(1);
    expect(subject.createdAccessories).toEqual([expect.objectContaining({ UUID: 'uuid:SECOND-SERIAL' })]);
    expect(subject.registered).toHaveLength(1);
    expect(subject.unregistered).toEqual([[stale]]);
    expect(subject.handlerByDeviceId.get(1002)?.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ curTemp: 19 }));
    expect(subject.handlerByDeviceId.get(1001)).toBeUndefined();
  });

  it('does not mutate a cached accessory before successful MQTT start with the real inactive handler', async () => {
    const service = {
      getCharacteristic: vi.fn(() => ({
        onGet: vi.fn().mockReturnThis(),
        onSet: vi.fn().mockReturnThis(),
        setProps: vi.fn().mockReturnThis(),
        updateValue: vi.fn(),
      })),
      setCharacteristic: vi.fn().mockReturnThis(),
    };
    const cached = {
      UUID: 'uuid:TEST-SERIAL',
      displayName: 'Cached name',
      context: {},
      getService: vi.fn(() => service),
      addService: vi.fn(() => service),
    };
    const subject = createPlatform({
      cached: [cached],
      mqttStartError: new Error('MQTT failed'),
      createAccessoryHandler: (platform, accessory, device) => {
        const InactiveAccessory = DaichiComfortPlatformAccessory as unknown as new (
          platform: DaichiComfortHomebridgePlatform,
          accessory: unknown,
          device: Device,
          activate: boolean,
        ) => DaichiComfortPlatformAccessory;
        return new InactiveAccessory(platform, accessory, device, false);
      },
    });

    await subject.platform.discoverDevices();

    expect(cached.context).toEqual({});
    expect(cached.getService).not.toHaveBeenCalled();
    expect(cached.addService).not.toHaveBeenCalled();
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
  });

  it('preserves the previous platform state when handler activation fails', async () => {
    const firstDevice = deviceFixture();
    const subject = createPlatform({ devices: [firstDevice] });
    await subject.platform.discoverDevices();
    const previousHandler = subject.handlerByDeviceId.get(firstDevice.id)!;
    const secondDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL' });
    subject.httpApi.getDevices.mockResolvedValueOnce([secondDevice]);
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => ({
      updateDeviceState: vi.fn(),
      activate: () => {
        throw new Error('SECRET_ACTIVATION');
      },
    }));

    await subject.platform.discoverDevices();
    subject.sendMqtt({ ...firstDevice, curTemp: 17 });

    expect(previousHandler.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ curTemp: 17 }));
    expect(subject.registered).toHaveLength(1);
    expect(subject.unregistered).toEqual([]);
    expect(subject.log.error).toHaveBeenCalledWith('Device discovery failed: activation');
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain('SECRET_ACTIVATION');
  });

  it('compensates a failed registration without publishing local state and stops newly-started MQTT', async () => {
    const cachedDevice = deviceFixture({ id: 9000, serial: 'STALE-SERIAL', title: 'Cached title' });
    const cached = {
      UUID: 'uuid:STALE-SERIAL',
      displayName: 'Cached title',
      context: { device: cachedDevice },
    };
    const nextDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL', title: 'New title' });
    const nextHandler = { updateDeviceState: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
    const subject = createPlatform({ cached: [cached], devices: [nextDevice] });
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => nextHandler);
    subject.api.registerPlatformAccessories.mockImplementationOnce(() => {
      throw new Error('SECRET_REGISTER');
    });

    await subject.platform.discoverDevices();

    const created = subject.createdAccessories[0];
    expect(subject.platform.accessories).toEqual([cached]);
    expect(cached.context.device).toBe(cachedDevice);
    expect(cached.displayName).toBe('Cached title');
    expect(nextHandler.deactivate).toHaveBeenCalledTimes(1);
    expect(subject.api.unregisterPlatformAccessories).toHaveBeenCalledWith(expect.any(String), expect.any(String), [created]);
    expect(subject.mqttClient.stop).toHaveBeenCalledTimes(1);
    expect(subject.log.error).toHaveBeenCalledWith('Device discovery failed: cache commit');
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain('SECRET_REGISTER');
  });

  it('compensates failed stale removal and preserves prior routing without stopping running MQTT', async () => {
    const firstDevice = deviceFixture();
    const secondDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL', title: 'Second title' });
    const subject = createPlatform({ devices: [firstDevice] });
    await subject.platform.discoverDevices();
    const previousAccessory = subject.platform.accessories[0] as unknown as {
      displayName: string;
      context: { device: Device };
    };
    const previousHandler = subject.handlerByDeviceId.get(firstDevice.id)!;
    const nextHandler = { updateDeviceState: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
    subject.httpApi.getDevices.mockResolvedValueOnce([secondDevice]);
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => nextHandler);
    subject.api.unregisterPlatformAccessories.mockImplementationOnce(() => {
      throw new Error('SECRET_UNREGISTER');
    });

    await subject.platform.discoverDevices();
    subject.sendMqtt({ ...firstDevice, curTemp: 15 });

    const newAccessory = subject.createdAccessories[1];
    expect(subject.platform.accessories).toEqual([previousAccessory]);
    expect(previousAccessory.context.device).toBe(firstDevice);
    expect(previousAccessory.displayName).toBe(firstDevice.title);
    expect(previousHandler.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ curTemp: 15 }));
    expect(nextHandler.deactivate).toHaveBeenCalledTimes(1);
    expect(subject.mqttClient.stop).not.toHaveBeenCalled();
    expect(subject.api.unregisterPlatformAccessories).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), [newAccessory]);
    expect(subject.api.registerPlatformAccessories).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), [previousAccessory]);
    expect(subject.log.error).toHaveBeenCalledWith('Device discovery failed: cache commit');
    expect(JSON.stringify(subject.log.error.mock.calls)).not.toContain('SECRET_UNREGISTER');
  });

  it('rolls back activated handlers and stops MQTT when a new discovery activation fails', async () => {
    const firstDevice = deviceFixture({ id: 1001, serial: 'FIRST-SERIAL' });
    const secondDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL' });
    const firstHandler = { updateDeviceState: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
    const failingHandler = {
      updateDeviceState: vi.fn(),
      activate: vi.fn(() => {
        throw new Error('activation failed');
      }),
      deactivate: vi.fn(),
    };
    const subject = createPlatform({ devices: [firstDevice, secondDevice] });
    subject.dependencies.createAccessoryHandler
      .mockImplementationOnce(() => firstHandler)
      .mockImplementationOnce(() => failingHandler);

    await subject.platform.discoverDevices();

    expect(firstHandler.activate).toHaveBeenCalledTimes(1);
    expect(firstHandler.deactivate).toHaveBeenCalledTimes(1);
    expect(failingHandler.deactivate).toHaveBeenCalledTimes(1);
    expect(subject.mqttClient.start).toHaveBeenCalledTimes(1);
    expect(subject.mqttClient.stop).toHaveBeenCalledTimes(1);
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
  });

  it('reattaches previous handlers without stopping already-running MQTT after activation failure', async () => {
    const firstDevice = deviceFixture();
    const secondDevice = deviceFixture({ id: 1002, serial: 'SECOND-SERIAL' });
    const previousHandler = { updateDeviceState: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
    const activatedHandler = { updateDeviceState: vi.fn(), activate: vi.fn(), deactivate: vi.fn() };
    const failingHandler = {
      updateDeviceState: vi.fn(),
      activate: vi.fn(() => {
        throw new Error('activation failed');
      }),
      deactivate: vi.fn(),
    };
    const subject = createPlatform({ devices: [firstDevice] });
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => previousHandler);
    await subject.platform.discoverDevices();
    subject.httpApi.getDevices.mockResolvedValueOnce([firstDevice, secondDevice]);
    subject.dependencies.createAccessoryHandler
      .mockImplementationOnce(() => activatedHandler)
      .mockImplementationOnce(() => failingHandler);

    await subject.platform.discoverDevices();
    subject.sendMqtt({ ...firstDevice, curTemp: 16 });

    expect(activatedHandler.deactivate).toHaveBeenCalledTimes(1);
    expect(previousHandler.activate).toHaveBeenCalledTimes(2);
    expect(previousHandler.activate).toHaveBeenLastCalledWith(true);
    expect(previousHandler.updateDeviceState).toHaveBeenCalledWith(expect.objectContaining({ curTemp: 16 }));
    expect(subject.mqttClient.stop).not.toHaveBeenCalled();
    expect(subject.registered).toHaveLength(1);
    expect(subject.unregistered).toEqual([]);
  });

  it('rolls back activation when shutdown invalidates discovery during handler activation', async () => {
    const subject = createPlatform();
    const handler = {
      updateDeviceState: vi.fn(),
      activate: vi.fn(() => {
        subject.eventHandlers.get('shutdown')?.();
      }),
      deactivate: vi.fn(),
    };
    subject.dependencies.createAccessoryHandler.mockImplementationOnce(() => handler);

    await subject.platform.discoverDevices();
    await Promise.resolve();

    expect(handler.deactivate).toHaveBeenCalledTimes(1);
    expect(subject.registered).toEqual([]);
    expect(subject.unregistered).toEqual([]);
  });

  it('clears a synchronous MQTT stop failure so a later restart can stop again', async () => {
    const subject = createPlatform();
    await subject.platform.discoverDevices();
    subject.mqttClient.stop.mockImplementationOnce(() => {
      throw new Error('stop failed synchronously');
    });
    const stopMqtt = (subject.platform as unknown as { stopMqtt: () => Promise<void> }).stopMqtt.bind(subject.platform);

    await stopMqtt();
    await subject.platform.discoverDevices();
    await stopMqtt();

    expect(subject.mqttClient.start).toHaveBeenCalledTimes(2);
    expect(subject.mqttClient.stop).toHaveBeenCalledTimes(2);
  });
});
