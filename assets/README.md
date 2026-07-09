# Assets folder

The town works right now with no files in here — it falls back to the
built-in pixel-CSS look. Drop in real sprites and it automatically upgrades
to using them. No code changes needed.

## Where to get real, free, zero-risk assets

**Kenney.nl** — public domain (CC0), made specifically for top-down RPG
towns, no attribution required, safe to use however you like:

- **RPG Urban Pack** → https://kenney.nl/assets/rpg-urban-pack
  (buildings, café, shop, market stall, houses — exactly what this town needs)
- **RPG Base** → https://kenney.nl/assets/rpg-base
  (characters, simple terrain tiles)

Download the zip from each page (free, one click, no signup).

## What to copy where

Inside Kenney's zip you'll find a folder of individual PNG files (not one
giant sprite sheet — much easier to work with). Pick files you like and
rename/copy them into these three folders:

```
assets/tiles/ground.png        — any grass/dirt/path tile → tiled as the base ground
assets/buildings/cafe.png      — a building/house sprite for the café
assets/buildings/workshop.png
assets/buildings/academy.png
assets/buildings/garden.png
assets/buildings/market.png
assets/buildings/park.png
assets/buildings/hall.png
assets/buildings/gallery.png
assets/buildings/giftshop.png
assets/buildings/terminal.png
assets/buildings/runway.png
assets/buildings/entrance.png
assets/buildings/corridor.png
assets/buildings/vault.png
assets/buildings/house1.png … house4.png   — a few house variants, cycled across the 16 homes
assets/characters/player.png
assets/characters/kid.png
assets/characters/teen.png
assets/characters/adult.png
assets/characters/senior.png
assets/characters/extra1.png … extra4.png  — a few background-crowd variants
```

You don't have to fill in every single one — anything you skip just falls
back to the current CSS look automatically. Add a few at a time and refresh
to see the difference.

## If you want proper walking-animation frames later

Kenney's character sheets do include multi-frame walk cycles, but slicing
them correctly needs knowing their exact pixel layout. Upload one of the
actual PNG files back to me once you've downloaded the pack, and I'll wire
up real frame-by-frame walking animation instead of a single static pose.
