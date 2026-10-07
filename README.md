<span align="center">

<a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img alt="homebridge-verified" src="https://raw.githubusercontent.com/homebridge/branding/master/logos/homebridge-color-round.png" width="80px"></a>
<img alt="SimpliSafe Logo" src="https://raw.githubusercontent.com/homebridge-simplisafe3/homebridge-simplisafe3/master/.github/simplisafe_logo_wplus.png" width="380px" />

# Homebridge SimpliSafe 3 Cameras (Edited)
Based on homebridge-simplisafe3, created by [Niccolò Zapponi](https://twitter.com/nzapponi) and [Michael Shamoon](https://github.com/shamoon).

[![npm-version](https://badgen.net/npm/v/homebridge-simplisafe3)](https://www.npmjs.com/package/homebridge-simplisafe3)
[![npm-downloads](https://badgen.net/npm/dt/homebridge-simplisafe3)](https://www.npmjs.com/package/homebridge-simplisafe3)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

An [unofficial] [Homebridge](https://github.com/homebridge/homebridge) plugin that brings SimpliSafe cameras to HomeKit, alongside homebridge-simplisafe3 for the alarm, sensors and locks.

</span>

## About this edited version
This is a camera-only fork of [homebridge-simplisafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) with faster cameras, Outdoor Camera support and HomeKit Secure Video recording (see the [change log](CHANGELOG.md)). It is packaged as **homebridge-simplisafe3-edited** so it can be installed **next to** the original plugin without touching it:

- it only has cameras: the alarm, sensors and locks stay with the original plugin. This one never changes them, it only reads the alarm state to know when a SimpliCam's privacy shutter is closed
- its own platform (`SimpliSafe 3 Edited`) and its own SimpliSafe login (`simplisafe3auth-edited.json`), so the two never sign each other out
- its own snapshot folder and log file in the Homebridge storage folder


### Installing alongside the original
1. In the Homebridge UI open the terminal (top right menu, **Terminal**) and run the install command listed for the latest release in the [change log](CHANGELOG.md). It looks like this:
   ```
   npm install --prefix /var/lib/homebridge https://github.com/williamorman-oss/Edited-homebridge-simplisafe3/raw/<commit>/releases/homebridge-simplisafe3-edited-<version>.tgz
   ```
   Use your Homebridge storage folder if it is not `/var/lib/homebridge` (e.g. `/homebridge` in Docker). Each release's link points at a fixed commit, so it never changes. npm records it in the storage folder's `package.json`, so it has to stay available.
2. Restart Homebridge. **SimpliSafe 3 Cameras (Edited)** appears under Plugins.
3. Open its settings and log in to SimpliSafe (this is a separate login from the original plugin). The name you give it (default `SimpliSafe Cameras`) is what its log lines start with. Save.
4. Under the plugin's **Bridge Settings**, turn on the child bridge and restart Homebridge.
5. In the Home app add the new bridge (Add Accessory, then scan the child bridge's QR code from the Homebridge UI).

Once you are happy with it, turn off `cameras` in the original plugin so cameras are not handled twice. A camera is the same accessory in both plugins, so if both have cameras on and share a bridge, this one cannot add them and says so in the log. The original keeps its old camera tiles (without video) until you remove them: in the Homebridge UI go to Settings, **Remove Single Cached Accessory**, and remove the camera accessories of the original plugin's bridge. Automations that used those old camera tiles need to be set up again on the new ones.

To remove this version, uninstall **SimpliSafe 3 Cameras (Edited)** from the Plugins page and remove its bridge from the Home app. If installing or updating any plugin ever fails with a 404 for `homebridge-simplisafe3-edited`, run `npm uninstall --prefix /var/lib/homebridge homebridge-simplisafe3-edited` and then install it again with the current link. Restoring a Homebridge backup does not reinstall this version (it is not on npm), run the install command again afterwards.

### Logs for Claude
The plugin's settings page has a **Logs for Claude** card. It shows this plugin's recent log lines (up to about 800), each camera's state at the top, and a **Copy logs for Claude** button to paste them into a conversation with Claude.

- Removed before anything is kept: passwords, tokens, email addresses, MAC addresses, Wi-Fi names and account numbers. Camera serial numbers stay, they are needed to match events to cameras.
- The lines are kept in `simplisafe3-edited-logs.txt` in the Homebridge storage folder, written at most every 10 seconds. The plugin does not send them anywhere.
- Turn on **Debug** (Advanced Options) for detail such as live view and snapshot timings, each camera's capabilities, when cameras wake and sleep, how late SimpliSafe's motion and doorbell events arrive, and the video and audio format of Outdoor Cameras. Turn off **Keep Logs for Claude** (`"logsForClaude": false`) to stop keeping them.
- **Motion Test** (`cameraOptions.motionTest`, Advanced Camera Settings) is for a test session only. After each motion or doorbell event it measures how soon the camera's video arrives and how soon SimpliSafe's own clip of the event, which starts a few seconds before it, can be read. Each event then wakes a battery camera (at most once a minute per camera), so turn it off again afterwards. Reading the clip sends the SimpliSafe login only to simplisafe.com, and no links are logged.

## Requirements
- Works with native Homebridge and [oznu/docker-homebridge](https://github.com/oznu/docker-homebridge).
- Compatible with the official [Config UI X plugin](https://github.com/oznu/homebridge-config-ui-x) which is **recommended for easiest usage**.

## Features
- **Live view** of every SimpliSafe camera in the Home app, with audio. Newer cameras (Outdoor Camera, Video Doorbell Series 2) are passed through without transcoding.
- **Recording** with HomeKit Secure Video, per camera. See [Recording](#recording-homekit-secure-video).
- **Motion and doorbell** notifications with an image of the event.
- **Battery level** and charging state of battery cameras.

## Usage

This plugin supports installation and changing settings (for `config.js`) via the popular [Config UI X plugin](https://github.com/oznu/homebridge-config-ui-x) which is recommended for easiest usage.

Install this edited version as described in [Installing alongside the original](#installing-alongside-the-original). If you configure it by hand, add the following to the `platforms` array in your Homebridge `config.json` and then proceed with <a href="#simplisafe-authentication">authentication</a>.


```
{
    "platform": "homebridge-simplisafe3-edited.SimpliSafe 3 Edited",
    "name": "SimpliSafe Cameras"
}
```

### SimpliSafe Authentication

In 2021, SimpliSafe transitioned to only supporting a protocol called OAuth for authentication. This requires the user to authenticate in a browser and it is not possible to circumvent this and authenticate directly against the API. This plugin provides two ways to obtain credentials:

 1. Users of [Config UI X](https://github.com/oznu/homebridge-config-ui-x) (which is included in many Homebridge installations) can initiate this process from the plugin settings. A button will launch the authentication process and you will have to copy and paste the final URL back into the plugin settings. This process involves a few steps:
     1. Upon clicking the "Launch SimpliSafe Login" button you are taken to the SimpliSafe login page. If you are already logged in this step is skipped.
     2. You will be redirected to a page requesting you to approve the login, either via email or 2FA.
     3. After approval, most browsers will not redirect you to the final URL (begins with *com.SimpliSafe.mobile://*) but will show an error in the console from which you will need to copy & paste the URL back into the Homebridge settings UI. See notes below about using certain browsers / platforms.

    - :information_source: **Many browsers (e.g. Chrome) will not redirect you and will only show an error in the Console** (e.g. View > Developer Tools > Javascript Console) and you will have to copy and paste the URL from the error message.
    - Safari v15.1+ neither displays the URL in the console nor visually in the URL bar and thus is not recommended for this process.
    - Also note that this process cannot be performed on a mobile device.

 1. Alternatively the plugin provides a command-line method for authenticating. The process works the same as above and can be run using `homebridge-simplisafe3-edited login`. If you are using a non-standard storage location for Homebridge pass the `-d` argument e.g. `homebridge-simplisafe3-edited login -d /var/lib/homebridge`.

### Optional Parameters

#### `cameraOptions`
Camera settings, see [Camera Support](#camera-support).

#### `debug`
Type: boolean (default `false`)

Switch this on to get more details about your cameras and plugin behavior in your Homebridge logs. This can be useful if you are having trouble or need to report an issue.

#### `subscriptionId` (aka Account Number)
Type: string

Add this parameter in case you have multiple protected locations or accounts with SimpliSafe, this is your "account number" in Simplisafe. The best way to ensure you have the correct number is to check under the [SimpliSafe web control panel > View Account](https://webapp.simplisafe.com/#/account) and look for **account #** next to the correct plan. For most users this is the same as the serial number at the bottom of your base unit.

#### `persistAccessories`
Type: boolean (default `true`)

By default, the plugin will persist accessories to avoid losing automations etc. Set this to `false` to remove cameras that no longer exist in SimpliSafe from HomeKit.

#### `excludedDevices`
Type: array

Accepts a list of SimpliSafe camera serial numbers (which can be found in the SS app) and excludes these cameras from HomeKit.

### Supported Cameras

Camera                 | Supported          | Notes
---------------------- | ------------------ | -------------------------------------------------
SimpliCam              | :white_check_mark: | Audio, video, motion*, no microphone
Video Doorbell Pro     | :white_check_mark: | Audio, video, motion, no microphone
Video Doorbell Series 2| :white_check_mark: | Audio, video, motion, no microphone
Outdoor Camera         | :white_check_mark: | Audio, video, motion, battery level, no microphone. See [Battery cameras](#battery-cameras)
Wireless Indoor Camera | :grey_question:    | Untested, may work, please [report your findings](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3/discussions/new?category=general)

\* SimpliCams provide motion notifications only if the privacy shutter is open.

### Camera Support
Cameras stream one of two ways depending on the model. The SimpliCam and Video Doorbell Pro use SimpliSafe's original streaming endpoint and are transcoded with ffmpeg. Newer cameras such as the Video Doorbell Series 2 stream over SimpliSafe's LiveKit service, and their H.264 video is passed through to HomeKit untouched, so no video transcoding happens at all (audio is still converted).

Only the SimpliCam, Video Doorbell Pro and Video Doorbell Series 2 have been tested against real hardware. Other newer cameras may work if SimpliSafe streams them the same way, and [#240](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3/discussions/240) is the place to report whether they do.

#### Snapshots
HomeKit sends a bridge's requests one at a time: camera snapshots and starting a live view all wait for the request before them. Fetching a new snapshot takes a few seconds (longer if a battery camera has to wake up), so the plugin answers snapshot requests straight away with the most recent image and refreshes it in the background. Tiles in the Home app may therefore show an image that is a few seconds old (a few minutes for battery cameras). Doorbell and motion notifications always wait briefly for a new image. For Outdoor Cameras that image is SimpliSafe's own image of the event when it is ready within 3 seconds (usually under 1), which saves waking the camera; set `eventImages` to `false` to always ask the camera instead. The last image of each camera is kept on disk so tiles show something straight after a restart.

#### Recording (HomeKit Secure Video)
HomeKit can record cameras listed in `record` (Advanced Camera Settings), by the names used in the SimpliSafe app. After restarting Homebridge, choose **Stream & Allow Recording** for each of them in the Home app. This needs a home hub (Apple TV or HomePod) and an iCloud+ plan: 50 GB covers one camera, 200 GB five, 2 TB any number. The cameras stay paired, recording is added to them; remove a camera from the list to take recording away again.

SimpliSafe reports motion to the plugin 4-8 seconds after it happens. A recording therefore normally starts a few seconds after the motion began: the camera is woken (or joined, if already awake) when SimpliSafe's event arrives, and its video goes to HomeKit as it is, with audio converted to AAC. Cameras that are plugged in can be listed in `alwaysConnected` as well: the plugin then keeps them streaming and holds the last few seconds, so a recording starts with the moments before SimpliSafe's event. That uses about 2 Mbps per Outdoor Camera all the time (roughly 650 GB a month); remove the camera from the list to stop. Battery cameras record for at most a minute each time, others up to three minutes. The SimpliCam only records while its privacy shutter is open for the alarm state.

```
"cameraOptions": {
    "record": ["Front Door", "Side Yard", "Back Yard"],
    "alwaysConnected": ["Side Yard"]
}
```

#### Battery cameras
Battery cameras such as the Outdoor Camera sleep between events, and every snapshot or live view wakes them, which takes 5-10 seconds and uses battery. A live view opened while the camera is being woken for a snapshot, or a second viewer, shares that connection instead of waking it again, and the connection closes as soon as nothing uses it. While a battery camera is not charging its snapshot is only refreshed when it is more than `batterySnapshotMinutes` (default `10`) old, or for a motion notification. Cameras that are plugged in or charging from a solar panel refresh every minute. If a camera does not respond (e.g. its battery is empty) the plugin shows a placeholder image and waits longer and longer between attempts. Battery cameras also report their battery level and charging state to HomeKit.

#### Camera Options
This plugin includes [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) to automatically include a compatible build of ffmpeg and thus the plugin works "out of the box" without requiring a custom ffmpeg build.

For advanced scenarios including specifying a custom ffmpeg build or command line arguments, you can set them via plugin settings in Config UI X or manually in `config.json`\*:

```
"cameraOptions": {
    "ffmpegPath": "/path/to/custom/ffmpeg",
    "sourceOptions": "-probesize 500000",
    "videoOptions": "-preset ultrafast -tune false",
    "audioOptions": "-b:a 32k",
    "batterySnapshotMinutes": 10,
    "eventImages": true,
    "motionTest": false
}
```

Any arguments provided in `sourceOptions`, `videoOptions` and `audioOptions` will be added to the list of arguments passed to ffmpeg, or will replace the default ones if these already exist.
To add an argument that requires no additional parameter, e.g. `-re`, then add it as `"-re"`.
To remove a default argument, define it with `false` as its value, e.g. `"-tune false"`.

*Note that `sourceOptions`, `videoOptions`, `audioOptions` and hardware acceleration only affect cameras that are transcoded (SimpliCam, Video Doorbell Pro), so they have no effect on e.g. the Video Doorbell Series 2 or Outdoor Camera.*

#### FFMPEG Hardware Acceleration
 The bundled build of ffmpeg *includes* hardware acceleration on supported Raspberry Pi models (disabled as of Raspberry Pi 5) but in order to enable this you must check the setting **Advanced Camera Settings** > **Enable Hardware Acceleration for Raspberry Pi** (or set `"enableHwaccelRpi"` under `"cameraOptions"` to `true` in `config.json`).

*Note that enabling this option assumes you are using the bundled version of ffmpeg and thus may not work if you specify a custom one.*

## Known Issues
- If you are running Homebridge [oznu/docker-homebridge](https://github.com/oznu/docker-homebridge) camera streaming is limited to 720px wide.
- Due to transcoding requirements, when using a Raspberry Pi 3b video feeds will disconnect after ~20 seconds. RPi 4 or newer is recommended. See [issue #147](https://github.com/nzapponi/homebridge-simplisafe3/issues/147)

## Help & Support
All feedback is welcomed. For bugs please open an issue here. For feature requests or questions please use discussions.

The official [Homebridge Discord server](https://discord.gg/kqNCe2D) and [Reddit community](https://www.reddit.com/r/homebridge/) are other great places to ask for help.
