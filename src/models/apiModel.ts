import { DaichiInfoModel, Device } from './deviceModel';

export interface TokenResponse {
  data: {
    access_token: string;
  };
}

export interface UserResponse {
  data: {
    id: number;
    mqttUser: {
      username: string;
      password: string;
    };
  };
}

export interface BuildingsResponse {
  data: Building[] | {
    data: Building[];
  };
}

interface Building {
  places: Array<{
    id: number;
  }>;
}

export interface DeviceEnvelope {
  data: Device;
}

export interface BooleanFunctionControl {
  functionId: number;
  isOn: boolean;
  parameters: null;
}

export interface NumericFunctionControl {
  functionId: number;
  value: number;
  parameters: null;
}

export interface ControlPayload {
  cmdId: number;
  value: BooleanFunctionControl | NumericFunctionControl;
  conflictResolveData: null;
}

export interface ControlEnvelope {
  done: true;
  errors: null;
  data: DaichiInfoModel;
}
