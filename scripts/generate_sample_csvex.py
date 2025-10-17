#!/usr/bin/env python3
import os,sys,time,datetime,csv,math

ROOM=os.environ.get('ROOM','cafe')
OUT=os.environ.get('CSV_SOURCE_DIR','CSVex')
START=os.environ.get('START','')
DAYS=int(os.environ.get('DAYS','120'))
SEED=int(os.environ.get('SEED','42'))

def to_ms(dt):
    return int(dt.timestamp()*1000)

def parse_iso_or_default(s):
    if s:
        try:
            return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
        except Exception:
            pass
    # default: generate the last DAYS worth of data ending at "now" (UTC)
    now = datetime.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    days = max(int(DAYS), 1)
    start = (now - datetime.timedelta(days=days)).replace(minute=0, second=0, microsecond=0)
    return start

def ensure_dir(p):
    os.makedirs(p,exist_ok=True)

def write_csv(path, header, rows):
    with open(path,'w',encoding='utf-8',newline='') as f:
        w=csv.writer(f)
        w.writerow(header)
        w.writerows(rows)

def main():
    import random
    random.seed(SEED)
    start_dt=parse_iso_or_default(START)
    hours=DAYS*24
    ts=[to_ms(start_dt+datetime.timedelta(hours=i)) for i in range(hours)]
    room_dir=os.path.join(OUT,ROOM)
    ensure_dir(room_dir)

    # Room behavioral profiles; infer base type from ROOM name (supports names like "A_F1_cafe")
    ROOM_L = ROOM.lower()
    base_type = 'cafe' if 'cafe' in ROOM_L else (
        'boardroom' if 'boardroom' in ROOM_L else (
        'lab' if 'lab' in ROOM_L else (
        'toilet' if 'toilet' in ROOM_L else ROOM_L)))
    room_profile = {
        'cafe':   {'base_occ': 4, 'peak_occ': 30, 'hours_open': (6, 20)},
        'boardroom': {'base_occ': 0, 'peak_occ': 16, 'hours_open': (8, 18)},
        'lab':    {'base_occ': 2, 'peak_occ': 12, 'hours_open': (7, 19)},
        'toilet': {'base_occ': 0, 'peak_occ': 6,  'hours_open': (6, 22)},
    }.get(base_type, {'base_occ': 1, 'peak_occ': 8, 'hours_open': (8, 18)})

    def weekday_multiplier(dt):
        # Lower occupancy and energy on weekends
        wd = dt.weekday()  # 0=Mon
        return 0.6 if wd >= 5 else 1.0

    def diurnal(hour, open_hours):
        # Smooth daily pattern; >0 within open hours, otherwise near 0
        start,end=open_hours
        if hour < start or hour > end:
            return 0.05
        span=end-start
        x=(hour-start)/max(span,1)
        # two peaks (morning, lunch) via simple piecewise bell
        return max(0.1, (1.2-abs(x-0.3)*1.8) + (1.0-abs(x-0.7)*1.6))

    iaq_rows=[]; people_rows=[]; energy_rows=[]; water_rows=[]
    total= random.uniform(0, 500)  # cumulative energy start
    total_water= random.uniform(0, 2000)

    # Preselect anomaly indices
    anomaly_spikes = set(random.sample(range(hours), k=max(5, hours//240)))  # ~1 per 10 days
    anomaly_after_hours = set(random.sample(range(hours), k=max(8, hours//180)))
    anomaly_lights_on = set(random.sample(range(hours), k=max(8, hours//180)))
    data_gaps = set(random.sample(range(hours), k=max(6, hours//360)))  # missing hours

    for i,t in enumerate(ts):
        if i in data_gaps:
            continue  # simulate missing samples
        dt = start_dt + datetime.timedelta(hours=i)
        h = dt.hour
        wmult = weekday_multiplier(dt)
        pattern = diurnal(h, room_profile['hours_open']) * wmult

        # Occupancy with noise and occasional after-hours anomaly
        occ = room_profile['base_occ'] + pattern * (room_profile['peak_occ']-room_profile['base_occ'])
        occ += random.gauss(0, 2)
        if i in anomaly_after_hours and (h < room_profile['hours_open'][0] or h > room_profile['hours_open'][1]):
            occ = max(occ, random.randint(2, 8))
        occ = max(0, int(round(occ)))
        people_rows.append([t, occ])

        # IAQ metrics with noise and correlation to occupancy
        temp_base = 20.5 + 0.5*random.random() + 0.3*math.sin(2*math.pi*(h/24.0))
        temp = temp_base + 0.015*occ + random.gauss(0, 0.4)
        hum = 45 + random.gauss(0, 6) + (0.03*(50-temp))
        co2 = 450 + 30*occ + random.gauss(0, 50)
        lux = 60 + 15*pattern*100/3 + random.gauss(0, 40)
        pm25 = max(2, 6 + random.gauss(0, 3) + 0.2*(occ>0))
        pm10 = max(3, 10 + random.gauss(0, 4) + 0.2*(occ>0))
        voc = max(30, 80 + random.gauss(0, 20) + 2*occ)

        # Anomaly spikes
        if i in anomaly_spikes:
            co2 *= random.uniform(1.5, 2.5)
            pm25 *= random.uniform(1.4, 2.0)
            pm10 *= random.uniform(1.2, 1.8)
        if i in anomaly_lights_on and occ == 0:
            lux = max(lux, random.uniform(200, 600))

        # Build IAQ row with optional extra fields per room
        iaq_base = [t, round(temp,2), round(hum,1), int(co2), int(max(0,lux)), round(pm25,1), round(pm10,1), int(voc)]
        if base_type == 'cafe':
            ach = max(0.3, 1.5 + 0.8*random.random() + 0.7*pattern - 0.01*occ + random.gauss(0, 0.2))
            # Virus risk (0-100) proxy: higher with CO2 and extreme humidity
            humid_penalty = max(0, 20-abs(hum-50))  # center around 50%
            risk = max(0, min(100, 0.05*co2 + (20-humid_penalty) + random.gauss(0,6)))
            iaq_row = iaq_base + [round(ach,2), int(risk)]
        elif base_type == 'toilet':
            nh3 = max(0, 0.5 + 0.2*occ + random.gauss(0, 0.3))  # ppm approx
            h2s = max(0, 0.2 + 0.15*occ + random.gauss(0, 0.2))  # ppm approx
            if i in anomaly_spikes and occ > 0:
                nh3 *= random.uniform(1.5, 2.5)
                h2s *= random.uniform(1.5, 2.5)
            iaq_row = iaq_base + [round(nh3,3), round(h2s,3)]
        else:
            iaq_row = iaq_base
        iaq_rows.append(iaq_row)

        # Energy: interval value with baseline + occupancy + noise; cumulative total_kwh
        base_load = 80 + 20*random.random()
        val = base_load + 4*occ + 5*pattern + random.gauss(0, 15)
        # anomaly: high energy when empty
        if occ == 0 and i in anomaly_after_hours:
            val += random.uniform(60, 160)
        val = max(0, int(round(val)))
        total += val/100.0
        energy_rows.append([t, val, round(total,2)])

        # Water (cafes/toilets typically):
        if base_type in ('cafe','toilet'):
            wv = max(0, int(round( (5 + 3*pattern + random.gauss(0,2)) * (1.5 if base_type=='cafe' else 0.8) )))
            # leak anomaly: persistent baseline even when closed
            if (base_type=='toilet') and (h<room_profile['hours_open'][0] or h>room_profile['hours_open'][1]) and random.random() < 0.02:
                wv += random.randint(5, 12)
            total_water += wv
            water_rows.append([t, wv, int(total_water)])

    # Write canonical tables only (no duplicates)
    ensure_dir(room_dir)
    # IAQ (conditional columns)
    if base_type == 'cafe':
        iaq_header = ['ts','temperature','humidity','co2','lux','pm25','pm10','voc','airExchangeRate','virusrisk']
    elif base_type == 'toilet':
        iaq_header = ['ts','temperature','humidity','co2','lux','pm25','pm10','voc','nh3','h2s']
    else:
        iaq_header = ['ts','temperature','humidity','co2','lux','pm25','pm10','voc']
    write_csv(os.path.join(room_dir,'iaq.csv'), iaq_header, iaq_rows)
    # People
    write_csv(os.path.join(room_dir,'people.csv'), ['ts','people_count'], people_rows)
    # Energy
    write_csv(os.path.join(room_dir,'energy.csv'), ['ts','value','total_kwh'], energy_rows)
    # Water where applicable
    if water_rows:
        write_csv(os.path.join(room_dir,'water.csv'), ['ts','value','total_liters'], water_rows)

    print(f"wrote expanded sample CSVs for room={ROOM} at {room_dir} hours={hours} rows_written={len(iaq_rows)} (gaps={hours-len(iaq_rows)})")

if __name__=='__main__':
    main()
