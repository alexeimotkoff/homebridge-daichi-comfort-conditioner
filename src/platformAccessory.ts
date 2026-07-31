import {
    Service,
    PlatformAccessory,
    Characteristic,
    WithUUID,
    CharacteristicValue,
    Nullable,
} from 'homebridge';
import {DaichiComfortHomebridgePlatform} from './platform';
import {DevState} from './models/devState';
import {CtrlMode} from './models/ctrlMode';
import {
    Device,
    DeviceUpdate,
    PultFunctionUpdate,
} from './models/deviceModel';

type GetHandler = () => Promise<Nullable<CharacteristicValue>>;
type SetHandler = (value: CharacteristicValue) => Promise<void>;

interface CharacteristicBinding {
    characteristic: Characteristic;
    getHandler?: GetHandler;
    setHandler?: SetHandler;
}

interface RuntimeCharacteristicHandlers {
    getHandler?: unknown;
    setHandler?: unknown;
}

interface FunctionCommand {
    id: number;
    valueRange?: number[];
}

const TURBO_SHUTDOWN_DELAY_MS = 1000;

const LOGGED_CONTROL_MODES = [
    CtrlMode.IsOn,
    CtrlMode.SetTemp,
    CtrlMode.FanFlow,
    CtrlMode.FanSpeedAuto,
    CtrlMode.FanSpeed,
    CtrlMode.AutoMode,
    CtrlMode.HeatMode,
    CtrlMode.CoolMode,
    CtrlMode.Turbo,
] as const;

const LOGGED_HAP_CHARACTERISTICS = [
    'Active',
    'TargetHeaterCoolerState',
    'CurrentHeaterCoolerState',
    'CurrentTemperature',
    'CoolingThresholdTemperature',
    'HeatingThresholdTemperature',
    'SwingMode',
    'RotationSpeed',
] as const;

const SUPPORTED_MODES = new Set(['auto', 'heat', 'cool']);

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber);
}

function isIntegerInRange(value: unknown, valueRange: unknown): value is number {
    if(!isFiniteNumber(value) || !Number.isInteger(value) || !isFiniteNumberArray(valueRange)){
        return false;
    }

    return value >= Math.min(...valueRange) && value <= Math.max(...valueRange);
}

function isPositiveInteger(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

function isSupportedMode(value: unknown): value is string {
    return typeof value === 'string' && SUPPORTED_MODES.has(value);
}

export class DaichiComfortPlatformAccessory {
    private service!: Service;
    private state: DevState;
    private functionsDict = new Map<CtrlMode, FunctionCommand>();
    private readonly hapCharacteristics = new Map<string, Characteristic>();
    private fanSpeedMinStep: number = 1;
    private activated = false;
    private createdService = false;
    private bindings: CharacteristicBinding[] = [];

    constructor(
      private readonly platform: DaichiComfortHomebridgePlatform,
      private readonly accessory: PlatformAccessory,
      private readonly dev: Device,
      activate: boolean = true,
    ) {
        this.state = new DevState();
        this.setFunctionsDict(this.dev);
        this.initDeviceState(this.dev);

        if (activate) {
            this.activate();
        }
    }

    /** Attach Homebridge services and characteristic handlers once discovery commits. */
    public activate(force: boolean = false): void {
        if (this.activated && !force) {
            return;
        }
        const rebindExistingService = force && this.activated;
        if (rebindExistingService) {
            this.unbindCallbacks();
            this.activated = false;
        }

        try {
        // set accessory information
        const model = [this.dev.deviceInfo?.seria, this.dev.deviceInfo?.model].filter(x => x).join(' ');
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, this.dev.deviceInfo?.brand ?? 'Unknown Manufacturer')
            .setCharacteristic(this.platform.Characteristic.Model, model)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.dev.serial);

        const existingService = rebindExistingService ? this.service :
            this.accessory.getService(this.platform.Service.HeaterCooler);
        this.service = existingService || this.accessory.addService(this.platform.Service.HeaterCooler);
        if (!rebindExistingService) {
            this.createdService = !existingService;
        }

        // set the service name, this is what is displayed as the default name on the Home app
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.dev.title ?? 'Unknown Name');

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.Active),
            this.handleActiveGet.bind(this),
            this.handleActiveSet.bind(this),
            'Active',
        );

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState),
            this.handleTargetHeaterCoolerStateGet.bind(this),
            this.handleTargetHeaterCoolerStateSet.bind(this),
            'TargetHeaterCoolerState',
        );

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState),
            this.handleCurrentHeaterCoolerStateGet.bind(this),
            undefined,
            'CurrentHeaterCoolerState',
        );

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature),
            this.handleCurrentTemperatureGet.bind(this),
            undefined,
            'CurrentTemperature',
        );

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature),
            this.handleCoolingThresholdTemperatureGet.bind(this),
            this.handleCoolingThresholdTemperatureSet.bind(this),
            'CoolingThresholdTemperature',
        )
            .setProps({
                minStep: 1,
                minValue: Math.min(...(this.functionsDict.get(CtrlMode.SetTemp)?.valueRange ?? [0])),
                maxValue: Math.max(...(this.functionsDict.get(CtrlMode.SetTemp)?.valueRange ?? [0])),
            });

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature),
            this.handleCoolingThresholdTemperatureGet.bind(this),
            this.handleCoolingThresholdTemperatureSet.bind(this),
            'HeatingThresholdTemperature',
        )
            .setProps({
                minStep: 1,
                minValue: Math.min(...(this.functionsDict.get(CtrlMode.SetTemp)?.valueRange ?? [0])),
                maxValue: Math.max(...(this.functionsDict.get(CtrlMode.SetTemp)?.valueRange ?? [0])),
            });

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.SwingMode),
            this.handleSwingModeGet.bind(this),
            this.handleSwingModeSet.bind(this),
            'SwingMode',
        );

        this.bindCharacteristic(
            this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed),
            this.handleRotationSpeedGet.bind(this),
            this.handleRotationSpeedSet.bind(this),
            'RotationSpeed',
        )
            .setProps({
                minStep: this.fanSpeedMinStep,
                minValue: 0,
                maxValue: 100,
            });

        this.activated = true;
        } catch (error) {
            try {
                this.cleanupBindings(!rebindExistingService);
            } catch {
                this.platform.log.warn('Failed to clean up accessory activation');
            }
            throw error;
        }
    }

    /** Remove only bindings and service created by this handler instance. */
    public deactivate(): void {
        this.cleanupBindings();
        this.activated = false;
    }

    private bindCharacteristic(
        characteristic: Characteristic,
        getHandler?: GetHandler,
        setHandler?: SetHandler,
        characteristicName?: string,
    ): Characteristic {
        if (characteristicName) {
            this.hapCharacteristics.set(characteristicName, characteristic);
        }
        const loggedSetHandler = setHandler && characteristicName
            ? async (value: CharacteristicValue): Promise<void> => {
                this.logHapSet(characteristicName, characteristic, value);
                await setHandler(value);
            }
            : setHandler;
        this.bindings.push({characteristic, getHandler, setHandler: loggedSetHandler});
        if (getHandler) {
            characteristic.onGet(getHandler);
        }
        if (loggedSetHandler) {
            characteristic.onSet(loggedSetHandler);
        }
        return characteristic;
    }

    private cleanupBindings(removeCreatedService: boolean = true): void {
        this.unbindCallbacks();
        let cleanupError: unknown;
        if (removeCreatedService && this.createdService) {
            try {
                this.accessory.removeService(this.service);
            } catch (error) {
                cleanupError ??= error;
            }
            this.createdService = false;
        }
        if (cleanupError) {
            throw cleanupError;
        }
    }

    private unbindCallbacks(): void {
        let cleanupError: unknown;
        const bindings = this.bindings;
        this.bindings = [];
        for (const binding of bindings.reverse()) {
            try {
                const runtime = binding.characteristic as unknown as RuntimeCharacteristicHandlers;
                if (binding.getHandler && runtime.getHandler === binding.getHandler) {
                    binding.characteristic.removeOnGet();
                }
                if (binding.setHandler && runtime.setHandler === binding.setHandler) {
                    binding.characteristic.removeOnSet();
                }
            } catch (error) {
                cleanupError ??= error;
            }
        }
        if (cleanupError) {
            throw cleanupError;
        }
    }

    /**
     * Sending a control request to the device
     * @param cmd Specific command from list.
     * @param val Command value: can be a boolean or numeric value.
     */
    protected async ctrl(cmd: CtrlMode, val: boolean | number){
        const deviceId = this.dev.id;
        let functionId = this.functionsDict.get(cmd)?.id;
        let deviceResponse: Device | undefined;
        let refreshError: unknown;
        if(!functionId){
            this.platform.log.debug(
                `ctrl: Missing functionId, refreshing device: device=${deviceId}, cmd=${CtrlMode[cmd]}`,
            );
            try {
                deviceResponse = await this.platform.refreshDeviceState(deviceId);
                if(deviceResponse){
                    this.updateDeviceState(deviceResponse);
                }
            } catch(error) {
                refreshError = error;
            }
            functionId = this.functionsDict.get(cmd)?.id;
        }
        if(!functionId){
            const responseJson = JSON.stringify(deviceResponse ?? null);
            const refreshErrorMessage = refreshError === undefined
                ? ''
                : `, refreshError=${refreshError instanceof Error ? refreshError.message : 'Unknown error'}`;
            const message = `Unknown functionId for device=${deviceId}, cmd=${CtrlMode[cmd]}, ` +
                `deviceResponse=${responseJson}${refreshErrorMessage}`;
            this.platform.log.error(`ctrl: ${message}`);
            throw new Error(message);
        }

        const commandParameters = `device=${deviceId}, cmd=${CtrlMode[cmd]}, function=${functionId}, value=${val}`;
        this.platform.log.debug(`Sending control request: ${commandParameters}`);
        try {
            const device = await this.platform.getCtrlApi().controlDevice(deviceId, cmd, functionId, val);
            this.updateDeviceState(device);
            this.platform.log.debug(`Accepted control request: ${commandParameters}`);
        } catch(error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.platform.log.error(`Failed control request: ${commandParameters}: ${message}`);
            throw error;
        }
    }

    /**
     * Handle requests to get the current value of the "Active" characteristic
     */
    async handleActiveGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateActive(this.state.powerState);
        this.platform.log.debug('Triggered GET Active:', value);
        return value;
    }

    /**
     * Handle requests to set the "Active" characteristic
     */
    async handleActiveSet(value: CharacteristicValue): Promise<void> {
        this.platform.log.debug('Triggered SET Active:', value);
        const isOn = !!value;
        if(isOn && this.state.powerState){
            return;
        }
        await this.ctrl(CtrlMode.IsOn, isOn);
    }

    /**
     * Handle requests to get the current value of the "Current Temperature" characteristic
     */
    async handleCurrentTemperatureGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateCurrentTemperature(this.state.curTemp);
        this.platform.log.debug('Triggered GET CurrentTemperature', value);
        return value;
    }

    /**
     * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
     */
    async handleCurrentHeaterCoolerStateGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateCurrentHeaterCoolerState(this.state.powerState,
            this.state.curTemp, this.state.setTemp, this.state.mode);
        this.platform.log.debug('Triggered GET CurrentHeatingCoolingState', value);
        return value;
    }

    /**
     * Handle requests to set the "TargetHeaterCoolerState" characteristic
     */
    async handleTargetHeaterCoolerStateSet(val: CharacteristicValue): Promise<void> {
        let modeName: CtrlMode;
        switch(val) {
            case this.platform.Characteristic.TargetHeaterCoolerState.HEAT: { 
                modeName = CtrlMode.HeatMode;
               break; 
            }
            case this.platform.Characteristic.TargetHeaterCoolerState.COOL: { 
                modeName = CtrlMode.CoolMode; 
               break; 
            }
            default: { 
                modeName = CtrlMode.AutoMode;
                break; 
             } 
        }
        await this.ctrl(modeName, true);

        this.platform.log.debug('Triggered SET TargetHeaterCoolerState: ', val);
    }

    /**
     * Handle requests to get the current value of the "Target Heater Cooler State" characteristic
     */
    async handleTargetHeaterCoolerStateGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateTargetHeaterCoolerState(this.state.mode);
        this.platform.log.debug('Triggered GET TargetHeaterCoolerState', value);
        return value;
    }

    /**
     * Handle requests to get the current value of the "Target Temperature" characteristic
     */
    async handleCoolingThresholdTemperatureGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateCoolingThresholdTemperature(this.state.setTemp);
        this.platform.log.debug('Triggered GET CoolingThresholdTemperature', value);
        return value;
    }

    /**
     * Handle requests to set the "Target Temperature" characteristic
     */
    async handleCoolingThresholdTemperatureSet(value: CharacteristicValue): Promise<void> {
        this.platform.log.debug('Triggered SET CoolingThresholdTemperature:', value);
        if (this.state.setTemp !== value) {
            await this.ctrl(CtrlMode.SetTemp, value as number);
        }
    }

    /**
     * Handle requests to get the current value of the "Swing Mode" characteristic
     */
    async handleSwingModeGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateSwingMode(this.state.swingMode);
        this.platform.log.debug('Triggered GET SwingMode', value);
        return value;
    }

    /**
     * Handle requests to set the "Swing Mode" characteristic
     */
    async handleSwingModeSet(value: CharacteristicValue): Promise<void> {
        await this.ctrl(CtrlMode.FanFlow, value === this.platform.Characteristic.SwingMode.SWING_ENABLED);
        this.platform.log.debug('Triggered SET SwingMode:', value);
    }

    private logHapSet(
        characteristicName: string,
        characteristic: Characteristic,
        value: CharacteristicValue,
    ): void {
        const iid = characteristic.iid ?? 'unassigned';
        this.platform.log.debug(
            `HAP SET: device=${this.dev.id}, characteristic=${characteristicName}, uuid=${characteristic.UUID}, ` +
            `iid=${iid}, value=${value}, functionIds={${this.getLoggedFunctionIds()}}, ` +
            `characteristicIids={${this.getLoggedCharacteristicIids()}}`,
        );
    }

    /** Log the complete current cloud-function and HAP-characteristic ID snapshot. */
    public logHapRefresh(): void {
        this.platform.log.debug(
            `HAP REFRESH: device=${this.dev.id}, functionIds={${this.getLoggedFunctionIds()}}, ` +
            `characteristicIids={${this.getLoggedCharacteristicIids()}}, ` +
            `characteristicValues={${this.getLoggedCharacteristicValues()}}, ` +
            `state={${this.getLoggedState()}}`,
        );
    }

    private getLoggedFunctionIds(): string {
        return LOGGED_CONTROL_MODES
            .map(cmd => `${CtrlMode[cmd]}:${this.functionsDict.get(cmd)?.id ?? 'unknown'}`)
            .join(', ');
    }

    private getLoggedCharacteristicIids(): string {
        return LOGGED_HAP_CHARACTERISTICS
            .map(name => `${name}:${this.hapCharacteristics.get(name)?.iid ?? 'unassigned'}`)
            .join(', ');
    }

    private getLoggedCharacteristicValues(): string {
        return [
            `Active:${this.getStateActive(this.state.powerState)}`,
            `TargetHeaterCoolerState:${this.getStateTargetHeaterCoolerState(this.state.mode)}`,
            'CurrentHeaterCoolerState:' +
                this.getStateCurrentHeaterCoolerState(
                    this.state.powerState,
                    this.state.curTemp,
                    this.state.setTemp,
                    this.state.mode,
                ),
            `CurrentTemperature:${this.getStateCurrentTemperature(this.state.curTemp)}`,
            `CoolingThresholdTemperature:${this.getStateCoolingThresholdTemperature(this.state.setTemp)}`,
            `HeatingThresholdTemperature:${this.getStateCoolingThresholdTemperature(this.state.setTemp)}`,
            `SwingMode:${this.getStateSwingMode(this.state.swingMode)}`,
            'RotationSpeed:' +
                this.getStateRotationSpeed(
                    this.state.powerState,
                    this.state.autoFanSpeedIsOn,
                    this.state.fanSpeed,
                ),
        ].join(', ');
    }

    private getLoggedState(): string {
        return [
            `powerState:${this.state.powerState}`,
            `curTemp:${this.state.curTemp}`,
            `setTemp:${this.state.setTemp}`,
            `mode:${this.state.mode}`,
            `fanSpeed:${this.state.fanSpeed}`,
            `autoFanSpeedIsOn:${this.state.autoFanSpeedIsOn}`,
            `swingMode:${this.state.swingMode}`,
            `turboModeIsOn:${this.state.turboModeIsOn}`,
        ].join(', ');
    }

    /**
     * Handle requests to get the current value of the "RotationSpeed" characteristic
     */
    async handleRotationSpeedGet(): Promise<Nullable<CharacteristicValue>> {
        const value = this.getStateRotationSpeed(
            this.state.powerState,
            this.state.autoFanSpeedIsOn,
            this.state.fanSpeed,
        );
        this.platform.log.debug('Triggered GET RotationSpeed', value);
        return value;
    }

    /**
     * Handle requests to set the "RotationSpeed" characteristic
     */
    async handleRotationSpeedSet(value: CharacteristicValue): Promise<void> {
        const currentValue = this.getStateRotationSpeed(
            this.state.powerState,
            this.state.autoFanSpeedIsOn,
            this.state.fanSpeed,
        );
        if(currentValue !== value){
            if(this.state.turboModeIsOn){
                await this.ctrl(CtrlMode.Turbo, false);
                await new Promise<void>(resolve => setTimeout(resolve, TURBO_SHUTDOWN_DELAY_MS));
            }
            if(value === 0){
                await this.ctrl(CtrlMode.FanSpeedAuto, true);
            } else{
                await this.ctrl(CtrlMode.FanSpeed, Math.ceil((value as number) / this.fanSpeedMinStep));
            }
        }
        
        this.platform.log.debug('Triggered SET RotationSpeed:', value);
    }

    /**
     * Initializing the device state
     * @param device Device
     */
    initDeviceState(device: DeviceUpdate){
        if(!device){
            return;
        }

        const funcDict = DaichiComfortPlatformAccessory.getFunctionsDict(device);

        if(isFiniteNumber(device.curTemp)){
            this.state.curTemp = device.curTemp;
        }
        if(isBoolean(device.state?.isOn)){
            this.state.powerState = device.state.isOn;
        }

        if(funcDict){
            const setTempFunc = funcDict.get(CtrlMode.SetTemp)?.state?.value;
            const fanSpeedFunction = DaichiComfortPlatformAccessory.getFanSpeedFunction(device);
            const fanSpeedFunc = fanSpeedFunction?.state?.value;
            const manualFanSpeedIsOnFunc = fanSpeedFunction?.state?.isOn;
            const autoFanSpeedIsOnFunc = fanSpeedFunction?.linkedFunction?.state?.isOn;
            const fanSpeedValueRange = isFiniteNumberArray(fanSpeedFunction?.state?.valueRange)
                ? fanSpeedFunction.state.valueRange
                : this.functionsDict.get(CtrlMode.FanSpeed)?.valueRange;
            const isValidManualFanSpeed = manualFanSpeedIsOnFunc === true &&
                isIntegerInRange(fanSpeedFunc, fanSpeedValueRange);
            const modeFunc = [funcDict.get(CtrlMode.AutoMode)!, funcDict.get(CtrlMode.HeatMode)!, funcDict.get(CtrlMode.CoolMode)!]
                .find(x => x?.state?.isOn === true)?.metaData?.bleTagInfo?.bleOnCommand;
            const swingModeFunc = funcDict.get(CtrlMode.FanFlow)?.state?.isOn;
            const turboModeIsOnFunc = funcDict.get(CtrlMode.Turbo)?.state?.isOn;

            if(isFiniteNumber(setTempFunc)){
                this.state.setTemp = setTempFunc;
            }
            if(isValidManualFanSpeed){
                this.state.fanSpeed = fanSpeedFunc;
            }
            if(isBoolean(autoFanSpeedIsOnFunc)){
                this.state.autoFanSpeedIsOn = autoFanSpeedIsOnFunc;
            } else if(isValidManualFanSpeed){
                this.state.autoFanSpeedIsOn = false;
            }
            if(isSupportedMode(modeFunc)){
                this.state.mode = modeFunc;
            }
            if(isBoolean(swingModeFunc)){
                this.state.swingMode = swingModeFunc;
            }
            if(isBoolean(turboModeIsOnFunc)){
                this.state.turboModeIsOn = turboModeIsOnFunc;
            }
        }
    }

    /**
     * Update the device state
     * @param device Device
     */
    updateDeviceState(device: DeviceUpdate){
        if(!device){
            return;
        }

        const oldCurTemp = this.state.curTemp;
        const oldPowerState = this.state.powerState;
        const oldSetTemp = this.state.setTemp;
        const oldFanSpeed = this.state.fanSpeed;
        const oldAutoFanSpeedIsOn = this.state.autoFanSpeedIsOn;
        const oldMode = this.state.mode;
        const oldSwingMode = this.state.swingMode;

        this.setFunctionsDict(device);
        this.initDeviceState(device);

        this.chekAndUpdateState(this.getStateActive(oldPowerState),
            this.getStateActive(this.state.powerState),
            this.platform.Characteristic.Active);

        this.chekAndUpdateState(this.getStateCurrentTemperature(oldCurTemp),
            this.getStateCurrentTemperature(this.state.curTemp),
            this.platform.Characteristic.CurrentTemperature);
        
        this.chekAndUpdateState(this.getStateCurrentHeaterCoolerState(oldPowerState, oldCurTemp, oldSetTemp, oldMode),
            this.getStateCurrentHeaterCoolerState(this.state.powerState, this.state.curTemp, this.state.setTemp, this.state.mode),
            this.platform.Characteristic.CurrentHeaterCoolerState);

        this.chekAndUpdateState(this.getStateTargetHeaterCoolerState(oldMode),
            this.getStateTargetHeaterCoolerState(this.state.mode),
            this.platform.Characteristic.TargetHeaterCoolerState);

        this.chekAndUpdateState(this.getStateCoolingThresholdTemperature(oldSetTemp),
            this.getStateCoolingThresholdTemperature(this.state.setTemp),
            this.platform.Characteristic.CoolingThresholdTemperature);

        this.chekAndUpdateState(this.getStateSwingMode(oldSwingMode),
            this.getStateSwingMode(this.state.swingMode),
            this.platform.Characteristic.SwingMode);

        this.chekAndUpdateState(this.getStateRotationSpeed(oldPowerState, oldAutoFanSpeedIsOn, oldFanSpeed),
            this.getStateRotationSpeed(this.state.powerState, this.state.autoFanSpeedIsOn, this.state.fanSpeed),
            this.platform.Characteristic.RotationSpeed);
    }

    /**
     * Updates the state of a specific device characteristic if the new and old values differ
     * @param oldValue Old value of a specific device characteristic
     * @param newValue New value of a specific device characteristic
     * @param characteristic Characteristic
     */
    chekAndUpdateState(oldValue: Nullable<CharacteristicValue>, newValue: Nullable<CharacteristicValue>, characteristic: WithUUID<{
        new (): Characteristic;
    }>){
        if(oldValue !== newValue && newValue !== undefined && newValue !== null){
            this.service.getCharacteristic(characteristic).updateValue(newValue);
        }
    }

    /**
     * Get state Active characteristic
     */
    getStateActive(powerState: boolean): Nullable<CharacteristicValue>{
        return powerState
            ? this.platform.Characteristic.Active.ACTIVE 
            : this.platform.Characteristic.Active.INACTIVE;
    }

    /**
     * Get state Current Temperature characteristic
     */
    getStateCurrentTemperature(curTemp: number): Nullable<CharacteristicValue>{
        return curTemp;
    }

    /**
     * Get state Current Heater Cooler State characteristic
     */
    getStateCurrentHeaterCoolerState(powerState: boolean, curTemp: number,
        setTemp: number, mode: string): Nullable<CharacteristicValue>{
        let value = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;

        if (!powerState) {
            value = this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        } else{
            if(mode === 'heat'){
                value = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
            } else if(mode === 'cool'){
                value = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
            } else if(curTemp > setTemp){
                value = this.platform.Characteristic.CurrentHeaterCoolerState.COOLING;
            } else if(curTemp < setTemp){
                value = this.platform.Characteristic.CurrentHeaterCoolerState.HEATING;
            }
        }

        return value;
    }

    /**
     * Get state Target Heater Cooler State characteristic
     */
    getStateTargetHeaterCoolerState(mode: string): Nullable<CharacteristicValue>{
        let value = this.platform.Characteristic.TargetHeaterCoolerState.AUTO;

        if(mode === 'cool'){ 
            value = this.platform.Characteristic.TargetHeaterCoolerState.COOL;
        }
        if(mode === 'heat') {
            value = this.platform.Characteristic.TargetHeaterCoolerState.HEAT;
        }

        return value;
    }

    /**
     * Get state Cooling Threshold Temperature characteristic
     */
    getStateCoolingThresholdTemperature(setTemp: number): Nullable<CharacteristicValue>{
        return setTemp;
    }

    /**
     * Get state Swing Mode characteristic
     */
    getStateSwingMode(swingMode: boolean): Nullable<CharacteristicValue>{
        return swingMode 
            ? this.platform.Characteristic.SwingMode.SWING_ENABLED 
            : this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }

    /**
     * Get state Rotation Speed characteristic
     */
    getStateRotationSpeed(
        powerState: boolean,
        autoFanSpeedIsOn: boolean,
        fanSpeed: number,
    ): Nullable<CharacteristicValue>{
        return !powerState || autoFanSpeedIsOn ? 0 : fanSpeed * this.fanSpeedMinStep;
    }

    /**
     * Set a dictionary of functions
     * @device Device
     */
    setFunctionsDict(device: DeviceUpdate){
        const result = DaichiComfortPlatformAccessory.getFunctionsDict(device);
        if(result){
            result.forEach((value, key) => {
                const current = this.functionsDict.get(key);
                const receivedId = isPositiveInteger(value.id) ? value.id : current?.id;
                if(receivedId === undefined){
                    return;
                }
                const candidateValueRange: unknown = value.state?.valueRange;
                const receivedValueRange = isFiniteNumberArray(candidateValueRange) &&
                    (key !== CtrlMode.FanSpeed ||
                        Math.floor(100 / Math.max(...candidateValueRange)) > 0)
                    ? candidateValueRange
                    : undefined;
                const valueRange = receivedValueRange ?? current?.valueRange;
                const valueRangeChanged = receivedValueRange !== undefined &&
                    (current?.valueRange?.length !== receivedValueRange.length ||
                    receivedValueRange.some((item, index) => current?.valueRange?.[index] !== item));

                if(!current || current.id !== receivedId || valueRangeChanged){
                    this.functionsDict.set(key, {
                        id: receivedId,
                        ...(valueRange !== undefined ? {valueRange: [...valueRange]} : {}),
                    });
                }
            });
            this.fanSpeedMinStep = Math.floor(100 /
                Math.max(...(this.functionsDict.get(CtrlMode.FanSpeed)?.valueRange ?? [20])));
        }
    }

    /**
     * Get a dictionary of functions
     * @device Device
     */
    static getFunctionsDict(device: DeviceUpdate) : Map<CtrlMode, PultFunctionUpdate> | null{
        const funcDict = new Map<CtrlMode, PultFunctionUpdate | null>();
        const functions = DaichiComfortPlatformAccessory.getFunctions(device);
        const fanSpeedFunction = DaichiComfortPlatformAccessory.getFanSpeedFunction(device);

        if(functions.length === 0){
            return null;
        }

        funcDict.set(CtrlMode.IsOn, DaichiComfortPlatformAccessory.searchFunction('power', functions));
        funcDict.set(CtrlMode.SetTemp, DaichiComfortPlatformAccessory.searchFunction('setTemp', functions));
        funcDict.set(CtrlMode.FanFlow, DaichiComfortPlatformAccessory.searchFunction('flow', functions, undefined, 'vert_on'));
        funcDict.set(
            CtrlMode.FanSpeedAuto,
            fanSpeedFunction?.linkedFunction ??
                DaichiComfortPlatformAccessory.searchFunction('fanSpeed', functions, 'Auto', '0'),
        );
        funcDict.set(CtrlMode.FanSpeed, fanSpeedFunction);
        funcDict.set(CtrlMode.AutoMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, undefined, 'auto'));
        funcDict.set(CtrlMode.HeatMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, 'Heat', 'heat'));
        funcDict.set(CtrlMode.CoolMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, 'Cool', 'cool'));
        funcDict.set(CtrlMode.Turbo, DaichiComfortPlatformAccessory.searchFunction('powerfull', functions, 'Turbo'));

        const result = new Map<CtrlMode, PultFunctionUpdate>();
        funcDict.forEach((value: PultFunctionUpdate | null, key: CtrlMode) => {
            if(value){
                result.set(key, value);
            }
        });

        return result;
    }

    /**
     * Searches for a specific function in the list of functions
     * @tag Tag in function
     * @functions List of functions
     * @title Title in function
     * @onCommand OnCommand value in function
     */
    static searchFunction(
        tag : string,
        functions : PultFunctionUpdate[],
        title? : string,
        onCommand? : string,
    ) : PultFunctionUpdate | null{
        return functions?.find(x => (!title || x.title === title) &&
            (!onCommand || x.metaData?.bleTagInfo?.bleOnCommand === onCommand) &&
            x?.metaData?.bleTagInfo?.bleTag === tag) ?? null;
    }

    /**
     * Get list of functions from device
     * @device Device
     */
    static getFunctions(device: DeviceUpdate) : PultFunctionUpdate[]{
        return DaichiComfortPlatformAccessory.getDirectFunctions(device)
            .flatMap(fn => (fn.linkedFunction) ? [fn, fn.linkedFunction] : fn) ?? [] as PultFunctionUpdate[];
    }

    private static getDirectFunctions(device: DeviceUpdate): PultFunctionUpdate[] {
        return device?.pult?.filter(x => x?.functions)
            .flatMap(x => x.functions) ?? [];
    }

    private static getFanSpeedFunction(device: DeviceUpdate): PultFunctionUpdate | null {
        return DaichiComfortPlatformAccessory.searchFunction(
            'fanSpeed',
            DaichiComfortPlatformAccessory.getDirectFunctions(device),
            'Fan speed',
        );
    }
}
