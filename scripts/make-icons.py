#!/usr/bin/env python3
"""Draws each mod's listing icon as a 512x512 PNG, with no dependencies.

Run from the repo root: python3 scripts/make-icons.py
Writes <mod>/.claude-plugin/icon.png for context-lens, cache-guard and lessons.
"""
import math
import struct
import zlib

N = 512
SS = 3  # samples per pixel along each axis, for smooth edges
BG = (30, 41, 59)
DIM = (71, 85, 105)


def png(path, px):
    raw = b''.join(b'\x00' + bytes(c for p in row for c in p) for row in px)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def rrect(x, y, x0, y0, x1, y1, r):
    """Inside a rounded rectangle."""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def draw(shapes):
    """shapes: list of (inside(x, y) -> bool, rgb), later ones on top, over a rounded background."""
    px = []
    for j in range(N):
        row = []
        for i in range(N):
            acc = [0.0, 0.0, 0.0, 0.0]
            for a in range(SS):
                for b in range(SS):
                    x = i + (a + 0.5) / SS
                    y = j + (b + 0.5) / SS
                    if not rrect(x, y, 0, 0, N, N, 112):
                        continue
                    col = BG
                    for inside, c in shapes:
                        if inside(x, y):
                            col = c
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
                    acc[3] += 255
            k = SS * SS
            alpha = acc[3] / k
            if alpha == 0:
                row.append((0, 0, 0, 0))
            else:
                s = 255 / alpha / k
                row.append(tuple(int(round(v * s)) for v in acc[:3]) + (int(round(alpha)),))
        px.append(row)
    return px


def arc(cx, cy, r0, r1, a0, a1):
    """Inside an annulus between angles a0..a1 (degrees, clockwise from 12 o'clock)."""

    def inside(x, y):
        d = math.hypot(x - cx, y - cy)
        if d < r0 or d > r1:
            return False
        ang = (math.degrees(math.atan2(x - cx, cy - y)) + 360) % 360
        return a0 <= ang <= a1

    return inside


def tri(p, q, r):
    def inside(x, y):
        def s(a, b):
            return (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1])

        d1, d2, d3 = s(p, q), s(q, r), s(r, p)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

    return inside


def context_lens():
    teal = [(45, 212, 191), (20, 184, 166), (13, 148, 136)]
    bars = []
    for k, (y, w) in enumerate([(150, 280), (234, 190), (318, 110)]):
        bars.append((lambda x, yy, y=y: rrect(x, yy, 91, y, 421, y + 44, 22), DIM))
        bars.append((lambda x, yy, y=y, w=w: rrect(x, yy, 91, y, 91 + w, y + 44, 22), teal[k]))
    return bars


def cache_guard():
    amber = (251, 191, 36)
    return [
        (arc(256, 256, 120, 160, 0, 360), DIM),
        (arc(256, 256, 120, 160, 0, 270), amber),
        (lambda x, y: (x - 256) ** 2 + (y - 256) ** 2 <= 30 ** 2, amber),
    ]


def lessons():
    violet = (167, 139, 250)
    # A loop that stops short, with an arrowhead where it would close.
    a = math.radians(300)
    ex, ey = 256 + 140 * math.sin(a), 256 - 140 * math.cos(a)
    tx, ty = math.cos(a), math.sin(a)  # clockwise tangent at the end
    nx, ny = math.sin(a), -math.cos(a)  # outward normal
    head = tri(
        (ex + nx * 52, ey + ny * 52),
        (ex - nx * 52, ey - ny * 52),
        (ex + tx * 64, ey + ty * 64),
    )
    return [(arc(256, 256, 120, 160, 20, 300), violet), (head, violet)]


if __name__ == '__main__':
    for name, fn in [('context-lens', context_lens), ('cache-guard', cache_guard), ('lessons', lessons)]:
        png(f'{name}/.claude-plugin/icon.png', draw(fn()))
        print('wrote', f'{name}/.claude-plugin/icon.png')
