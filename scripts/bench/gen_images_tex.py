#!/usr/bin/env python3
import os, glob

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIG_ROOT = os.path.join(ROOT, 'docs', 'publication', 'figures')
RES_DIR = os.path.join(ROOT, 'docs', 'publication', 'results')

def write_images_tex(images_by_run):
    os.makedirs(RES_DIR, exist_ok=True)
    out = []
    out.append('% Auto-generated image includes for latest run')
    for run, images in images_by_run:
        out.append(f"% Run: {run}")
        # Pair model vs reference if both exist: <case>.png and <case>_ref.png
        # Build map by basename without _ref
        from collections import defaultdict
        groups = defaultdict(dict)
        for img in images:
            base = os.path.basename(img)
            if base.endswith('_ref.png'):
                key = base[:-8]  # strip _ref.png
                groups[key]['ref'] = base
            else:
                key = base[:-4]  # strip .png
                groups[key]['model'] = base
        # Limit to a few pairs per run
        count = 0
        for key, files in groups.items():
            if count >= 6:
                break
            model = files.get('model')
            ref = files.get('ref')
            if model and ref:
                out.append("\\begin{figure}[h]")
                out.append("  \\centering")
                out.append("  \\begin{subfigure}[b]{0.49\\linewidth}")
                out.append(f"    \\includegraphics[width=\\linewidth]{{docs/publication/figures/{run}/{model}}}")
                out.append("    \\caption{Model}")
                out.append("  \\end{subfigure}")
                out.append("  \\begin{subfigure}[b]{0.49\\linewidth}")
                out.append(f"    \\includegraphics[width=\\linewidth]{{docs/publication/figures/{run}/{ref}}}")
                out.append("    \\caption{Reference}")
                out.append("  \\end{subfigure}")
                out.append(f"  \\caption{{{key.replace('_',' ')}}}")
                out.append("\\end{figure}")
                count += 1
            else:
                # fallback: single image
                single = model or ref
                if not single:
                    continue
                out.append("\\begin{figure}[h]")
                out.append("  \\centering")
                out.append(f"  \\includegraphics[width=0.86\\linewidth]{{docs/publication/figures/{run}/{single}}}")
                out.append(f"  \\caption{{{key.replace('_',' ')}}}")
                out.append("\\end{figure}")
                count += 1
    with open(os.path.join(RES_DIR, 'images.tex'), 'w', encoding='utf-8') as fh:
        fh.write("\n".join(out)+"\n")
    print('[gen_images_tex] Wrote', os.path.join(RES_DIR, 'images.tex'))

def main():
    runs = sorted([p for p in glob.glob(os.path.join(FIG_ROOT, '*')) if os.path.isdir(p)])
    if not runs:
        print('[gen_images_tex] No figures found in', FIG_ROOT)
        return
    rows = []
    for run_dir in runs:
        imgs = sorted(glob.glob(os.path.join(run_dir, '*.png')))
        if imgs:
            rows.append((os.path.basename(run_dir), imgs))
    if not rows:
        print('[gen_images_tex] No images to include')
        return
    # Only include latest run to avoid a very long doc
    rows = [rows[-1]]
    write_images_tex(rows)

if __name__ == '__main__':
    main()
