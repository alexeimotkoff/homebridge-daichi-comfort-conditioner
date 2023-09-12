export interface DaichiInfoModel {
    devices: Device[];
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
  curTemp: number;
  state: DeviceState;
  pult: Pult[];
  deviceInfo: DeviceInfo | undefined;
  title: string | undefined;
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

export interface State {
  value?: number;
  isOn: boolean;
  valueRange?: number[];
}

export interface PultFunction {
  id: number;
  title?: string;
  state: State;
  metaData: MetaData;
  linkedFunction?: PultFunction;
}

export interface MetaData {
  bleTagInfo: BleTagInfo;
}

export interface BleTagInfo {
  bleTag: string;
  bleOnCommand?: string;
}
  