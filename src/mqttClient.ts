import { Logger } from 'homebridge';
import { connect, IClientOptions, MqttClient } from 'mqtt';
import { DeviceUpdate } from './models/deviceModel';
import { MqttUser } from './models/mqttUser';
import { getMqttDeviceUpdates } from './validation';

const mqttUrl = 'wss://split.daichicloud.ru/mqtt';

export type DeviceUpdateHandler = (device: DeviceUpdate) => void;
export type MqttConnect = (brokerUrl: string, options: IClientOptions) => MqttClient;

export class DaichiMqttClient {
  private client: MqttClient | null = null;
  private lastConnectionState: string | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly log: Logger,
    private readonly connectClient: MqttConnect = connect,
  ) {}

  public start(user: MqttUser, onDeviceUpdate: DeviceUpdateHandler): void {
    if (this.client || this.stopPromise) {
      return;
    }

    this.lastConnectionState = null;
    const topic = `user/${user.userId}/notification`;
    const client = this.connectClient(mqttUrl, {
      username: user.userName,
      password: user.password,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      resubscribe: false,
    });
    this.client = client;
    let connectionEpoch = 0;
    let hasSubscribed = false;
    let subscriptionPending = false;
    let subscriptionAttempted = false;

    const resetSubscriptionState = (): void => {
      connectionEpoch++;
      hasSubscribed = false;
      subscriptionPending = false;
      subscriptionAttempted = false;
    };

    client.on('connect', () => {
      if (!this.isActiveClient(client)) {
        return;
      }

      if (!hasSubscribed && !subscriptionPending && !subscriptionAttempted) {
        subscriptionAttempted = true;
        subscriptionPending = true;
        const subscriptionEpoch = connectionEpoch;
        try {
          client.subscribe(topic, (error, grants) => {
            if (!this.isActiveClient(client) ||
              subscriptionEpoch !== connectionEpoch ||
              !subscriptionPending) {
              return;
            }

            subscriptionPending = false;
            const expectedGrant = grants?.find((grant) => grant.topic === topic);
            if (error || !expectedGrant || expectedGrant.qos === 128) {
              this.log.error('MQTT subscription failed');
              return;
            }

            hasSubscribed = true;
          });
        } catch {
          subscriptionPending = false;
          if (this.isActiveClient(client) && subscriptionEpoch === connectionEpoch) {
            this.log.error('MQTT subscription failed');
          }
        }
      }
      this.logConnectionState('connected', 'debug');
    });
    client.on('reconnect', () => {
      if (this.isActiveClient(client)) {
        resetSubscriptionState();
        this.logConnectionState('reconnecting', 'debug');
      }
    });
    client.on('offline', () => {
      if (this.isActiveClient(client)) {
        resetSubscriptionState();
        this.logConnectionState('offline', 'warn');
      }
    });
    client.on('close', () => {
      if (this.isActiveClient(client)) {
        resetSubscriptionState();
        this.logConnectionState('closed', 'warn');
      }
    });
    client.on('error', () => {
      if (this.isActiveClient(client)) {
        this.log.error('MQTT connection error');
      }
    });
    client.on('message', (messageTopic: string, message: Buffer) => {
      if (!this.isActiveClient(client) || messageTopic !== topic) {
        return;
      }

      const payload = message.toString();
      let model: unknown;
      try {
        model = JSON.parse(payload);
      } catch {
        this.log.warn(`Ignored malformed MQTT message (length: ${Buffer.byteLength(payload)})`);
        return;
      }

      const devices = getMqttDeviceUpdates(model);
      if (devices === null) {
        return;
      }

      devices.forEach((device) => {
        try {
          onDeviceUpdate(device);
        } catch {
          this.log.error(`MQTT device update failed (device: ${device.id})`);
        }
      });
    });
  }

  public stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const client = this.client;
    if (!client) {
      return Promise.resolve();
    }

    let resolveStop: () => void;
    let rejectStop: (error: Error) => void;
    const stopPromise = new Promise<void>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    this.stopPromise = stopPromise;
    client.end(true, (error) => {
      if (this.client === client) {
        this.client = null;
      }
      this.stopPromise = null;

      if (error) {
        rejectStop(error);
        return;
      }

      resolveStop();
    });
    return stopPromise;
  }

  private logConnectionState(state: string, level: 'debug' | 'warn'): void {
    if (this.lastConnectionState === state) {
      return;
    }

    this.lastConnectionState = state;
    this.log[level](`MQTT ${state}`);
  }

  private isActiveClient(client: MqttClient): boolean {
    return this.client === client && this.stopPromise === null;
  }
}
