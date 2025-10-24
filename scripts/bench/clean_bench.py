#!/usr/bin/env python3
"""
Clean all bench artifacts to restart fresh.

Removes:
- docs/publication/artifacts/*
- docs/publication/figures/*
- docs/publication/results/* (keeps directory)

Use with caution.
"""
import os, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'docs' / 'publication' / 'artifacts'
FIG = ROOT / 'docs' / 'publication' / 'figures'
RES = ROOT / 'docs' / 'publication' / 'results'

def rm_children(p: Path):
    if not p.exists():
        return
    for child in p.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            try:
                child.unlink()
            except FileNotFoundError:
                pass

def main():
    print(f"[clean] Removing children of {ART}")
    rm_children(ART)
    print(f"[clean] Removing children of {FIG}")
    rm_children(FIG)
    print(f"[clean] Removing children of {RES}")
    rm_children(RES)
    print('[clean] Done.')

if __name__ == '__main__':
    main()

