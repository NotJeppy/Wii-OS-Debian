# Wii-OS

A fan-made, Wii-style TV menu that runs as the whole user interface of a PC,
built on Debian 13. Plug a PC into your TV, pick up a controller, and get a
channel grid with YouTube, Twitch, Plex, Netflix, Disney+ and Hulu.

Not affiliated with or endorsed by Nintendo. No Nintendo assets are used:
everything is drawn in code and the sounds are synthesized.

## Install

Download the ISO from the latest [release](../../releases/latest) and follow
the steps there. In short: write it to a USB stick with Rufus in **DD Image
mode**, boot from it, and answer the installer's questions. Installing erases
the disk you choose, and it needs an internet connection.

## How it fits together

- `system/install.sh` sets up a minimal Debian box: packages, Google Chrome
  (for DRM), Plex HTPC, auto-login on tty1, controller access and power
  permissions. The ISO runs it at the end of the install.
- `bin/start-session` runs on login and starts **cage** (a kiosk Wayland
  compositor) with `wiid` as its only client.
- `wiid/wiid.py` serves the menu UI on `127.0.0.1:8770`, keeps the menu
  browser running, launches channels on top of it, and turns controllers into
  keyboard input (D-pad/stick = arrows, A = Enter, B = Escape, bumpers =
  PageUp/PageDown). Home closes the running channel.
- `wiid/channels.json` lists channels. A channel is either a web page or a
  native app:
  - `url`: the page, opened in its own browser profile
  - `user_agent`: pretend to be a TV, to get a site's TV interface
  - `drm`: use Google Chrome, which has Widevine (Debian's Chromium doesn't)
  - `spatial_navigation`: let arrow keys move between links on desktop sites
  - `command` / `stop`: run a native app instead, and how to fully close it
- `ui/` is the menu itself (plain HTML/CSS/JS).

## Building the ISO

`build/build-iso.sh` downloads Debian's official netinst ISO, adds the Wii-OS
files and an answer file (`build/preseed.cfg`), and swaps in its own boot
menus. It runs on Linux and needs `xorriso` and `wget`:

```bash
bash build/build-iso.sh out/wii-os.iso
```

Every push to `main` builds the ISO with GitHub Actions
(`.github/workflows/release.yml`) and publishes it as a new release.

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
