#!/usr/bin/env python3
import os, csv, datetime, math, random

OUT_ROOT = os.environ.get('CSV_SOURCE_DIR','CSVex')
START = os.environ.get('START','')
DAYS = int(os.environ.get('DAYS','120'))
SEED = int(os.environ.get('SEED','43'))

def to_ms(dt):
    return int(dt.timestamp()*1000)

def parse_iso_or_default(s):
    if s:
        try:
            return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
        except Exception:
            pass
    now=datetime.datetime.utcnow().replace(minute=0,second=0,microsecond=0)
    return (now - datetime.timedelta(days=max(DAYS,120))).replace(hour=0)

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)

def main():
    random.seed(SEED)
    start_dt = parse_iso_or_default(START)
    hours = DAYS*24
    out_dir = os.path.join(OUT_ROOT, 'weather')
    ensure_dir(out_dir)
    path = os.path.join(out_dir, 'weather.csv')
    rows = []
    for i in range(hours):
        dt = start_dt + datetime.timedelta(hours=i)
        t = to_ms(dt)
        # Daily temperature cycle + slow seasonality + noise
        season = 8*math.sin(2*math.pi*(i/(24*90)))  # ~quarterly
        diurnal = 6*math.sin(2*math.pi*((dt.hour-6)/24.0))
        temp = 12 + season + diurnal + random.gauss(0, 1.2)
        humidity = max(15, min(95, 70 - 0.8*(temp-12) + random.gauss(0,5)))
        pressure = 1010 + 8*math.sin(2*math.pi*(i/(24*5))) + random.gauss(0, 3)
        wind_speed = max(0, abs(random.gauss(4, 2)))
        wind_deg = random.randint(0, 359)
        clouds = max(0, min(100, int(abs(40*math.sin(2*math.pi*(i/(24*6))) + random.gauss(30,20)))))
        weather_main = 'Rain' if (clouds>70 and random.random()<0.13) else ('Clouds' if clouds>40 else 'Clear')
        desc = 'light rain' if weather_main=='Rain' else ('broken clouds' if weather_main=='Clouds' else 'clear sky')
        rows.append([t, round(temp,2), int(humidity), int(pressure), round(wind_speed,1), wind_deg, int(clouds), weather_main, desc])
    with open(path,'w',newline='',encoding='utf-8') as f:
        w=csv.writer(f)
        w.writerow(['ts','temp','humidity','pressure','wind_speed','wind_deg','clouds','weather_main','weather_desc'])
        w.writerows(rows)
    print(f"wrote synthetic weather rows={len(rows)} at {path}")

if __name__=='__main__':
    main()

