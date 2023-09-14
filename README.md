# homebridge-daichi-comfort-conditioner

## Overview

Homebridge plugin, providing integration of the air conditioner from the application 'Daichi Comfort'.

This plugin is not official and was created by a person not associated with 'Daichi'. Performance was tested only on one air conditioner, which was connected to the Daichi Cloud via the Wi-Fi controller DW22-B. If you have feedback or were able to test the performance on your device, you can contact me: alexeimotkoff@gmail.com

## Installation

```
npm i -g @alexeimotkoff/homebridge-daichi-comfort-conditioner
```

You can configure the plugin via GUI or JSON.

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

## How to use

After setting up the plugin, you should see a new device in your list of devices.

Unfortunately, I could not find support automatic rotation speed mode for air conditioner. Therefore, there is one feature: automatic rotation speed mode is set when the slider is at 0 percent. If you increase the step, the automatic mode will turn off. If you return to 0 percent, the air conditioner will turn off, but the mode will return to automatic.