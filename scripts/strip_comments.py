#!/usr/bin/env python3
import os,re,sys

ROOT=os.getcwd()
EXCLUDE_DIRS={'node_modules','.git','CSVex','csvex_enriched','data','public/assets'}
EXTS_JS={'.js','.ts'}
EXTS_PY={'.py'}
EXTS_SH={'.sh'}
EXTS_HTML={'.html','.htm'}
EXTS_CSS={'.css'}

def should_skip(path):
    parts=os.path.relpath(path,ROOT).split(os.sep)
    return any(p in EXCLUDE_DIRS for p in parts)

def strip_js_css(text):
    text=re.sub(r"/\*[\s\S]*?\*/","",text)
    out=[]
    for line in text.splitlines():
        if re.match(r"^\s*//",line):
            continue
        out.append(line)
    return "\n".join(out)+"\n"

def strip_py(text):
    out=[]
    first=True
    for line in text.splitlines():
        if first and line.startswith("#!"):
            out.append(line)
        elif re.match(r"^\s*#",line):
            pass
        else:
            out.append(line)
        first=False
    return "\n".join(out)+"\n"

def strip_sh(text):
    out=[]
    first=True
    for line in text.splitlines():
        if first and line.startswith("#!"):
            out.append(line)
        elif re.match(r"^\s*#",line):
            pass
        else:
            out.append(line)
        first=False
    return "\n".join(out)+"\n"

def strip_html(text):
    return re.sub(r"<!--[\s\S]*?-->","",text)

def process_file(path):
    if should_skip(path):
        return
    ext=os.path.splitext(path)[1].lower()
    try:
        data=open(path,'r',encoding='utf-8').read()
    except Exception:
        return
    if ext in EXTS_JS or ext in EXTS_CSS:
        new=strip_js_css(data)
    elif ext in EXTS_PY:
        new=strip_py(data)
    elif ext in EXTS_SH:
        new=strip_sh(data)
    elif ext in EXTS_HTML:
        new=strip_html(data)
    else:
        return
    if new!=data:
        open(path,'w',encoding='utf-8').write(new)

def main():
    for dirpath,dirnames,filenames in os.walk(ROOT):
        if should_skip(dirpath):
            dirnames[:]=[]
            continue
        for f in filenames:
            process_file(os.path.join(dirpath,f))

if __name__=='__main__':
    main()
