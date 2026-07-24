import { CtrlMode } from './models/ctrlMode';
import {
  BooleanFunctionControl,
  ControlPayload,
  NumericFunctionControl,
} from './models/apiModel';

export {
  BooleanFunctionControl,
  ControlPayload,
  NumericFunctionControl,
} from './models/apiModel';

export function buildControlPayload(
  cmd: CtrlMode,
  functionId: number,
  value: boolean | number,
  cmdId = getRandomCmdId(),
): ControlPayload {
  const control = isNumericCommand(cmd)
    ? buildNumericControl(functionId, value)
    : buildBooleanControl(functionId, value);

  return { cmdId, value: control, conflictResolveData: null };
}

function buildNumericControl(functionId: number, value: boolean | number): NumericFunctionControl {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Numeric control commands require a finite number value.');
  }

  return { functionId, value, parameters: null };
}

function buildBooleanControl(functionId: number, value: boolean | number): BooleanFunctionControl {
  if (typeof value !== 'boolean') {
    throw new TypeError('Boolean control commands require a boolean value.');
  }

  return { functionId, isOn: value, parameters: null };
}

function isNumericCommand(cmd: CtrlMode): boolean {
  return cmd === CtrlMode.SetTemp || cmd === CtrlMode.FanSpeed;
}

function getRandomCmdId(): number {
  return Math.floor(Math.random() * 100_000_000);
}
