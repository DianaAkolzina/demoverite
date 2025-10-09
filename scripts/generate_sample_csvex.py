#!/usr/bin/env python3
import os,sys,time,datetime,csv

ROOM=os.environ.get('ROOM','cafe')
OUT=os.environ.get('CSV_SOURCE_DIR','CSVex')
START=os.environ.get('START','2025-10-01T00:00:00Z')
DAYS=int(os.environ.get('DAYS','2'))

def to_ms(dt):
    return int(dt.timestamp()*1000)

def parse_iso(s):
    try:
        return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
    except Exception:
        return datetime.datetime.utcnow().replace(hour=0,minute=0,second=0,microsecond=0)

def ensure_dir(p):
    os.makedirs(p,exist_ok=True)

def write_csv(path, header, rows):
    with open(path,'w',encoding='utf-8',newline='') as f:
        w=csv.writer(f)
        w.writerow(header)
        w.writerows(rows)

def main():
    start_dt=parse_iso(START)
    hours=DAYS*24
    ts=[to_ms(start_dt+datetime.timedelta(hours=i)) for i in range(hours)]
    room_dir=os.path.join(OUT,ROOM)
    ensure_dir(room_dir)

    iaq_rows=[]
    people_rows=[]
    energy_rows=[]
    for i,t in enumerate(ts):
        temp=21.0+((i%24)-12)*0.05
        hum=45+((i%24)-12)*0.3
        co2=600+((i%24))*5
        lux=100+((i%24))*10
        pm25=5+(i%5)
        pm10=8+(i%7)
        voc=100+(i%24)*3
        iaq_rows.append([t,round(temp,2),round(hum,2),int(co2),int(lux),int(pm25),int(pm10),int(voc)])
        ppl= max(0, int(8-abs((i%24)-12)))
        people_rows.append([t,ppl])
        val=120+(i%24)*2
        total=1000.0+i*0.6
        energy_rows.append([t,int(val),round(total,2)])

    write_csv(os.path.join(room_dir,'cafe_iaq_data.csv'),
              ['ts','temperature','humidity','co2','lux','pm25','pm10','voc'],iaq_rows)
    write_csv(os.path.join(room_dir,'people_count.csv'),['ts','people_count'],people_rows)
    write_csv(os.path.join(room_dir,'energy_clamp.csv'),['ts','value','total_kwh'],energy_rows)
    print(f"wrote sample CSVs for room={ROOM} at {room_dir}")

if __name__=='__main__':
    main()
