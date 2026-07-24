import { BuildingsResponse, ControlEnvelope, DeviceEnvelope, TokenResponse, UserResponse } from './models/apiModel';
import { DaichiInfoModel, Device, Pult, PultFunction } from './models/deviceModel';

const MAX_VALUE_RANGE_LENGTH = 256;

export function isDevice(value: unknown): value is Device {
  if (!isRecord(value) ||
    !isPositiveInteger(value.id) ||
    typeof value.serial !== 'string' ||
    typeof value.status !== 'string' ||
    (value.curTemp !== undefined && !isFiniteNumber(value.curTemp)) ||
    !isRecord(value.state) ||
    typeof value.state.isOn !== 'boolean' ||
    !Array.isArray(value.pult)) {
    return false;
  }

  return value.pult.every(isPult) &&
    (value.deviceInfo === undefined || isDeviceInfo(value.deviceInfo)) &&
    (value.title === undefined || typeof value.title === 'string');
}

export function isMqttModel(value: unknown): value is DaichiInfoModel {
  return isRecord(value) && Array.isArray(value.devices) && value.devices.every(isDevice);
}

export function isControlEnvelope(value: unknown): value is ControlEnvelope {
  return isRecord(value) &&
    value.done === true &&
    value.errors === null &&
    isMqttModel(value.data);
}

export function isTokenResponse(value: unknown): value is TokenResponse {
  return isRecord(value) && isRecord(value.data) && isNonEmptyString(value.data.access_token);
}

export function isUserResponse(value: unknown): value is UserResponse {
  return isRecord(value) &&
    isRecord(value.data) &&
    isPositiveInteger(value.data.id) &&
    isRecord(value.data.mqttUser) &&
    isNonEmptyString(value.data.mqttUser.username) &&
    isNonEmptyString(value.data.mqttUser.password);
}

export function isBuildingsResponse(value: unknown): value is BuildingsResponse {
  if (!isRecord(value)) {
    return false;
  }

  const buildings = Array.isArray(value.data)
    ? value.data
    : isRecord(value.data) && Array.isArray(value.data.data)
      ? value.data.data
      : null;

  return buildings !== null &&
    buildings.every((building) => isRecord(building) &&
      Array.isArray(building.places) &&
      building.places.every((place) => isRecord(place) && isPositiveInteger(place.id)));
}

export function isDeviceEnvelope(value: unknown): value is DeviceEnvelope {
  return isRecord(value) && isDevice(value.data);
}

function isPult(value: unknown): value is Pult {
  return isRecord(value) &&
    Array.isArray(value.functions) &&
    value.functions.every((pultFunction) => isPultFunction(pultFunction));
}

function isPultFunction(
  value: unknown,
  ancestors: ReadonlySet<Record<string, unknown>> = new Set(),
  depth = 0,
): value is PultFunction {
  if (!isRecord(value) || depth > 16 || ancestors.has(value) || !isPositiveInteger(value.id) ||
    (value.title !== undefined && value.title !== null && typeof value.title !== 'string') || !isRecord(value.state) ||
    !isRecord(value.metaData) || !isRecord(value.metaData.bleTagInfo)) {
    return false;
  }

  const state = value.state;
  const valueRange = state.valueRange;
  const bleTagInfo = value.metaData.bleTagInfo;
  if (typeof state.isOn !== 'boolean' ||
    (state.value !== undefined && state.value !== null && !isFiniteNumber(state.value)) ||
    (valueRange !== undefined && !isFiniteNumberArray(valueRange)) ||
    typeof bleTagInfo.bleTag !== 'string' ||
    (bleTagInfo.bleOnCommand !== undefined && bleTagInfo.bleOnCommand !== null &&
      typeof bleTagInfo.bleOnCommand !== 'string') ||
    (value.title === 'Fan speed' && bleTagInfo.bleTag === 'fanSpeed' &&
      valueRange !== undefined && !isSafeFanSpeedRange(valueRange))) {
    return false;
  }

  if (value.linkedFunction === undefined || value.linkedFunction === null) {
    return true;
  }

  const linkedAncestors = new Set(ancestors);
  linkedAncestors.add(value);
  return isPultFunction(value.linkedFunction, linkedAncestors, depth + 1);
}

function isDeviceInfo(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.brand === 'string' &&
    typeof value.seria === 'string' &&
    typeof value.model === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_VALUE_RANGE_LENGTH &&
    value.every(isFiniteNumber);
}

function isSafeFanSpeedRange(valueRange: number[]): boolean {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of valueRange) {
    if (value > maximum) {
      maximum = value;
    }
  }

  const minStep = Math.floor(100 / maximum);
  return Number.isFinite(minStep) && minStep > 0;
}
