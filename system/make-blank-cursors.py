#!/usr/bin/env python3
"""Writes an invisible cursor theme, so no pointer ever shows on the TV.

Game controller receivers often also present themselves as a mouse, which
makes the compositor and browsers draw a cursor in the middle of the screen.
Usage: make-blank-cursors.py THEME_DIR
"""
import struct
import sys
from pathlib import Path

# Cursor names apps ask for; every one maps to the same transparent image.
NAMES = """
default left_ptr arrow top_left_arrow pointer hand hand1 hand2 pointing_hand
text xterm ibeam vertical-text wait watch progress left_ptr_watch half-busy
crosshair cross tcross cell help question_arrow context-menu alias copy
move fleur grab grabbing openhand closedhand dnd-move dnd-copy dnd-link
dnd-none no-drop not-allowed forbidden crossed_circle all-scroll col-resize
row-resize e-resize w-resize n-resize s-resize ne-resize nw-resize se-resize
sw-resize ew-resize ns-resize nesw-resize nwse-resize zoom-in zoom-out
sb_h_double_arrow sb_v_double_arrow size_hor size_ver size_bdiag size_fdiag
right_ptr center_ptr draft_large draft_small X_cursor pirate
""".split()


def blank_xcursor(size=24):
    # Xcursor file: header, one table-of-contents entry, one 1x1 image.
    image_type, chunk_header = 0xFFFD0002, 36
    header = struct.pack("<4sIII", b"Xcur", 16, 0x10000, 1)
    toc = struct.pack("<III", image_type, size, 16 + 12)
    image = struct.pack("<IIIIIIIII", chunk_header, image_type, size, 1, 1, 1, 0, 0, 0)
    return header + toc + image + struct.pack("<I", 0)  # one fully transparent pixel


def main():
    theme = Path(sys.argv[1])
    cursors = theme / "cursors"
    cursors.mkdir(parents=True, exist_ok=True)
    data = blank_xcursor()
    for name in NAMES:
        (cursors / name).write_bytes(data)
    (theme / "index.theme").write_text(f"[Icon Theme]\nName={theme.name}\nComment=Invisible cursors\n")


if __name__ == "__main__":
    main()
