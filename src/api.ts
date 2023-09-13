import axios from 'axios';
import {Logger} from 'homebridge';
import {MqttUser} from './models/mqttUser';
import {CtrlMode} from './models/ctrlMode';
import {
    DaichiInfoDevice,
    DaichiInfoCtrlModel,
} from './models/deviceModel';

axios.defaults.baseURL = 'https://web.daichicloud.ru/api/v4/';

export class HttpApi {
    constructor(
      protected readonly userName: string,
      protected readonly password: string,
      protected readonly log: Logger,
    ) {

    }

    private apiToken: string | null = null;
    private mqttUser: MqttUser | null = null;

    public async login() {
        try {
            const resp = await axios.post('token', {
                grant_type: 'password',
                email: this.userName,
                password: this.password,
                clientId: 'sOJO7B6SqgaKudTfCzqLAy540cCuDzpI'});
            this.apiToken = resp.data?.data?.access_token;
            if(!this.apiToken){
                this.log.error('login: Unauthorized! Invalid token');
                return;
            }
            this.log.info('logged in');
            await this.setMqttUserInfo();
        } catch (e){
            this.log.error((<Error>e).message);
        }
    }

    public getMqttUserInfo(): MqttUser | null{
        return this.mqttUser;
    }

    public async getDevices(): Promise<DaichiInfoDevice[]>{
        let results: DaichiInfoDevice[] = [];
        try{
            const buildings = await this.api().get('buildings');
            this.log.debug(`Buildings: ${JSON.stringify(buildings.data)}`);
            const devices = buildings.data.data.flatMap(x => x.places);
            results = await Promise.all(devices.map(async (x) => {
                return await this.getState(x.id) as (DaichiInfoDevice | null);
            }));
        } catch (e){
            this.log.error((<Error>e).message);
        }

        return results.filter(x => x);
    }

    public async controlDevice(devId: number, cmd: CtrlMode, functionId: number, val: boolean | number, retryCount: number): Promise<DaichiInfoCtrlModel | null>{
        if(retryCount === 0){
            return null;
        }

        if(val === null || val === undefined){
            this.log.error(`controlDevice: val has value is ${val}`);
            return null;
        }

        let deviceFunctionControl;
        if(cmd === CtrlMode.SetTemp || cmd === CtrlMode.FanSpeed){
            deviceFunctionControl = {
                functionId: functionId,
                value: val,
                parameters: null,
            }; 
        } else{
            deviceFunctionControl = {
                functionId: functionId,
                isOn: val,
                parameters: null,
            }; 
        }

        let result;

        try{
            result = await this.api().post(`devices/${devId}/ctrl?ignoreConflicts=false`, {
                cmdId: HttpApi.getRandomIntInclusive(0, 99999999),
                value: deviceFunctionControl,
                conflictResolveData: null,
            });
            if(result.status !== 200){
                this.log.error(`controlDevice: Status code is ${result.status}`);

                if(result.status === 401){
                    this.log.error('controlDevice: Unauthorized! Invalid token');
                    await this.login();
                    retryCount--;
                    return (await this.controlDevice(devId, cmd, functionId, val, retryCount));
                }
            }
        } catch (e){
            this.log.error((<Error>e).message);
        }

        return result.data;
    }

    private api(){
        if (this.apiToken !== null){
            axios.defaults.headers.common['Authorization'] = 'Bearer ' + this.apiToken;
        }
        return axios;
    }
    
    private async getState(devId: number): Promise<DaichiInfoDevice | null>{
        let deviceData: DaichiInfoDevice | null = null;
        try{
            const result = await this.api().get(`devices/${devId}`);
            deviceData = result.data;
        } catch (e){
            this.log.error((<Error>e).message);
        }

        return deviceData;
    }

    private async setMqttUserInfo() {
        try {
            const resp = await this.api().get('user');
            this.log.debug(JSON.stringify(resp.data));
            if(resp.data?.data?.mqttUser?.username &&
                resp.data?.data?.mqttUser?.password &&
                resp.data?.data?.id){
                this.mqttUser = new MqttUser(
                    resp.data.data.mqttUser.username,
                    resp.data.data.mqttUser.password,
                    resp.data.data.id);
            }
        } catch (e){
            this.log.error((<Error>e).message);
        }
    }

    private static getRandomIntInclusive = (min: number, max: number): number => {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };
}