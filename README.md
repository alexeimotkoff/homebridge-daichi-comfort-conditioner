# homebridge-daichi-comfort-conditioner

## Overview

Homebridge plugin, providing integration of the air conditioner from the application 'Daichi Comfort'.

Version 2.0 uses the Daichi Cloud HTTP API for commands and a shared MQTT connection for device-state updates. It supports Node.js 22.12+ (verified on 22.19.0) and Node.js 24.x (verified on 24.15.0), with Homebridge 1.9.0 and current Homebridge 2.x releases.

This plugin is not official and was created by a person not associated with 'Daichi'. Performance was tested only on one air conditioner, which was connected to the Daichi Cloud via the Wi-Fi controller DW22-B. If you have feedback or were able to test the performance on your device, you can contact me: alexeimotkoff@gmail.com

## Installation

```
npm i -g @alexeimotkoff/homebridge-daichi-comfort-conditioner
```

You can configure the plugin via GUI or JSON.

When upgrading to 2.0, keep the same platform configuration. The plugin preserves the established platform identity and accessory UUIDs, safely reuses Homebridge's cached accessories, and does not require removing the accessory cache or pairing the accessories again.

## How to configure via GUI

Enter your credentials into the plugin setup form.

In the "Name" field you can specify your platform name or leave it unchanged.

You can add the name of your device from the 'Daichi Comfort' application to the list of devices (it must match what is written in the application, case is not important) or leave this list empty by deleting the automatically added device. If the list of devices is empty, then all available devices will be added.

## How to configure via JSON

```json
{
  "platform": "DaichiComfortConditioner",
  "name": "Daichi Comfort",
  "username": "xxxx@xxxx.xxx",
  "password": "xxxxxxxxxx",
  "devices": []
}
```
or

```json
{
  "platform": "DaichiComfortConditioner",
  "name": "Daichi Comfort",
  "username": "xxxx@xxxx.xxx",
  "password": "xxxxxxxxxx",
  "devices": [
    {
        "name": "my device"
    }
  ]
}
```

if you are adding a specific device.

Properties:

- `platform` Required. The name of platform in Homebridge.
- `username` Required. Username in 'Daichi Comfort'.
- `password` Required. Password in 'Daichi Comfort'.
- `devices` Optional. List of device names to add.

The `devices` has these properties:

- `name` Optional. Name of device.

## Cloud and MQTT lifecycle

The plugin signs in to Daichi Cloud during device discovery, loads the available devices, and establishes one MQTT connection for the platform. MQTT updates are routed to the matching accessory; HomeKit reads and writes use the current cloud state and update the accessory after a successful command. On Homebridge shutdown, the MQTT connection is closed cleanly.

Cached accessories are retained for devices that are still returned by a successful cloud discovery. Stale cached accessories are removed only after a successful discovery, so a temporary cloud or network error does not delete working accessories.

## Troubleshooting

- Confirm the Daichi Comfort username, password, and device-name filter in the Homebridge configuration.
- Check the Homebridge log for the cloud login, discovery, or MQTT connection error category; do not share credentials or complete MQTT payloads when asking for help.
- Restart Homebridge after changing configuration or updating the plugin. Do not delete the accessory cache as the first troubleshooting step: it is normally preserved across updates.
- This release intentionally keeps the existing function selection and swing mapping behavior unchanged.

## How to use

After setting up the plugin, you should see a new device in your list of devices.

Unfortunately, I could not find support automatic rotation speed mode for air conditioner. Therefore, there is one feature: automatic rotation speed mode is set when the slider is at 0 percent. If you increase the step, the automatic mode will turn off. If you return to 0 percent, the air conditioner will turn off, but the mode will return to automatic.
