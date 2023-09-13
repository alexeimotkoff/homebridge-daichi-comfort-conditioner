import {API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {DaichiComfortPlatformAccessory} from './platformAccessory';
import {HttpApi} from './api';
import {ConfigDevice} from './models/configModel';


/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class DaichiComfortHomebridgePlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    // this is used to track restored cached accessories
    public readonly accessories: PlatformAccessory[] = [];

    protected httpApi!: HttpApi;
    public getCtrlApi(){
        return this.httpApi;
    }

    constructor(
      public readonly log: Logger,
      public readonly config: PlatformConfig,
      public readonly api: API,
    ) {
        if (!this.config) {
            this.log.info('No config found in configuration file, disabling plugin.');
            return;
        }
      
        if (this.config.username === undefined ||
            this.config.password === undefined ||
            this.config.name === undefined){
                this.log.error('Missing required config parameter.');
                return;
        }

        this.log.debug('Finished initializing platform:', this.config.name);

        this.httpApi = new HttpApi(this.config.username, this.config.password, this.log);

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', () => {
            log.debug('Executed didFinishLaunching callback');
            // run the method to discover / register your devices as accessories

            this.discoverDevices();
        });
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);

        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(accessory);
    }

    async discoverDevices() {
        await this.httpApi.login();
        let devices = (await this.httpApi.getDevices() ?? []).filter(x => x?.data?.serial);

        const configDeviceNames = (this.config?.devices as ConfigDevice[])
            ?.filter(x => x?.name)
            .map(x => x.name.toLowerCase()) ?? [] as string[];
        if(devices && configDeviceNames && configDeviceNames.length > 0){
            devices = devices.filter(x => x.data?.title && configDeviceNames.includes(x.data.title));
        }

        if(devices === undefined || devices.length === 0){
            this.log.info('Devices not found');
            return;
        }

        // loop over the discovered devices and register each one if it has not already been registered
        for (const device of devices) {
            // generate a unique id for the accessory this should be generated from
            // something globally unique
            const uuid = this.api.hap.uuid.generate(device.data.serial);

            // see if an accessory with the same uuid has already been registered and restored from
            // the cached devices we stored in the `configureAccessory` method above
            const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

            if (existingAccessory) {
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
                this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
            }

            // the accessory does not yet exist, so we need to create it
            this.log.info('Adding new accessory:', device.data.serial);

            // create a new accessory
            const accessory = new this.api.platformAccessory(device.data.title ?? 'Unknown Name', uuid);

            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new DaichiComfortPlatformAccessory(this, accessory, device.data);

            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
    }
}
