#!/usr/bin/env python3
"""
Create a simple building graph dataset on disk (CSVex) for 2 buildings x 2 floors x 2 rooms.
Room IDs are directory names suitable for the app, e.g. A_F1_cafe, A_F1_boardroom, A_F2_lab, A_F2_toilet, B_F1_cafe, ...

Env:
- CSV_SOURCE_DIR (default ./CSVex)
- START ISO timestamp (optional)
- DAYS (default 180)
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CSV_SOURCE_DIR = os.environ.get('CSV_SOURCE_DIR', os.path.join(ROOT, 'CSVex'))
START = os.environ.get('START', '')
DAYS = os.environ.get('DAYS', '180')

ROOMS = [
  'A_F1_cafe', 'A_F1_boardroom', 'A_F2_lab', 'A_F2_toilet',
  'B_F1_cafe', 'B_F1_boardroom', 'B_F2_lab', 'B_F2_toilet'
]

def run(cmd, env=None):
  print('+', ' '.join(cmd))
  res = subprocess.run(cmd, env=env)
  if res.returncode != 0:
    sys.exit(res.returncode)

def main():
  os.makedirs(CSV_SOURCE_DIR, exist_ok=True)
  for r in ROOMS:
    env = os.environ.copy()
    env['ROOM'] = r
    env['CSV_SOURCE_DIR'] = CSV_SOURCE_DIR
    env['START'] = START
    env['DAYS'] = DAYS
    run(['python3', os.path.join(ROOT, 'scripts', 'generate_sample_csvex.py')], env=env)
  # Weather
  env = os.environ.copy()
  env['CSV_SOURCE_DIR'] = CSV_SOURCE_DIR
  env['START'] = START
  env['DAYS'] = DAYS
  run(['python3', os.path.join(ROOT, 'scripts', 'generate_synth_weather.py')], env=env)
  print('Sample building graph data prepared in', CSV_SOURCE_DIR)

if __name__ == '__main__':
  main()

