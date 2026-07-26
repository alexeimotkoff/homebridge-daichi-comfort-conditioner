export interface DaichiInfoModel {
    devices: Device[];
}

export interface DaichiMqttModel {
  devices: DeviceUpdate[];
}

export interface DaichiInfoCtrlModel {
  data: DaichiInfoModel;
}

export interface DaichiInfoDevice {
  data: Device;
}

export interface Device {
  id: number;
  serial: string;
  status: string;
  curTemp?: number;
  state: DeviceState;
  pult: Pult[];
  deviceInfo: DeviceInfo | undefined;
  title: string | undefined;
}

export interface DeviceUpdate {
  id: number;
  curTemp?: number;
  status?: string;
  state?: Partial<DeviceState>;
  pult?: PultUpdate[];
}

export interface DeviceInfo{
  brand: string;
  seria: string;
  model: string;
}

export interface DeviceState {
  isOn: boolean;
}

export interface Pult {
  functions: PultFunction[];
}

export interface PultUpdate {
  functions: PultFunctionUpdate[];
}

export interface State {
  value?: number | null;
  isOn: boolean;
  valueRange?: number[];
}

export interface PultFunction {
  id: number;
  title?: string | null;
  state: State;
  metaData: MetaData;
  linkedFunction?: PultFunction | null;
}

export interface PultFunctionUpdate {
  id: number;
  title?: string | null;
  state?: Partial<State>;
  metaData: MetaData;
  linkedFunction?: PultFunctionUpdate | null;
}

export interface MetaData {
  bleTagInfo: BleTagInfo;
}

export interface BleTagInfo {
  bleTag: string;
  bleOnCommand?: string | null;
}
