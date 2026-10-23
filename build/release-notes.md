A Wii-style TV menu that runs as a whole operating system on a PC, built on Debian 13. Built from commit @COMMIT@ on top of `@DEBIAN_ISO@`.

> [!WARNING]
> Installing **erases the disk you choose**. Back up anything on it first.

## What you need

- A 64-bit PC (Intel or AMD) with at least 4 GB of RAM, connected to a TV over HDMI
- A USB stick of 2 GB or more (it gets erased too)
- An internet connection during the install (Ethernet is easiest; Wi-Fi works)
- A USB keyboard for the install, and a game controller (Xbox-style controllers, including 8BitDo, work best)

## Install

1. Download the `.iso` below.
2. Open [Rufus](https://rufus.ie), pick your USB stick, then select the ISO and press **START**.
3. When Rufus asks, choose **DD Image mode**. In ISO mode the installer usually can't find its own files.
4. Boot the PC from the USB stick (usually F7, F12 or Esc at power-on) and choose **Install Wii-OS**.
5. Answer the installer's questions: language, keyboard, Wi-Fi, time zone, your account, and which disk to use.
6. When it reboots, remove the USB stick. The PC boots straight into the menu.

## Controls

| Button | What it does |
|---|---|
| D-pad / left stick | Move |
| A | Choose |
| B | Back |
| X | Pick up a channel to move it (A or X puts it down, B cancels) |
| Y | Channel options, such as deleting it |
| LB / RB | Previous / next page |
| Home | Close the channel and return to the menu |

The menu starts with YouTube and the **Channel Shop**. Get more channels (Twitch, Plex, Netflix, Disney+, Hulu) from the shop. Updates and new channels are recorded in your messages, under the envelope button.

No keyboard needed: on Netflix, Disney+ and Hulu, move to a text field and press **A** to bring up the on-screen keyboard (**B** closes it, **X** deletes, **Y** is shift). On Linux these services usually limit video to 720p.

Wii-OS is a fan project. It is not affiliated with or endorsed by Nintendo, Google, Netflix, Disney, Hulu, Plex or Twitch.
