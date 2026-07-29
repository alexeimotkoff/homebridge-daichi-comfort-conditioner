import { EventEmitter } from 'node:events';
import { Logger } from 'homebridge';
import { describe, expect, it, vi } from 'vitest';
import { DaichiMqttClient } from '../src/mqttClient';
import { MqttUser } from '../src/models/mqttUser';
import { deviceFixture, mqttModelFixture, partialTemperatureMqttModelFixture } from './fixtures/daichi';

class FakeMqttClient extends EventEmitter {
  public readonly subscribe = vi.fn();
  public readonly end = vi.fn((_force: boolean, callback: (error?: Error) => void) => callback());
}

type SubscribeCallback = (
  error: Error | null,
  grants?: Array<{ topic: string; qos: 0 | 1 | 2 | 128 }>,
) => void;

function subscribeCallback(client: FakeMqttClient, call = 0): SubscribeCallback {
  return client.subscribe.mock.calls[call][1] as SubscribeCallback;
}

function createLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function createClient() {
  const client = new FakeMqttClient();
  const connect = vi.fn(() => client);
  const log = createLog();
  const mqtt = new DaichiMqttClient(log, connect as never);
  return { client, connect, log, mqtt };
}

const user = new MqttUser('mqtt-user', 'mqtt-secret', 7);

describe('DaichiMqttClient', () => {
  it('connects with the required URL and options', () => {
    const { connect, mqtt } = createClient();

    mqtt.start(user, vi.fn());

    expect(connect).toHaveBeenCalledWith('wss://split.daichicloud.ru/mqtt', {
      username: 'mqtt-user',
      password: 'mqtt-secret',
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      resubscribe: false,
    });
  });

  it('does not create a second connection when started repeatedly', () => {
    const { connect, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    mqtt.start(user, vi.fn());

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('subscribes once on each successful connection when auto-resubscribe is disabled', () => {
    const { client, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    subscribeCallback(client)(null, [{ topic: 'user/7/notification', qos: 0 }]);
    client.emit('connect');
    client.emit('reconnect');
    client.emit('connect');
    subscribeCallback(client, 1)(null, [{ topic: 'user/7/notification', qos: 0 }]);
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledWith('user/7/notification', expect.any(Function));
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate subscribe while its acknowledgement is pending', () => {
    const { client, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('retries subscription after a callback error without logging its text', () => {
    const { client, log, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    subscribeCallback(client)(new Error('mqtt-secret'));
    client.emit('connect');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    client.emit('close');
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('MQTT subscription failed');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('mqtt-secret');
  });

  it.each([
    ['rejected QoS', [{ topic: 'user/7/notification', qos: 128 as const }]],
    ['missing expected grant', [{ topic: 'user/other/notification', qos: 0 as const }]],
    ['empty grants', []],
  ])('retries subscription after %s', (_case, grants) => {
    const { client, log, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    subscribeCallback(client)(null, grants);
    client.emit('connect');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    client.emit('offline');
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('MQTT subscription failed');
  });

  it('recovers from a synchronous subscribe error and stops retrying after success', () => {
    const { client, log, mqtt } = createClient();
    client.subscribe.mockImplementationOnce(() => {
      throw new Error('mqtt-secret');
    });

    mqtt.start(user, vi.fn());
    expect(() => client.emit('connect')).not.toThrow();
    client.emit('connect');
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    client.emit('reconnect');
    client.emit('connect');
    subscribeCallback(client, 1)(null, [{ topic: 'user/7/notification', qos: 1 }]);
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('MQTT subscription failed');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('mqtt-secret');
  });

  it('ignores a late subscription callback from the previous connection epoch', () => {
    const { client, log, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    const staleCallback = subscribeCallback(client);
    client.emit('reconnect');
    client.emit('connect');
    staleCallback(new Error('mqtt-secret'));
    client.emit('connect');

    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(log.error).not.toHaveBeenCalled();

    subscribeCallback(client, 1)(null, [{ topic: 'user/7/notification', qos: 0 }]);
    client.emit('connect');
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  it('dispatches every device from a valid MQTT message exactly once', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();
    const message = { devices: [deviceFixture, { ...deviceFixture, id: 1002 }] };

    mqtt.start(user, onDeviceUpdate);
    client.emit('message', 'user/7/notification', Buffer.from(JSON.stringify(message)));

    expect(onDeviceUpdate).toHaveBeenCalledTimes(2);
    expect(onDeviceUpdate).toHaveBeenNthCalledWith(1, {
      id: 1001,
      curTemp: 22,
      state: { isOn: true },
    });
    expect(onDeviceUpdate).toHaveBeenNthCalledWith(2, {
      id: 1002,
      curTemp: 22,
      state: { isOn: true },
    });
  });

  it('dispatches a partial temperature update without full device state', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();

    mqtt.start(user, onDeviceUpdate);
    client.emit(
      'message',
      'user/7/notification',
      Buffer.from(JSON.stringify(partialTemperatureMqttModelFixture)),
    );

    expect(onDeviceUpdate).toHaveBeenCalledWith({ id: 1001, curTemp: 26 });
  });

  it('preserves the linked Auto function of Fan speed in an MQTT update', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();
    const message = {
      devices: [{
        id: 1001,
        pult: [{
          functions: [{
            id: 358,
            title: 'Fan speed',
            state: {isOn: true, value: 1, valueRange: [1, 5]},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed'}},
            linkedFunction: {
              id: 357,
              title: 'Auto',
              state: {isOn: false, value: null},
              metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
            },
          }],
        }],
      }],
    };

    mqtt.start(user, onDeviceUpdate);
    client.emit('message', 'user/7/notification', Buffer.from(JSON.stringify(message)));

    expect(onDeviceUpdate).toHaveBeenCalledWith({
      id: 1001,
      pult: [{
        functions: [{
          id: 358,
          title: 'Fan speed',
          state: {isOn: true, value: 1, valueRange: [1, 5]},
          metaData: {bleTagInfo: {bleTag: 'fanSpeed'}},
          linkedFunction: {
            id: 357,
            title: 'Auto',
            state: {isOn: false},
            metaData: {bleTagInfo: {bleTag: 'fanSpeed', bleOnCommand: '0'}},
          },
        }],
      }],
    });
  });

  it('dispatches only useful fields from devices and pult entries independently', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();
    const message = {
      devices: [
        {
          id: 1001,
          curTemp: 26,
          status: { unexpected: true },
          state: { isOn: true, futureState: 'ignored' },
          pult: [
            { futurePult: true },
            {
              functions: [
                {
                  id: 900,
                  state: { isOn: true },
                  metaData: { bleTagInfo: { bleTag: 'futureFunction' } },
                },
                null,
                {
                  id: 351,
                  state: { value: 24, futureState: 'ignored' },
                  metaData: {
                    bleTagInfo: { bleTag: 'setTemp', futureMetadata: 'ignored' },
                    futureMetadata: 'ignored',
                  },
                  linkedFunction: 'ignored',
                  futureFunction: 'ignored',
                },
              ],
            },
            'futurePult',
          ],
          futureDevice: 'ignored',
        },
        { id: 'invalid', curTemp: 99 },
        { id: 1002, curTemp: 27, futureDevice: true },
      ],
      futureRoot: true,
    };

    mqtt.start(user, onDeviceUpdate);
    client.emit('message', 'user/7/notification', Buffer.from(JSON.stringify(message)));

    expect(onDeviceUpdate).toHaveBeenCalledTimes(2);
    expect(onDeviceUpdate).toHaveBeenNthCalledWith(1, {
      id: 1001,
      curTemp: 26,
      state: { isOn: true },
      pult: [{
        functions: [{
          id: 351,
          state: { value: 24 },
          metaData: { bleTagInfo: { bleTag: 'setTemp' } },
        }],
      }],
    });
    expect(onDeviceUpdate).toHaveBeenNthCalledWith(2, { id: 1002, curTemp: 27 });
  });

  it('isolates device update failures and continues dispatching safely', () => {
    const { client, log, mqtt } = createClient();
    const onDeviceUpdate = vi.fn((device: typeof deviceFixture) => {
      if (device.id === deviceFixture.id) {
        throw new Error('mqtt-secret');
      }
    });
    const message = { devices: [deviceFixture, { ...deviceFixture, id: 1002 }] };

    mqtt.start(user, onDeviceUpdate);
    expect(() => client.emit(
      'message',
      'user/7/notification',
      Buffer.from(JSON.stringify(message)),
    )).not.toThrow();

    expect(onDeviceUpdate).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('MQTT device update failed (device: 1001)');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('mqtt-secret');
  });

  it('ignores malformed JSON without logging its contents', () => {
    const { client, log, mqtt } = createClient();
    const payload = '{mqtt-secret: invalid}';

    mqtt.start(user, vi.fn());
    expect(() => client.emit('message', 'user/7/notification', Buffer.from(payload))).not.toThrow();

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/malformed MQTT message.*length/i));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining(payload));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('mqtt-secret');
  });

  it('ignores messages with missing or non-array devices', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();

    mqtt.start(user, onDeviceUpdate);
    client.emit('message', 'user/7/notification', Buffer.from('{}'));
    client.emit('message', 'user/7/notification', Buffer.from('{"devices": {}}'));

    expect(onDeviceUpdate).not.toHaveBeenCalled();
  });

  it('ignores messages from unrelated topics', () => {
    const { client, mqtt } = createClient();
    const onDeviceUpdate = vi.fn();

    mqtt.start(user, onDeviceUpdate);
    client.emit('message', 'user/other/notification', Buffer.from(JSON.stringify(mqttModelFixture)));

    expect(onDeviceUpdate).not.toHaveBeenCalled();
  });

  it('logs connection states safely without consecutive duplicates', () => {
    const { client, log, mqtt } = createClient();

    mqtt.start(user, vi.fn());
    client.emit('connect');
    client.emit('connect');
    client.emit('reconnect');
    client.emit('offline');
    client.emit('close');
    client.emit('error', new Error('connection failed mqtt-secret'));

    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('MQTT connection error');
    expect(JSON.stringify([...log.debug.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls])).not.toContain('mqtt-secret');
  });

  it('keeps the active client until pending stop completes and ignores its events', async () => {
    const first = new FakeMqttClient();
    const second = new FakeMqttClient();
    const connect = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const log = createLog();
    const mqtt = new DaichiMqttClient(log, connect as never);
    const onDeviceUpdate = vi.fn();
    let completeStop: ((error?: Error) => void) | undefined;
    first.end.mockImplementation((_force, callback) => {
      completeStop = callback;
    });

    mqtt.start(user, onDeviceUpdate);
    first.emit('connect');
    const staleSubscription = subscribeCallback(first);
    const firstStop = mqtt.stop();
    const repeatedStop = mqtt.stop();
    mqtt.start(user, vi.fn());
    first.emit('message', 'user/7/notification', Buffer.from(JSON.stringify(mqttModelFixture)));
    first.emit('reconnect');
    first.emit('offline');
    first.emit('close');
    first.emit('error', new Error('mqtt-secret'));

    expect(first.end).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onDeviceUpdate).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();

    completeStop!();
    await Promise.all([firstStop, repeatedStop]);
    first.emit('message', 'user/7/notification', Buffer.from(JSON.stringify(mqttModelFixture)));
    first.emit('error', new Error('mqtt-secret'));
    mqtt.start(user, vi.fn());
    second.emit('connect');
    staleSubscription(new Error('mqtt-secret'));

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.subscribe).toHaveBeenCalledTimes(1);
    expect(onDeviceUpdate).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
