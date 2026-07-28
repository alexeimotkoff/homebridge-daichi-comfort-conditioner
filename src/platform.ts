import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { HttpApi } from './api';
import { ConfigDevice } from './models/configModel';
import { Device } from './models/deviceModel';
import { MqttUser } from './models/mqttUser';
import { DaichiMqttClient } from './mqttClient';
import { DaichiComfortPlatformAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

const DEVICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type DeviceHandler = Pick<DaichiComfortPlatformAccessory, 'updateDeviceState'> &
  Partial<Pick<DaichiComfortPlatformAccessory, 'activate' | 'deactivate' | 'logHapRefresh'>>;
type PlatformHttpApi = Pick<HttpApi, 'login' | 'loadMqttUser' | 'getDevices' | 'getDevice' | 'controlDevice'>;
type DeviceHandlerFactory = (
  platform: DaichiComfortHomebridgePlatform,
  accessory: PlatformAccessory,
  device: Device,
) => DeviceHandler;
type PlatformMqttClient = Pick<DaichiMqttClient, 'start' | 'stop'>;

interface PreparedAccessory {
  accessory: PlatformAccessory;
  device: Device;
  isNew: boolean;
}

interface DeviceRefresh {
  handler: DeviceHandler;
  promise: Promise<Device | undefined>;
}

type DiscoveryStage = 'login' | 'mqtt credentials' | 'devices' | 'prepare' |
  'mqtt start' | 'activation' | 'cache commit';

export interface PlatformDependencies {
  httpApi?: PlatformHttpApi;
  mqttClient?: PlatformMqttClient;
  createAccessoryHandler?: DeviceHandlerFactory;
}

/** Main Homebridge platform lifecycle and device discovery. */
export class DaichiComfortHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];

  protected httpApi!: PlatformHttpApi;
  private readonly mqttClient!: PlatformMqttClient;
  private readonly createAccessoryHandler!: DeviceHandlerFactory;
  private accessoryHandlers = new Map<number, DeviceHandler>();
  private mqttStarted = false;
  private mqttStopPromise: Promise<void> | null = null;
  private deviceRefreshTimer: NodeJS.Timeout | null = null;
  private readonly deviceRefreshes = new Map<number, DeviceRefresh>();
  private shuttingDown = false;
  private lifecycleGeneration = 0;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
    dependencies?: PlatformDependencies,
  ) {
    if (!this.config) {
      this.log.info('No config found in configuration file, disabling plugin.');
      return;
    }

    if (this.config.username === undefined ||
      this.config.password === undefined ||
      this.config.name === undefined) {
      this.log.error('Missing required config parameter.');
      return;
    }

    this.log.debug('Finished initializing platform:', this.config.name);
    this.httpApi = dependencies?.httpApi ?? new HttpApi(this.config.username, this.config.password, this.log);
    this.mqttClient = dependencies?.mqttClient ?? new DaichiMqttClient(this.log);
    this.createAccessoryHandler = dependencies?.createAccessoryHandler ??
      ((platform, accessory, device) => new DaichiComfortPlatformAccessory(platform, accessory, device, false));

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug('Executed didFinishLaunching callback');
      void this.discoverDevices();
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      this.shuttingDown = true;
      this.lifecycleGeneration++;
      this.stopDeviceRefresh();
      void this.stopMqtt();
    });
  }

  public getCtrlApi(): PlatformHttpApi {
    return this.httpApi;
  }

  /** Store Homebridge-restored accessories until a successful discovery reconciles them. */
  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /** Discover cloud devices, reconcile the accessory cache, then connect MQTT once. */
  public async discoverDevices(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    let stage: DiscoveryStage = 'login';
    if (!this.isDiscoveryActive(generation)) {
      return;
    }

    try {
      await this.httpApi.login();
      if (!this.isDiscoveryActive(generation)) {
        return;
      }

      stage = 'mqtt credentials';
      const mqttUser = await this.httpApi.loadMqttUser();
      if (!this.isDiscoveryActive(generation)) {
        return;
      }

      stage = 'devices';
      const devices = this.filterDevices((await this.httpApi.getDevices()).filter((device) => device?.serial));
      if (!this.isDiscoveryActive(generation)) {
        return;
      }

      stage = 'prepare';
      const preparedAccessories = this.prepareAccessories(devices);
      const nextHandlers = new Map<number, DeviceHandler>();
      for (const preparedAccessory of preparedAccessories) {
        nextHandlers.set(preparedAccessory.device.id, this.createAccessoryHandler(
          this,
          preparedAccessory.accessory,
          preparedAccessory.device,
        ));
      }

      if (!this.isDiscoveryActive(generation)) {
        return;
      }

      const previousHandlers = this.accessoryHandlers;
      stage = 'mqtt start';
      const startedMqtt = this.startMqtt(mqttUser);
      if (!this.isDiscoveryActive(generation)) {
        await this.rollbackActivation([], undefined, previousHandlers, startedMqtt);
        return;
      }

      stage = 'activation';
      const activatedHandlers: DeviceHandler[] = [];
      let activatingHandler: DeviceHandler | undefined;
      try {
        for (const handler of nextHandlers.values()) {
          activatingHandler = handler;
          if (handler.activate) {
            handler.activate();
            activatedHandlers.push(handler);
          }
        }
      } catch (error) {
        await this.rollbackActivation(
          activatedHandlers,
          activatingHandler,
          previousHandlers,
          startedMqtt,
        );
        throw error;
      }
      if (!this.isDiscoveryActive(generation)) {
        await this.rollbackActivation(activatedHandlers, undefined, previousHandlers, startedMqtt);
        return;
      }

      stage = 'cache commit';
      try {
        this.commitDiscovery(preparedAccessories, nextHandlers);
        this.startDeviceRefresh();
      } catch (error) {
        await this.rollbackActivation(activatedHandlers, undefined, previousHandlers, startedMqtt);
        throw error;
      }

      if (devices.length === 0) {
        this.log.info('Devices not found');
      }
    } catch {
      if (this.isDiscoveryActive(generation)) {
        this.log.error(`Device discovery failed: ${stage}`);
      }
    }
  }

  /** Refresh one known device without replacing state or functions omitted by the response. */
  public async refreshDeviceState(deviceId: number): Promise<Device | undefined> {
    const handler = this.accessoryHandlers.get(deviceId);
    if (!handler || this.shuttingDown) {
      return;
    }

    const existingRefresh = this.deviceRefreshes.get(deviceId);
    if (existingRefresh?.handler === handler) {
      return existingRefresh.promise;
    }

    const refresh = this.httpApi.getDevice(deviceId)
      .then((device) => {
        if (!this.shuttingDown && this.accessoryHandlers.get(deviceId) === handler) {
          handler.updateDeviceState(device);
          handler.logHapRefresh?.();
        }
        return device;
      })
      .finally(() => {
        if (this.deviceRefreshes.get(deviceId)?.promise === refresh) {
          this.deviceRefreshes.delete(deviceId);
        }
      });
    this.deviceRefreshes.set(deviceId, { handler, promise: refresh });
    return refresh;
  }

  private startDeviceRefresh(): void {
    this.stopDeviceRefresh();
    if (this.accessoryHandlers.size === 0 || this.shuttingDown) {
      return;
    }

    this.deviceRefreshTimer = setInterval(() => {
      for (const deviceId of this.accessoryHandlers.keys()) {
        void this.refreshDeviceState(deviceId).catch((error) => {
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.log.warn(`Failed to refresh device: ${deviceId}: ${message}`);
        });
      }
    }, DEVICE_REFRESH_INTERVAL_MS);
    this.deviceRefreshTimer.unref();
  }

  private stopDeviceRefresh(): void {
    if (this.deviceRefreshTimer) {
      clearInterval(this.deviceRefreshTimer);
      this.deviceRefreshTimer = null;
    }
  }

  private filterDevices(devices: Device[]): Device[] {
    const configDeviceNames = (this.config.devices as ConfigDevice[] | undefined)
      ?.filter((device) => device?.name)
      .map((device) => device.name.toLowerCase()) ?? [];

    if (configDeviceNames.length === 0) {
      return devices;
    }

    return devices.filter((device) =>
      device.title !== undefined && configDeviceNames.includes(device.title.toLowerCase()));
  }

  private prepareAccessories(devices: Device[]): PreparedAccessory[] {
    const cachedAccessories = new Map<string, PlatformAccessory>();
    for (const accessory of this.accessories) {
      if (!cachedAccessories.has(accessory.UUID)) {
        cachedAccessories.set(accessory.UUID, accessory);
      }
    }

    return devices.map((device) => {
      const uuid = this.api.hap.uuid.generate(device.serial);
      const existingAccessory = cachedAccessories.get(uuid);
      if (existingAccessory) {
        return { accessory: existingAccessory, device, isNew: false };
      }

      this.log.info('Adding new accessory:', device.serial);
      return {
        accessory: new this.api.platformAccessory(device.title ?? 'Unknown Name', uuid),
        device,
        isNew: true,
      };
    });
  }

  private commitDiscovery(
    preparedAccessories: PreparedAccessory[],
    nextHandlers: Map<number, DeviceHandler>,
  ): void {
    const previousAccessories = [...this.accessories];
    const previousHandlers = this.accessoryHandlers;
    const retainedAccessories = new Set(preparedAccessories.map(({ accessory }) => accessory));
    const newAccessories = preparedAccessories
      .filter(({ isNew }) => isNew)
      .map(({ accessory }) => accessory);
    const staleAccessories = this.accessories.filter((accessory) => !retainedAccessories.has(accessory));
    const accessorySnapshots = preparedAccessories.map(({ accessory }) => ({
      accessory,
      hadDevice: Object.prototype.hasOwnProperty.call(accessory.context, 'device'),
      device: accessory.context.device,
      displayName: accessory.displayName,
    }));
    let registerAttempted = false;
    let unregisterAttempted = false;

    try {
      if (newAccessories.length > 0) {
        registerAttempted = true;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
      }
      if (staleAccessories.length > 0) {
        unregisterAttempted = true;
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      }

      for (const { accessory, device } of preparedAccessories) {
        accessory.context.device = device;
        if (device.title !== undefined) {
          accessory.displayName = device.title;
        }
      }

      this.accessoryHandlers = nextHandlers;
      this.accessories.splice(0, this.accessories.length, ...retainedAccessories);
      if (staleAccessories.length > 0) {
        this.log.info(`Removed ${staleAccessories.length} stale accessories`);
      }
    } catch (error) {
      this.accessoryHandlers = previousHandlers;
      this.accessories.splice(0, this.accessories.length, ...previousAccessories);
      for (const snapshot of accessorySnapshots) {
        if (snapshot.hadDevice) {
          snapshot.accessory.context.device = snapshot.device;
        } else {
          delete snapshot.accessory.context.device;
        }
        snapshot.accessory.displayName = snapshot.displayName;
      }

      if (registerAttempted) {
        try {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
        } catch {
          this.log.warn('Failed to compensate accessory registration');
        }
      }
      if (unregisterAttempted) {
        try {
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
        } catch {
          this.log.warn('Failed to compensate stale accessory removal');
        }
      }
      throw error;
    }
  }

  private startMqtt(mqttUser: MqttUser): boolean {
    if (this.mqttStarted) {
      return false;
    }

    this.mqttStarted = true;
    try {
      this.mqttClient.start(mqttUser, (device) => {
        const handler = this.accessoryHandlers.get(device.id);
        if (!handler) {
          this.log.debug(`Ignored MQTT update for unknown device: ${device.id}`);
          return;
        }

        handler.updateDeviceState(device);
      });
      return true;
    } catch (error) {
      this.mqttStarted = false;
      throw error;
    }
  }

  private async stopMqtt(): Promise<void> {
    if (this.mqttStopPromise) {
      return this.mqttStopPromise;
    }
    if (!this.mqttStarted) {
      return;
    }

    const stopPromise = Promise.resolve()
      .then(() => this.mqttClient.stop())
      .catch(() => {
        this.log.warn('Failed to stop MQTT client');
      })
      .finally(() => {
        if (this.mqttStopPromise === stopPromise) {
          this.mqttStarted = false;
          this.mqttStopPromise = null;
        }
      });
    this.mqttStopPromise = stopPromise;
    return stopPromise;
  }

  private async rollbackActivation(
    activatedHandlers: DeviceHandler[],
    activatingHandler: DeviceHandler | undefined,
    previousHandlers: Map<number, DeviceHandler>,
    startedMqtt: boolean,
  ): Promise<void> {
    const handlersToDeactivate = new Set<DeviceHandler>([...activatedHandlers, activatingHandler]
      .filter((handler): handler is DeviceHandler => handler !== undefined));
    for (const handler of [...handlersToDeactivate].reverse()) {
      try {
        handler.deactivate?.();
      } catch {
        this.log.warn('Failed to roll back accessory handler');
      }
    }
    for (const handler of previousHandlers.values()) {
      try {
        handler.activate?.(true);
      } catch {
        this.log.warn('Failed to reattach previous accessory handler');
      }
    }
    if (startedMqtt) {
      await this.stopMqtt();
    }
  }

  private isDiscoveryActive(generation: number): boolean {
    return !this.shuttingDown && generation === this.lifecycleGeneration;
  }
}
