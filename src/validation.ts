import { BuildingsResponse, ControlEnvelope, DeviceEnvelope, TokenResponse, UserResponse } from './models/apiModel';
import {
  DaichiInfoModel,
  DaichiMqttModel,
  Device,
  DeviceUpdate,
  Pult,
  PultFunction,
  PultFunctionUpdate,
} from './models/deviceModel';

const MAX_VALUE_RANGE_LENGTH = 256;
const MQTT_FUNCTION_TAGS = new Set(['power', 'setTemp', 'flow', 'fanSpeed', 'mode', 'powerfull']);

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

export function isMqttModel(value: unknown): value is DaichiMqttModel {
  return isRecord(value) && Array.isArray(value.devices) && value.devices.every(isDeviceUpdate);
}

export function getMqttDeviceUpdates(value: unknown): DeviceUpdate[] | null {
  if (!isRecord(value) || !Array.isArray(value.devices)) {
    return null;
  }

  return value.devices.flatMap((device) => {
    const update = normalizeMqttDeviceUpdate(device);
    return update ? [update] : [];
  });
}

export function isControlEnvelope(value: unknown): value is ControlEnvelope {
  return isRecord(value) &&
    value.done === true &&
    value.errors === null &&
    isDaichiInfoModel(value.data);
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

function isDaichiInfoModel(value: unknown): value is DaichiInfoModel {
  return isRecord(value) && Array.isArray(value.devices) && value.devices.every(isDevice);
}

function isDeviceUpdate(value: unknown): value is DeviceUpdate {
  if (!isRecord(value) ||
    !isPositiveInteger(value.id) ||
    (value.curTemp !== undefined && !isFiniteNumber(value.curTemp)) ||
    (value.status !== undefined && typeof value.status !== 'string')) {
    return false;
  }

  if (value.state !== undefined &&
    (!isRecord(value.state) ||
      (value.state.isOn !== undefined && typeof value.state.isOn !== 'boolean'))) {
    return false;
  }

  return value.pult === undefined ||
    (Array.isArray(value.pult) && value.pult.every(isPult));
}

function normalizeMqttDeviceUpdate(value: unknown): DeviceUpdate | null {
  if (!isRecord(value) || !isPositiveInteger(value.id)) {
    return null;
  }

  const update: DeviceUpdate = { id: value.id };
  if (isFiniteNumber(value.curTemp)) {
    update.curTemp = value.curTemp;
  }
  if (isRecord(value.state) && typeof value.state.isOn === 'boolean') {
    update.state = { isOn: value.state.isOn };
  }

  const functions = normalizeMqttFunctions(value.pult);
  if (functions.length > 0) {
    update.pult = [{ functions }];
  }

  return update;
}

function normalizeMqttFunctions(value: unknown): PultFunctionUpdate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const functions: PultFunctionUpdate[] = [];
  for (const pult of value) {
    if (!isRecord(pult) || !Array.isArray(pult.functions)) {
      continue;
    }

    for (const pultFunction of pult.functions) {
      const normalized = normalizeMqttFunction(pultFunction);
      if (normalized) {
        functions.push(normalized);
      }
    }
  }

  return functions;
}

function normalizeMqttFunction(
  value: unknown,
  ancestors: ReadonlySet<Record<string, unknown>> = new Set(),
  depth = 0,
): PultFunctionUpdate | null {
  if (!isRecord(value) || depth > 16 || ancestors.has(value)) {
    return null;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  const linkedFunction = normalizeMqttFunction(value.linkedFunction, nextAncestors, depth + 1);

  const bleTag = isRecord(value.metaData) &&
    isRecord(value.metaData.bleTagInfo) &&
    typeof value.metaData.bleTagInfo.bleTag === 'string'
    ? value.metaData.bleTagInfo.bleTag
    : null;
  if (!isPositiveInteger(value.id) ||
    !isRecord(value.metaData) ||
    !isRecord(value.metaData.bleTagInfo) ||
    bleTag === null ||
    !MQTT_FUNCTION_TAGS.has(bleTag)) {
    return linkedFunction;
  }

  const bleTagInfo = value.metaData.bleTagInfo;
  const normalized: PultFunctionUpdate = {
    id: value.id,
    metaData: {
      bleTagInfo: {
        bleTag,
      },
    },
  };

  if (typeof value.title === 'string' || value.title === null) {
    normalized.title = value.title;
  }
  if (typeof bleTagInfo.bleOnCommand === 'string' || bleTagInfo.bleOnCommand === null) {
    normalized.metaData.bleTagInfo.bleOnCommand = bleTagInfo.bleOnCommand;
  }

  if (isRecord(value.state)) {
    const state: Partial<PultFunction['state']> = {};
    if (typeof value.state.isOn === 'boolean') {
      state.isOn = value.state.isOn;
    }
    if (isFiniteNumber(value.state.value)) {
      state.value = value.state.value;
    }
    if (isFiniteNumberArray(value.state.valueRange) &&
      (value.title !== 'Fan speed' ||
        bleTagInfo.bleTag !== 'fanSpeed' ||
        isSafeFanSpeedRange(value.state.valueRange))) {
      state.valueRange = [...value.state.valueRange];
    }
    if (Object.keys(state).length > 0) {
      normalized.state = state;
    }
  }

  if (linkedFunction) {
    normalized.linkedFunction = linkedFunction;
  }

  return normalized;
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
