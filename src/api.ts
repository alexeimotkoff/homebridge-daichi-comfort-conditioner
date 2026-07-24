import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';

import { buildControlPayload } from './controlPayload';
import { MqttUser } from './models/mqttUser';
import { CtrlMode } from './models/ctrlMode';
import { Device } from './models/deviceModel';
import {
  isBuildingsResponse,
  isControlEnvelope,
  isDeviceEnvelope,
  isTokenResponse,
  isUserResponse,
} from './validation';

export class DaichiApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'DaichiApiError';
  }
}

export class HttpApi {
  private apiToken: string | null = null;
  private mqttUser: MqttUser | null = null;
  private readonly client: AxiosInstance;

  constructor(
    protected readonly userName: string,
    protected readonly password: string,
    protected readonly log: Logger,
    client?: AxiosInstance,
  ) {
    this.client = client ?? axios.create({
      baseURL: 'https://web.daichicloud.ru/api/v4/',
      timeout: 30_000,
    });
  }

  /** Login in Daichi Comfort Cloud. */
  public async login(): Promise<void> {
    try {
      this.log.debug('Sending login request');
      const response = await this.client.post('token', {
        grant_type: 'password',
        email: this.userName,
        password: this.password,
        clientId: 'sOJO7B6SqgaKudTfCzqLAy540cCuDzpI',
      });
      if (!isTokenResponse(response.data)) {
        throw new DaichiApiError('Invalid token response');
      }

      this.apiToken = response.data.data.access_token;
      this.log.info('Accepted login request');
    } catch (error) {
      throw this.toApiError(error, 'Login failed');
    }
  }

  /** Load and store MQTT user credentials. */
  public async loadMqttUser(): Promise<MqttUser> {
    const response = await this.authorized((config) => this.client.get('user', config));
    if (!isUserResponse(response.data)) {
      throw new DaichiApiError('Invalid user response');
    }

    const { id, mqttUser } = response.data.data;
    this.mqttUser = new MqttUser(mqttUser.username, mqttUser.password, id);
    this.log.debug('Accepted MQTT user request');
    return this.mqttUser;
  }

  /** Get the last loaded MQTT user. */
  public getMqttUserInfo(): MqttUser | null {
    return this.mqttUser;
  }

  /** Get all devices available to the user. */
  public async getDevices(): Promise<Device[]> {
    const buildings = await this.authorized((config) => this.client.get('buildings', config));
    if (!isBuildingsResponse(buildings.data)) {
      throw new DaichiApiError('Invalid buildings response');
    }

    const placeIds = buildings.data.data.data.flatMap((building) => building.places.map((place) => place.id));
    const devices = await Promise.all(placeIds.map((id) => this.getDevice(id)));
    this.log.debug(`Accepted device discovery for ${devices.length} devices`);
    return devices;
  }

  /** Send a control request and return the updated requested device. */
  public async controlDevice(
    devId: number,
    cmd: CtrlMode,
    functionId: number,
    value: boolean | number,
  ): Promise<Device> {
    const payload = buildControlPayload(cmd, functionId, value);
    this.log.debug(`Sending control request: device=${devId}, cmd=${cmd}, function=${functionId}`);
    const response = await this.authorized((config) => this.client.post(
      `devices/${devId}/ctrl?ignoreConflicts=false`,
      payload,
      config,
    ));

    if (!isControlEnvelope(response.data)) {
      throw new DaichiApiError('Invalid control response');
    }

    const device = response.data.data.devices.find((item) => item.id === devId);
    if (!device) {
      throw new DaichiApiError(`Control response does not contain device ${devId}`);
    }

    this.log.debug(`Accepted control request: device=${devId}, cmd=${cmd}, function=${functionId}`);
    return device;
  }

  private async getDevice(id: number): Promise<Device> {
    const response = await this.authorized((config) => this.client.get(`devices/${id}`, config));
    if (!isDeviceEnvelope(response.data)) {
      throw new DaichiApiError(`Invalid device response for ${id}`);
    }

    return response.data.data;
  }

  private async authorized<T>(request: (config: { headers: Record<string, string> }) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await request(this.authorizationConfig());
      } catch (error) {
        if (this.statusOf(error) === 401 && attempt === 0) {
          this.log.debug('Failed authorized request with status 401; refreshing login');
          await this.login();
          continue;
        }

        throw this.toApiError(error, 'Authorized request failed');
      }
    }

    throw new DaichiApiError('Authorized request failed');
  }

  private authorizationConfig(): { headers: Record<string, string> } {
    return {
      headers: this.apiToken === null ? {} : { Authorization: `Bearer ${this.apiToken}` },
    };
  }

  private toApiError(error: unknown, fallback: string): DaichiApiError {
    if (error instanceof DaichiApiError) {
      return error;
    }

    const status = this.statusOf(error);
    const message = error instanceof Error ? error.message : fallback;
    this.log.debug(`Failed request${status === undefined ? '' : ` with status ${status}`}`);
    return new DaichiApiError(message, status);
  }

  private statusOf(error: unknown): number | undefined {
    if (!this.isAxiosError(error) || typeof error.response?.status !== 'number') {
      return undefined;
    }

    return error.response.status;
  }

  private isAxiosError(error: unknown): error is { response?: { status?: unknown } } {
    return axios.isAxiosError(error) ||
      (typeof error === 'object' && error !== null &&
        'isAxiosError' in error && error.isAxiosError === true);
  }
}
