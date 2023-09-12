import {
    Service,
    PlatformAccessory,
    Characteristic,
    WithUUID,
    CharacteristicValue,
    Nullable,
    CharacteristicSetCallback,
    CharacteristicGetCallback,
} from 'homebridge';

import {DaichiComfortHomebridgePlatform} from './platform';
import {DevState} from './devState';
import {CtrlMode} from './ctrlMode';
import {
    DaichiInfoModel,
    Device,
    PultFunction,
} from './deviceModel';
import {
    MqttClient,
    connect,
} from 'mqtt';

export class DaichiComfortPlatformAccessory {
    private service: Service;
    private state: DevState;
    private mqttClient: MqttClient | null = null;
    private functionsDict = new Map<CtrlMode, PultFunction>();
    private fanSpeedMinStep: number = 1;

    constructor(
      private readonly platform: DaichiComfortHomebridgePlatform,
      private readonly accessory: PlatformAccessory,
      private readonly dev: Device,
    ) {
        this.state = new DevState();
        this.setFunctionsDict(this.dev);
        this.initDeviceState(this.dev);
        this.fanSpeedMinStep = Math.floor(100 / Math.max(...(this.functionsDict.get(CtrlMode.FanSpeed)?.state?.valueRange ?? [20])));

        // set accessory information
        const model = [this.dev.deviceInfo?.seria, this.dev.deviceInfo?.model].filter(x => x).join(' ');
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.Manufacturer, this.dev.deviceInfo?.brand ?? 'Unknown Manufacturer')
            .setCharacteristic(this.platform.Characteristic.Model, model)
            .setCharacteristic(this.platform.Characteristic.SerialNumber, this.dev.serial);

        this.service = this.accessory.getService(this.platform.Service.HeaterCooler) || this.accessory.addService(this.platform.Service.HeaterCooler);

        // set the service name, this is what is displayed as the default name on the Home app
        this.service.setCharacteristic(this.platform.Characteristic.Name, this.dev.title ?? 'Unknown Name');

        this.service.getCharacteristic(this.platform.Characteristic.Active)
            .on('get', this.handleActiveGet.bind(this))
            .on('set', this.handleActiveSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
            .on('get', this.handleTargetHeaterCoolerStateGet.bind(this))
            .on('set', this.handleTargetHeaterCoolerStateSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
            .on('get', this.handleCurrentHeaterCoolerStateGet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
            .on('get', this.handleCurrentTemperatureGet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
            .on('get', this.handleCoolingThresholdTemperatureGet.bind(this))
            .on('set', this.handleCoolingThresholdTemperatureSet.bind(this))
            .setProps({
                minStep: 1,
                minValue: Math.min(...(this.functionsDict.get(CtrlMode.SetTemp)?.state?.valueRange ?? [0])),
                maxValue: Math.max(...(this.functionsDict.get(CtrlMode.SetTemp)?.state?.valueRange ?? [0])),
            });

        this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
            .on('get', this.handleCoolingThresholdTemperatureGet.bind(this))
            .on('set', this.handleCoolingThresholdTemperatureSet.bind(this))
            .setProps({
                minStep: 1,
                minValue: Math.min(...(this.functionsDict.get(CtrlMode.SetTemp)?.state?.valueRange ?? [0])),
                maxValue: Math.max(...(this.functionsDict.get(CtrlMode.SetTemp)?.state?.valueRange ?? [0])),
            });

        this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
            .on('get', this.handleSwingModeGet.bind(this))
            .on('set', this.handleSwingModeSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
            .on('get', this.handleRotationSpeedGet.bind(this))
            .on('set', this.handleRotationSpeedSet.bind(this))
            .setProps({
                minStep: this.fanSpeedMinStep,
                minValue: 0,
                maxValue: 100,
            });

        const mqttUser = this.platform.getCtrlApi().getMqttUserInfo();

        if(!mqttUser){
            this.platform.log.error('MQTT user is unknown');
        } else {
            this.mqttClient = connect('wss://split.daichicloud.ru/mqtt', {
                username: mqttUser.userName,
                password: mqttUser.password,
            });
            this.mqttClient.on('connect', () => {
                this.mqttClient!.subscribe(`user/${mqttUser.userId}/notification`);
                this.platform.log.debug('Connected to mqtt');
            });
            this.mqttClient.on('message', (topic, message) => {
                const stringMessage = message?.toString() ?? '{}';
                const model = JSON.parse(stringMessage) as DaichiInfoModel;
                const device = model?.devices?.find(x => x.id === this.dev.id);
    
                if(device){
                    this.updateDeviceState(device);
                } else{
                    this.platform.log.error(`MQTT send incorrect message: ${stringMessage}`);
                }
            });
            this.mqttClient.on('disconnect', (packet) => {
                this.platform.log.error(`MQTT is disconnect. Packet: ${JSON.stringify(packet)}`);
            });
            this.mqttClient.on('error', (error) => {
                this.platform.log.error(`MQTT got error: ${error}`);
            });
        }
    }

    protected async ctrl(cmd: CtrlMode, val: boolean | number){
        const deviceId = this.dev.id;
        const functionId = this.functionsDict.get(cmd)?.id;
        if(functionId){
            const commandParameters = `Command parameters: cmd = ${CtrlMode[cmd]}, val = ${val}, functionId = ${functionId}, deviceId = ${deviceId}`;
            this.platform.log.debug(commandParameters);
            const result = await this.platform.getCtrlApi().controlDevice(deviceId, cmd, functionId, val, 2);
            if(result){
                const device = result?.data?.devices?.find(x => x.id === this.dev.id);
                if(device){
                    this.updateDeviceState(device);
                }
            } else{
                this.platform.log.error(commandParameters);
            }
        }
    }

    /**
     * Handle requests to get the current value of the "Active" characteristic
     */
    handleActiveGet(callback: CharacteristicGetCallback) {
        const value = this.getStateActive(this.state.powerState, this.state.online);
        this.platform.log.debug('Triggered GET Active:', value);
        callback(null, value);
    }

    /**
     * Handle requests to set the "Active" characteristic
     */
    async handleActiveSet(value, callback: CharacteristicSetCallback) {
        this.platform.log.debug('Triggered SET Active:', value);
        await this.ctrl(CtrlMode.IsOn, !!value);
        callback(null, value);
    }

    /**
     * Handle requests to get the current value of the "Current Temperature" characteristic
     */
    handleCurrentTemperatureGet(callback: CharacteristicGetCallback) {
        const value = this.getStateCurrentTemperature(this.state.curTemp);
        this.platform.log.debug('Triggered GET CurrentTemperature', value);
        callback(null, value);
    }

    /**
     * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
     */
    handleCurrentHeaterCoolerStateGet(callback: CharacteristicSetCallback) {
        const value = this.getStateCurrentHeaterCoolerState(this.state.powerState, this.state.online, 
            this.state.curTemp, this.state.setTemp, this.state.mode);
            this.platform.log.debug('Triggered GET CurrentHeatingCoolingState', value);
        callback(null, value);
    }

    async handleTargetHeaterCoolerStateSet(val: CharacteristicValue, callback: CharacteristicSetCallback) {
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
        callback(null, val);
    }

    handleTargetHeaterCoolerStateGet(callback: CharacteristicSetCallback) {
        const value = this.getStateTargetHeaterCoolerState(this.state.mode);
        this.platform.log.debug('Triggered GET TargetHeaterCoolerState', value);
        callback(null, value);
    }

    /**
     * Handle requests to get the current value of the "Target Temperature" characteristic
     */
    handleCoolingThresholdTemperatureGet(callback: CharacteristicSetCallback) {
        const value = this.getStateCoolingThresholdTemperature(this.state.setTemp);
        this.platform.log.debug('Triggered GET CoolingThresholdTemperature', value);
        callback(null, value);
    }

    /**
     * Handle requests to set the "Target Temperature" characteristic
     */
    async handleCoolingThresholdTemperatureSet(value, callback: CharacteristicSetCallback) {
        this.platform.log.debug('Triggered SET CoolingThresholdTemperature:', value);
        if (this.state.setTemp !== value) {
            await this.ctrl(CtrlMode.SetTemp, value);
        }
        callback(null, value);
    }

    // Handle requests to get the current value of the "swingMode" characteristic
    handleSwingModeGet(callback: CharacteristicGetCallback) {
        const value = this.getStateSwingMode(this.state.swingMode);
        this.platform.log.debug('Triggered GET SwingMode', value);
        callback(null, value);
    }

    /**
     * Handle requests to set the "swingMode" characteristic
     */
    async handleSwingModeSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
        await this.ctrl(CtrlMode.FanFlow, value === this.platform.Characteristic.SwingMode.SWING_ENABLED);
        this.platform.log.debug('Triggered SET SwingMode:', value);
        callback(null, value);
    }

    /**
     * Handle requests to get the current value of the "RotationSpeed" characteristic
     */
    handleRotationSpeedGet(callback: CharacteristicGetCallback) {
        const value = this.getStateRotationSpeed(this.state.autoFanSpeedIsOn, this.state.fanSpeed);
        this.platform.log.debug('Triggered GET RotationSpeed', value);
        callback(null, value);
    }

    /**
     * Handle requests to set the "RotationSpeed" characteristic
     */
    async handleRotationSpeedSet(value: CharacteristicValue, callback: CharacteristicSetCallback) {
        if(this.state.fanSpeed !== value){
            if(value === 0){
                await this.ctrl(CtrlMode.FanSpeedAuto, true);
            } else{
                await this.ctrl(CtrlMode.FanSpeed, Math.ceil((value as number) / this.fanSpeedMinStep));
            }
        }
        
        this.platform.log.debug('Triggered SET RotationSpeed:', value);
        callback(null, value);
    }

    initDeviceState(device: Device){
        if(!device){
            return;
        }

        const funcDict = DaichiComfortPlatformAccessory.getFunctionsDict(device);

        this.state.curTemp = device.curTemp ?? this.state.curTemp;
        this.state.powerState = device.state?.isOn ?? this.state.powerState;
        this.state.online = device.status !== undefined ? device.status === 'connected' : device.status;

        if(funcDict){
            const setTempFunc = funcDict.get(CtrlMode.SetTemp)?.state?.value;
            const fanSpeedFunc = funcDict.get(CtrlMode.FanSpeed)?.state?.value;
            const autoFanSpeedIsOnFunc = funcDict.get(CtrlMode.FanSpeedAuto)?.state?.isOn;
            const modeFunc = [funcDict.get(CtrlMode.AutoMode)!, funcDict.get(CtrlMode.HeatMode)!, funcDict.get(CtrlMode.CoolMode)!]
                .find(x => x?.state?.isOn === true)?.metaData?.bleTagInfo?.bleOnCommand;
            const swingModeFunc = funcDict.get(CtrlMode.FanFlow)?.state?.isOn;

            this.state.setTemp = setTempFunc ?? this.state.setTemp;
            this.state.fanSpeed = fanSpeedFunc ?? this.state.fanSpeed;
            this.state.autoFanSpeedIsOn = autoFanSpeedIsOnFunc ?? this.state.autoFanSpeedIsOn;
            this.state.mode = modeFunc ?? this.state.mode;
            this.state.swingMode = swingModeFunc ?? this.state.swingMode;
        }
    }

    updateDeviceState(device: Device){
        if(!device){
            return;
        }

        const oldCurTemp = this.state.curTemp;
        const oldPowerState = this.state.powerState;
        const oldOnline = this.state.online;
        const oldSetTemp = this.state.setTemp;
        const oldFanSpeed = this.state.fanSpeed;
        const oldAutoFanSpeedIsOn = this.state.autoFanSpeedIsOn;
        const oldMode = this.state.mode;
        const oldSwingMode = this.state.swingMode;

        this.initDeviceState(device);

        this.chekAndUpdateState(this.getStateActive(oldPowerState, oldOnline),
            this.getStateActive(this.state.powerState, this.state.online),
            this.platform.Characteristic.Active);

        this.chekAndUpdateState(this.getStateCurrentTemperature(oldCurTemp),
            this.getStateCurrentTemperature(this.state.curTemp),
            this.platform.Characteristic.CurrentTemperature);
        
        this.chekAndUpdateState(this.getStateCurrentHeaterCoolerState(oldPowerState, oldOnline, oldCurTemp, oldSetTemp, oldMode),
            this.getStateCurrentHeaterCoolerState(this.state.powerState, this.state.online, this.state.curTemp, this.state.setTemp, this.state.mode),
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

        this.chekAndUpdateState(this.getStateRotationSpeed(oldAutoFanSpeedIsOn, oldFanSpeed),
            this.getStateRotationSpeed(this.state.autoFanSpeedIsOn, this.state.fanSpeed),
            this.platform.Characteristic.RotationSpeed);
    }

    chekAndUpdateState(oldValue: Nullable<CharacteristicValue>, newValue: Nullable<CharacteristicValue>, characteristic: WithUUID<{
        new (): Characteristic;
    }>){
        if(oldValue !== newValue && newValue !== undefined && newValue !== null){
            this.service.getCharacteristic(characteristic).updateValue(newValue);
        }
    }

    getStateActive(powerState: boolean, online: boolean): Nullable<CharacteristicValue>{
        return powerState && online
            ? this.platform.Characteristic.Active.ACTIVE 
            : this.platform.Characteristic.Active.INACTIVE;
    }

    getStateCurrentTemperature(curTemp: number): Nullable<CharacteristicValue>{
        return curTemp;
    }

    getStateCurrentHeaterCoolerState(powerState: boolean, online: boolean, curTemp: number,
        setTemp: number, mode: string): Nullable<CharacteristicValue>{
        let value = this.platform.Characteristic.CurrentHeaterCoolerState.IDLE;

        if (!powerState || !online) {
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

    getStateCoolingThresholdTemperature(setTemp: number): Nullable<CharacteristicValue>{
        return setTemp;
    }

    getStateSwingMode(swingMode: boolean): Nullable<CharacteristicValue>{
        return swingMode 
            ? this.platform.Characteristic.SwingMode.SWING_ENABLED 
            : this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }

    getStateRotationSpeed(autoFanSpeedIsOn: boolean, fanSpeed: number): Nullable<CharacteristicValue>{
        return autoFanSpeedIsOn ? 0 : fanSpeed * this.fanSpeedMinStep;
    }

    setFunctionsDict(device: Device){
        const result = DaichiComfortPlatformAccessory.getFunctionsDict(device);
        if(result){
            this.functionsDict = result;
        }
    }

    static getFunctionsDict(device: Device) : Map<CtrlMode, PultFunction> | null{
        const funcDict = new Map<CtrlMode, PultFunction | null>();
        const functions = DaichiComfortPlatformAccessory.getFunctions(device);

        if(functions.length === 0){
            return null;
        }

        funcDict.set(CtrlMode.IsOn, DaichiComfortPlatformAccessory.searchFunction('power', functions));
        funcDict.set(CtrlMode.SetTemp, DaichiComfortPlatformAccessory.searchFunction('setTemp', functions));
        funcDict.set(CtrlMode.FanFlow, DaichiComfortPlatformAccessory.searchFunction('flow', functions, 'Vertical swing', 'vert_on'));
        funcDict.set(CtrlMode.FanSpeedAuto, DaichiComfortPlatformAccessory.searchFunction('fanSpeed', functions, 'Auto', '0'));
        funcDict.set(CtrlMode.FanSpeed, DaichiComfortPlatformAccessory.searchFunction('fanSpeed', functions, 'Fan speed'));
        funcDict.set(CtrlMode.AutoMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, undefined, 'auto'));
        funcDict.set(CtrlMode.HeatMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, 'Heat', 'heat'));
        funcDict.set(CtrlMode.CoolMode, DaichiComfortPlatformAccessory.searchFunction('mode', functions, 'Cool', 'cool'));

        const result = new Map<CtrlMode, PultFunction>();
        funcDict.forEach((value: PultFunction | null, key: CtrlMode) => {
            if(value){
                result.set(key, value);
            }
        });

        return result;
    }

    static searchFunction(tag : string, functions : PultFunction[], title? : string, onCommand? : string) : PultFunction | null{
        return functions?.find(x => (!title || x.title === title) &&
            (!onCommand || x.metaData?.bleTagInfo?.bleOnCommand === onCommand) &&
            x?.metaData?.bleTagInfo?.bleTag === tag) ?? null;
    }

    static getFunctions(device: Device) : PultFunction[]{
        return device?.pult?.filter(x => (x?.functions))
            .flatMap(x => x.functions)
            .flatMap(fn => (fn.linkedFunction) ? [fn, fn.linkedFunction] : fn) ?? [] as PultFunction[];
    }
}
