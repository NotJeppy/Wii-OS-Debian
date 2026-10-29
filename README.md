![Wii-OS](https://raw.githubusercontent.com/NotJeppy/Playlist-Ids/a167a0bc285c28dae24561f6b2c10c8f44bfaaab/jeppy/tv.png)

# Wii-OS

A fan-made, Wii-style TV menu that runs as the whole user interface of a PC,
built on Debian 13. Plug a PC into your TV, pick up a controller, and get a
channel grid that starts with YouTube and the Channel Shop, where you can add
Twitch, Plex, Moonlight (game streaming from your PC), an Internet browser,
Netflix, Disney+ and Hulu.

Not affiliated with or endorsed by Nintendo. No Nintendo assets are used:
everything is drawn in code and the menu sounds are synthesized. The Channel
Shop's music (`ui/sounds/shop.mp3`) is an original cover made for this
project, not official Nintendo music.

## Controls

| Button | What it does |
|---|---|
| D-pad / left stick | Move |
| A | Choose |
| B | Back |
| X | Pick up a channel to move it (A or X puts it down, B cancels) |
| Y | Channel options, such as deleting it (the Channel Shop can't be deleted) |
| LB / RB | Previous / next page (in the Internet channel: scroll) |
| Right stick | In the Internet channel: move the pointer. A then clicks where it points; the D-pad goes back to link-by-link |
| Home | Close the channel (or the shop) and return to the menu. In Moonlight, **hold** Home for a second; a tap goes to the game |

The **Internet** channel is Google Chrome with a start page for searching or
typing an address. B goes back, Y returns to the start page, and the right
stick moves a Wii-style pointing hand. It rests while the on-screen keyboard is
open.

On Netflix, Disney+, Hulu and the Internet channel, move to a text field and
press **A** (or click it with the pointer) for the on-screen keyboard: the D-pad picks keys, **A** types, **B** closes it, **X**
deletes and **Y** is shift. (YouTube and Twitch have their own on-screen
keyboards, and Plex signs in with a code.) A real USB keyboard still works and
never brings it up.

**Suspend:** pressing Home in a channel pauses it (every process of it is
frozen) instead of closing it, and its tile shows **Paused**. Open it again to
carry on exactly where you were. A paused channel closes for good after 30
minutes, or as soon as you open a different channel. Moonlight is never
paused, since a frozen game stream would drop. Suspend can be turned off in
**Settings**.

**Settings** is on every menu and can't be deleted. It has:

- **Wi-Fi** (when the PC has it): the network you're on, and every network
  nearby with its signal strength. A joins one, and secured networks ask for
  the password on the on-screen keyboard. Y on a saved network forgets it
  (press Y twice). Work and school networks that need a username aren't
  supported yet.
- **Bluetooth** (when the PC has it): put a controller, keyboard or headphones
  in pairing mode and it shows up; A pairs it. Paired devices stay listed: A
  connects or disconnects one, Y (twice) forgets it. Paired controllers
  reconnect by themselves when you turn them on. A keyboard that needs a code
  shows it on screen to type.
- The screen saver delay (never, or 1 to 6 hours without a button press; sound
  playing counts as activity). The screen saver is a dark screen with the logo
  and clock drifting slowly, so nothing burns in. Any button wakes it, and that
  press doesn't reach the app underneath.
- The suspend switch.

The envelope button holds your messages: a permanent record of updates offered
and installed and channels added. A red dot means some are unread.

## Supported devices

**Tested** means someone ran it on that device. **Should work** means the
Linux drivers are there, but nobody has tried it with Wii-OS yet. Reports
either way are welcome.

### Computers

| Device | Status |
|---|---|
| MINISFORUM UM580D (Ryzen 7 5800H, Radeon graphics, MediaTek MT7921K Wi-Fi and Bluetooth, Intel I225-V Ethernet) | Tested |
| VMware virtual machine | Tested, with software rendering (slow but usable) |
| Other 64-bit Intel or AMD PCs, 4 GB of RAM or more | Should work. Without a supported GPU, Wii-OS falls back to software rendering |

### Controllers

| Device | Status |
|---|---|
| 8BitDo Ultimate 2C Wireless (2.4 GHz USB receiver) | Tested |
| Xbox-style controllers over USB or their USB receiver | Should work |
| Xbox Wireless, PlayStation DualShock 4 and DualSense over Bluetooth (Settings → Bluetooth) | Should work, untested |

### Keyboards and remotes

| Device | Status |
|---|---|
| USB keyboards | Tested |
| Bluetooth keyboards (Settings → Bluetooth) | Should work, untested |
| Bluetooth TV remotes that act as a keyboard (many Android TV style remotes) | Arrows, OK and Back should work after pairing, untested. Their Home button doesn't return to the menu yet |
| Roku remotes | Not supported yet (see below) |

**About Roku remotes.** A Roku **simple remote** is infrared, so the PC would
need an IR receiver, such as a USB one that turns remote buttons into key
presses. A Roku **voice or enhanced remote** talks to the Roku over
Wi-Fi Direct: the Roku runs a small private network of its own (it shows up
as `DIRECT-roku-…`) and the remote joins it. The remote's protocol on that
network isn't public, so supporting it means reverse engineering it first.
What is public is Roku's **External Control Protocol**, which the Roku phone
app uses over your home network. Wii-OS could answer it, so the Roku app would
work as a remote. That's planned.

### Audio

| Device | Status |
|---|---|
| TV speakers over HDMI | Tested |
| Bluetooth headphones and speakers (Settings → Bluetooth) | Should work, untested |

## Install

Download the ISO from the latest [release](../../releases/latest) and follow
the steps there. In short: write it to a USB stick with Rufus in **DD Image
mode**, boot from it, and answer the installer's questions. Installing erases
the disk you choose, and it needs an internet connection.

## How it fits together

- `system/install.sh` sets up a minimal Debian box: packages, Google Chrome
  (for DRM), auto-login on tty1, controller access and power permissions. The
  ISO runs it at the end of the install.
- `bin/start-session` runs on login and starts **cage** (a kiosk Wayland
  compositor) with `wiid` as its only client. Without a usable GPU it retries
  with software rendering.
- `wiid/wiid.py` serves the menu UI on `127.0.0.1:8770`, keeps the menu
  browser running, launches channels on top of it, and turns controllers into
  keyboard input (D-pad/stick = arrows, A = Enter, B = Escape, X = `x`,
  Y = `y`, bumpers = PageUp/PageDown). Home closes the running channel.
- `wiid/channels.json` is the shop's catalog. A channel is either a web page
  or a native app:
  - `url`: the page, opened in its own browser profile
  - `user_agent`: pretend to be a TV, to get a site's TV interface
  - `drm`: use Google Chrome, which has Widevine (Debian's Chromium doesn't)
  - `spatial_navigation`: let arrow keys move between links on desktop sites
  - `keyboard`: inject the on-screen keyboard (`ui/osk.js`) into every page
    and frame, through Chrome's DevTools pipe (`wiid/devtools.py`), in an
    isolated world the site's scripts can't touch
  - `command` / `stop`: run a native app instead, and how to fully close it
  - `flatpak` / `flatpak_overrides`: the Flathub app the shop downloads for
    this user when they get the channel (removed again when they delete it)
  - `raw_controller`: hand the real controller to the app (for games) instead
    of turning it into keys; wiid then only watches for Home held for a second
  - `browsing`: inject `ui/browser-helper.js` (B = back, Y = start page, links
    open in place)
  - `pointer`: the right stick drives a virtual mouse (wiid), and
    `ui/pointer.js` draws the hand where it is. The on-screen keyboard tells
    wiid when it opens and closes, through a DevTools binding
- `wiid/home.py` keeps each user's layout in `~/.local/share/wii-os/home.json`
  (12 slots per page, channel id or empty) and handles getting and deleting
  channels. New users start with YouTube and the built-in Channel Shop and
  Settings, which every layout keeps.
- `wiid/network.py` is Settings' Wi-Fi (NetworkManager, through `nmcli`) and
  Bluetooth (BlueZ: state over D-Bus, and a long-running `bluetoothctl` that
  also answers pairing questions). `install.sh` lets the TV user change
  networks without a password, and `system/move-network.py` moves the Wi-Fi
  network the Debian installer set up over to NetworkManager, so it shows in
  Settings (the old setup comes back if NetworkManager isn't online within a
  minute).
- `wiid/settings.py` keeps the Settings channel's options in
  `~/.local/share/wii-os/settings.json`. `wiid.py` pauses channels with
  SIGSTOP on their whole process tree, and shows `ui/screensaver.html` in a
  window of its own after the idle time.
- `wiid/messages.py` keeps the message board in
  `~/.local/share/wii-os/messages.json`. Messages are never deleted.
- `ui/` is the menu itself (plain HTML/CSS/JS): `app.js` (grid, move mode,
  channel options, previews, updates), `shop.js`, `messages.js`, and
  `core.js` for the shared focus and input handling.

## Building the ISO

`build/build-iso.sh` downloads Debian's official netinst ISO, adds the Wii-OS
files and an answer file (`build/preseed.cfg`), and swaps in its own boot
menus. It runs on Linux and needs `xorriso` and `wget`:

```bash
bash build/build-iso.sh out/wii-os.iso
```

Every push to `main` builds the ISO with GitHub Actions
(`.github/workflows/release.yml`) and publishes it as a new release.

## Updates

There is no update server: GitHub Releases is the server. Each release
carries the ISO plus a small update bundle (`wii-os-<version>.tar.gz` and its
`.sha256`). Installed boxes ask GitHub's public API for the latest release
(`wiid/updates.py`) when they start (retrying for a few minutes until the
network is up), when someone wakes the screen saver, and every 6 hours. When a
newer one exists, the menu offers it within seconds, but only while the home
menu is on screen, never while a channel is open. The
offer lists the release's "What's new" bullets, which CI fills in from the
commit messages since the previous release.

- **Update** runs `system/apply-update.sh` through sudo. It downloads the
  bundle, checks its checksum, swaps it in for `/opt/wii-os`, re-runs
  `install.sh` (which also installs any new packages), and restarts the
  session. If anything fails, the previous version is put back.
- **Not now** skips that version. The prompt doesn't come back, but the
  message it left offers **Update now**, and so does the OS menu's **Check for
  updates**.

Every new version leaves a message when it's first seen, whether or not it's
installed, and installing one leaves another, so users have a dated record of
their updates.

A box knows its version and repository from `VERSION` and `update.json`,
which `build/stage.sh` writes. Copies deployed with `deploy.ps1` have neither,
so they never update themselves.

`WII_OS_TEST=1` builds a fully unattended ISO for VM tests. It wipes
`/dev/vda` without asking, so never use it on real hardware.

## Working on a running box

From Windows, with SSH access to the box:

```powershell
.\deploy.ps1            # copy files
.\deploy.ps1 -Restart   # copy and restart the TV session
.\deploy.ps1 -Install   # copy, run system/install.sh, restart
```

Logs on the box: `~/.local/state/wii-os/wiid.log`.
Screenshot of the TV:
`XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/tv.png`.

## License

GPL-3.0. See [LICENSE](LICENSE).
