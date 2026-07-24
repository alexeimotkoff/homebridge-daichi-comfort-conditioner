import { AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DaichiApiError, HttpApi } from '../src/api';
import { CtrlMode } from '../src/models/ctrlMode';
import { DaichiComfortPlatformAccessory } from '../src/platformAccessory';
import {
  controlEnvelopeFixture,
  currentBuildingsResponseFixture,
  deviceFixture,
  nullableDeviceFixture,
} from './fixtures/daichi';

type FakeAxios = Pick<AxiosInstance, 'get' | 'post'>;

const tokenBody = {
  grant_type: 'password',
  email: 'user@example.test',
  password: 'password',
  clientId: 'sOJO7B6SqgaKudTfCzqLAy540cCuDzpI',
};

function createClient(): FakeAxios {
  return { get: vi.fn(), post: vi.fn() };
}

function createLog() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
}

function createApi(client: FakeAxios, log = createLog()) {
  return { api: new HttpApi('user@example.test', 'password', log as never, client as AxiosInstance), log };
}

function unauthorizedError() {
  return { isAxiosError: true, response: { status: 401 } };
}

function serverError(status: number) {
  return { isAxiosError: true, response: { status } };
}

describe('HttpApi', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts the exact token request and sends Bearer authorization later', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.post).mockResolvedValueOnce({ data: { data: { access_token: 'token' } } });
    vi.mocked(client.get).mockResolvedValueOnce({ data: { data: { data: [] } } });

    await api.login();
    await api.getDevices();

    expect(client.post).toHaveBeenNthCalledWith(1, 'token', tokenBody);
    expect(client.get).toHaveBeenCalledWith('buildings', { headers: { Authorization: 'Bearer token' } });
  });

  it('returns validated MQTT credentials without logging the response body', async () => {
    const client = createClient();
    const { api, log } = createApi(client);
    vi.mocked(client.get).mockResolvedValueOnce({ data: { data: { id: 7, mqttUser: { username: 'mqtt-user', password: 'mqtt-secret' } } } });

    await expect(api.loadMqttUser()).resolves.toMatchObject({ userName: 'mqtt-user', password: 'mqtt-secret', userId: 7 });
    expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('mqtt-secret'));
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining('mqtt-secret'));
  });

  it('returns direct devices from building places', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get)
      .mockResolvedValueOnce({ data: { data: { data: [{ places: [{ id: 10 }, { id: 11 }] }] } } })
      .mockResolvedValueOnce({ data: { data: deviceFixture } })
      .mockResolvedValueOnce({ data: { data: { ...deviceFixture, id: 11 } } });

    await expect(api.getDevices()).resolves.toEqual([deviceFixture, { ...deviceFixture, id: 11 }]);
    expect(client.get).toHaveBeenNthCalledWith(1, 'buildings', { headers: {} });
    expect(client.get).toHaveBeenNthCalledWith(2, 'devices/10', { headers: {} });
    expect(client.get).toHaveBeenNthCalledWith(3, 'devices/11', { headers: {} });
  });

  it('discovers devices from the current direct buildings data array', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get)
      .mockResolvedValueOnce({ data: currentBuildingsResponseFixture })
      .mockResolvedValueOnce({ data: { data: { ...deviceFixture, id: 10 } } });

    await expect(api.getDevices()).resolves.toEqual([{ ...deviceFixture, id: 10 }]);
    expect(client.get).toHaveBeenNthCalledWith(2, 'devices/10', { headers: {} });
  });

  it('accepts nullable fields from the current Daichi device endpoint', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get)
      .mockResolvedValueOnce({ data: { data: { data: [{ places: [{ id: 10 }] }] } } })
      .mockResolvedValueOnce({ data: { data: nullableDeviceFixture } });

    await expect(api.getDevices()).resolves.toEqual([nullableDeviceFixture]);
  });

  it('posts the exact control payload and returns the requested device', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.spyOn(Math, 'random').mockReturnValue(0.00000042);
    vi.mocked(client.post).mockResolvedValueOnce({ data: controlEnvelopeFixture });

    await expect(api.controlDevice(1001, CtrlMode.IsOn, 350, true)).resolves.toEqual(deviceFixture);
    expect(client.post).toHaveBeenCalledWith('devices/1001/ctrl?ignoreConflicts=false', {
      cmdId: 42,
      value: { functionId: 350, isOn: true, parameters: null },
      conflictResolveData: null,
    }, { headers: {} });
  });

  it('retries an authorized operation exactly once after a 401', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get)
      .mockRejectedValueOnce(unauthorizedError())
      .mockResolvedValueOnce({ data: { data: { data: [] } } });
    vi.mocked(client.post).mockResolvedValueOnce({ data: { data: { access_token: 'renewed' } } });

    await expect(api.getDevices()).resolves.toEqual([]);
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(client.get).toHaveBeenNthCalledWith(2, 'buildings', { headers: { Authorization: 'Bearer renewed' } });
    expect(client.post).toHaveBeenCalledWith('token', tokenBody);
  });

  it('does not retry after a second 401', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get)
      .mockRejectedValueOnce(unauthorizedError())
      .mockRejectedValueOnce(unauthorizedError());
    vi.mocked(client.post).mockResolvedValueOnce({ data: { data: { access_token: 'renewed' } } });

    await expect(api.getDevices()).rejects.toMatchObject({ status: 401 });
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('wraps non-401 HTTP failures in DaichiApiError', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.get).mockRejectedValueOnce(serverError(503));

    const request = api.getDevices();
    await expect(request).rejects.toBeInstanceOf(DaichiApiError);
    await expect(request).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    ['token', () => ({ post: [{ data: { data: {} } }] }), (api: HttpApi) => api.login()],
    ['empty token', () => ({ post: [{ data: { data: { access_token: ' ' } } }] }), (api: HttpApi) => api.login()],
    ['user', () => ({ get: [{ data: { data: { id: 7, mqttUser: { username: 'mqtt-user' } } } }] }), (api: HttpApi) => api.loadMqttUser()],
    ['empty username', () => ({ get: [{ data: { data: { id: 7, mqttUser: { username: ' ', password: 'mqtt-password' } } } }] }), (api: HttpApi) => api.loadMqttUser()],
    ['empty password', () => ({ get: [{ data: { data: { id: 7, mqttUser: { username: 'mqtt-user', password: '' } } } }] }), (api: HttpApi) => api.loadMqttUser()],
    ['non-integer user id', () => ({ get: [{ data: { data: { id: 7.5, mqttUser: { username: 'mqtt-user', password: 'mqtt-password' } } } }] }), (api: HttpApi) => api.loadMqttUser()],
    ['NaN user id', () => ({ get: [{ data: { data: { id: NaN, mqttUser: { username: 'mqtt-user', password: 'mqtt-password' } } } }] }), (api: HttpApi) => api.loadMqttUser()],
    ['buildings', () => ({ get: [{ data: { data: { data: [{ places: [{ id: 'bad' }] }] } } }] }), (api: HttpApi) => api.getDevices()],
    ['non-positive place id', () => ({ get: [{ data: { data: { data: [{ places: [{ id: 0 }] }] } } }] }), (api: HttpApi) => api.getDevices()],
    ['device envelope', () => ({ get: [{ data: { data: { data: [{ places: [{ id: 10 }] }] } } }, { data: { data: { ...deviceFixture, id: 'bad' } } }] }), (api: HttpApi) => api.getDevices()],
    ['control', () => ({ post: [{ data: { done: true, errors: null, data: {} } }] }), (api: HttpApi) => api.controlDevice(1001, CtrlMode.IsOn, 350, true)],
  ])('rejects a malformed successful %s response', async (_name, replies, call) => {
    const client = createClient();
    const { api } = createApi(client);
    const planned = replies();
    planned.get?.forEach((response: unknown) => vi.mocked(client.get).mockResolvedValueOnce(response));
    planned.post?.forEach((response: unknown) => vi.mocked(client.post).mockResolvedValueOnce(response));

    await expect(call(api)).rejects.toBeInstanceOf(DaichiApiError);
  });

  it('rejects a control response without the requested device id', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.post).mockResolvedValueOnce({ data: { ...controlEnvelopeFixture, data: { devices: [{ ...deviceFixture, id: 5 }] } } });

    await expect(api.controlDevice(1001, CtrlMode.IsOn, 350, true)).rejects.toBeInstanceOf(DaichiApiError);
  });

  it('fails without dereferencing a missing response data field', async () => {
    const client = createClient();
    const { api } = createApi(client);
    vi.mocked(client.post).mockRejectedValueOnce(serverError(500));

    await expect(api.controlDevice(1001, CtrlMode.IsOn, 350, true)).rejects.toMatchObject({ status: 500 });
  });

  it('logs the control lifecycle, updates state, and rethrows a safe failure', async () => {
    const controlDevice = vi.fn()
      .mockResolvedValueOnce(deviceFixture)
      .mockRejectedValueOnce(new Error('request failed'));
    const updateDeviceState = vi.fn();
    const log = { debug: vi.fn(), error: vi.fn() };
    const context = {
      dev: deviceFixture,
      functionsDict: new Map([[CtrlMode.IsOn, { id: 350 }]]),
      platform: { log, getCtrlApi: () => ({ controlDevice }) },
      updateDeviceState,
    };
    const ctrl = DaichiComfortPlatformAccessory.prototype as unknown as {
      ctrl(this: typeof context, cmd: CtrlMode, value: boolean | number): Promise<void>;
    };

    await ctrl.ctrl.call(context, CtrlMode.IsOn, true);
    await expect(ctrl.ctrl.call(context, CtrlMode.IsOn, true)).rejects.toThrow('request failed');

    expect(updateDeviceState).toHaveBeenCalledWith(deviceFixture);
    expect(log.debug).toHaveBeenNthCalledWith(1, 'Sending control request: device=1001, cmd=IsOn, function=350');
    expect(log.debug).toHaveBeenNthCalledWith(2, 'Accepted control request: device=1001, cmd=IsOn, function=350');
    expect(log.error).toHaveBeenCalledWith('Failed control request: device=1001, cmd=IsOn, function=350: request failed');
  });
});
