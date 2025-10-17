#!/usr/bin/env python3
"""
Prepare mock CSVex data for a 2x3x2 Building/Floor/Room structure.
Rooms per building/floor are assigned base types to generate proper columns.

Env:
- CSV_SOURCE_DIR (default ./CSVex)
- START (ISO, optional), DAYS (int, default 90)
"""
import os, sys, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CSV_SOURCE_DIR = os.environ.get('CSV_SOURCE_DIR', os.path.join(ROOT, 'CSVex'))
START = os.environ.get('START', '')
DAYS = os.environ.get('DAYS', '90')

BUILDINGS = ['A', 'B']
FLOORS = ['F1', 'F2', 'F3']
ROOM_TYPES = ['cafe', 'boardroom', 'lab', 'toilet']

def run(cmd, env=None):
  print('+', ' '.join(cmd))
  r = subprocess.run(cmd, env=env)
  if r.returncode != 0:
    sys.exit(r.returncode)

def main():
  os.makedirs(CSV_SOURCE_DIR, exist_ok=True)
  rooms = []
  for b in BUILDINGS:
    for f in FLOORS:
      # two rooms per floor: cycle types deterministically
      for i in range(2):
        rtype = ROOM_TYPES[(i + FLOORS.index(f)) % len(ROOM_TYPES)]
        room_id = f"{b}_{f}_{rtype}"
        rooms.append(room_id)
  for r in rooms:
    env = os.environ.copy()
    env['ROOM'] = r
    env['CSV_SOURCE_DIR'] = CSV_SOURCE_DIR
    env['START'] = START
    env['DAYS'] = str(DAYS)
    run(['python3', os.path.join(ROOT, 'scripts', 'generate_sample_csvex.py')], env=env)
  # Weather
  env = os.environ.copy()
  env['CSV_SOURCE_DIR'] = CSV_SOURCE_DIR
  env['START'] = START
  env['DAYS'] = str(DAYS)
  run(['python3', os.path.join(ROOT, 'scripts', 'generate_synth_weather.py')], env=env)
  print('Prepared CSVex mock data in', CSV_SOURCE_DIR)

if __name__ == '__main__':
  main()

