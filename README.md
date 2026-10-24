# homebridge-mitsubishi-hi-wifi-module

A [Homebridge](https://homebridge.io/) plugin that brings a **Mitsubishi Heavy Industries (MHI)** air conditioner into Apple HomeKit, using the unit's built-in WiFi module — the same module that serves the *"Climate Control"* web app (firmware model `MHI_CNS_ATA_WIFI`).

No cloud, no MQTT broker required: the plugin talks directly to the module over HTTP on your LAN.

## Features

Exposed as a HomeKit **Heater Cooler** accessory:

| HomeKit control | Device parameter |
| --- | --- |
| On / Off | `power` |
| Mode: Heat / Cool / Auto | `mode` (`heat` / `cool` / `auto`) |
| Target temperature (0.5° steps, limited to the device's heating/cooling range) | `set_temperature` |
| Current temperature | `actual_temperature` |
| Fan speed (4 steps) | `fan` (`1`–`4`) |
| Swing (3D auto airflow) | `auto3d` |
| Heating / Cooling / Idle (idle while the compressor is stopped or defrosting) | `mode`, `op.compr_freq`, `op.defrost` |
| Fault (error code or lost connection to the indoor unit) | `error_code`, `sys.conhp` |

Optional extra switches (toggle in settings):

- **Silent** → `silent_mode`
- **Auto Fan** → `fan=auto` (HomeKit's speed slider can't represent "auto", so it's a separate switch)
- **Dry** → `mode=dry` (HomeKit Heater Cooler has no Dry mode)
- **Fan Only** → `mode=fan`

Read-only sensors (toggle in settings), added only while the device reports them:

- **Outdoor** temperature sensor → `op.outdoor`
- **Humidity** sensor and **Thermometer Battery** → paired wireless thermometer (`sensor.thermometer`)
- **Window 1–4** contact sensors → paired window sensors (`sensor.window`, `sensor.window_1` … `sensor.window_3`)

## Installation

Search for **Mitsubishi HI WiFi** in the Homebridge UI, or:

```bash
npm install -g homebridge-mitsubishi-hi-wifi-module
```

## Configuration

Use the Homebridge UI (recommended), or add to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MitsubishiHIWiFi",
      "name": "Mitsubishi HI WiFi",
      "devices": [
        {
          "name": "Living Room AC",
          "host": "heatpump.local",
          "pollInterval": 10,
          "exposeSilentMode": true,
          "exposeFanAuto": true,
          "exposeDryMode": false,
          "exposeFanMode": false,
          "exposeOutdoorTemperature": true,
          "exposeThermometer": true,
          "exposeWindowSensors": true
        }
      ]
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | `Mitsubishi AC` | Accessory name in the Home app |
| `host` | – | Hostname or IP of the WiFi module, e.g. `heatpump.local` or `192.168.1.50` |
| `pollInterval` | `10` | Seconds between state refreshes |
| `exposeSilentMode` | `true` | Add a *Silent* switch |
| `exposeFanAuto` | `true` | Add an *Auto Fan* switch |
| `exposeDryMode` | `false` | Add a *Dry* mode switch |
| `exposeFanMode` | `false` | Add a *Fan Only* mode switch |
| `exposeOutdoorTemperature` | `true` | Add an *Outdoor* temperature sensor |
| `exposeThermometer` | `true` | Add *Humidity* and *Thermometer Battery* while a wireless thermometer is paired |
| `exposeWindowSensors` | `true` | Add a contact sensor per paired window sensor |

> **Tip:** Give the unit a static DHCP lease (or rely on its `.local` mDNS name) so the `host` stays stable.

You can add multiple `devices` entries to control several units.

## How it works

The WiFi module exposes one endpoint:

- `GET /control` — returns the full state as JSON.
- `GET /control?cmd=heatpump&<param>=<value>` — sets one heatpump parameter.

The plugin polls `/control` every `pollInterval` seconds and maps the `heatpump` object onto HomeKit characteristics; writes are sent as `cmd=heatpump` commands and reflected back on the next refresh.

## Notes & limitations

- HomeKit's Heater Cooler service only models Heat / Cool / Auto. **Dry** and **Fan-only** modes are therefore exposed as optional switches.
- The device has a single `set_temperature`, so the Heating and Cooling threshold sliders both drive (and reflect) that one setpoint. The Heating slider uses the device's heating range, the Cooling slider its cooling range.
- When the fan runs on *auto*, the speed slider keeps showing the last manual speed.
- Protection states reported by the unit (e.g. high-pressure protection) are logged as warnings.
- The window sensor state format couldn't be verified without a paired sensor. Unrecognised values are logged once instead of guessed.
- Fan speed maps the 4 hardware steps onto the HomeKit slider (25 % each). Setting the slider to 0 % powers the unit off.

## License

MIT
