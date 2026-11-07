#!/usr/bin/env python3
"""마라톤 캘린더 변경 요약: git 기준(기본 HEAD)과 작업 트리의 data/calendar/YYYY-MM.json 을 비교해 마크다운으로 출력

    python3 scripts/calendar_diff.py            # HEAD 와 비교
    python3 scripts/calendar_diff.py <커밋>      # 해당 커밋과 비교

월별 대회 수, 추가·삭제된 대회, 목록 필드(이름·날짜·장소·종목·신청)가 바뀐 대회를 보여주고,
사이트 구조 변경 등으로 의심되는 경우(대회가 많이 빠짐 등)는 맨 위에 경고로 표시합니다.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAL = 'data/calendar'
WATCH = ('name', 'date', 'location', 'distances', 'registration')  # 바뀌면 알려줄 필드
DROP_WARN = 0.3   # 한 달 대회 수가 이 비율 이상 줄면 경고
REMOVED_WARN = 5  # 한 달에 이만큼 이상 빠지면 경고


def load_old(ref, path):
    r = subprocess.run(['git', 'show', f'{ref}:{path}'], cwd=ROOT, capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None


def load_new(path):
    p = os.path.join(ROOT, path)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def races(doc):
    return {r['id']: r for r in (doc or {}).get('races', [])}


def label(r):
    return f"{r.get('date', '')} {r.get('name', '')}".strip()


def months(ref):
    r = subprocess.run(['git', 'ls-tree', '--name-only', f'{ref}:{CAL}'], cwd=ROOT, capture_output=True, text=True)
    names = set(r.stdout.split()) | set(os.listdir(os.path.join(ROOT, CAL)))
    return sorted(n[:-5] for n in names if re.fullmatch(r'\d{4}-\d{2}\.json', n))


def main():
    ref = sys.argv[1] if len(sys.argv) > 1 else 'HEAD'
    rows, sections, warns = [], [], []
    for m in months(ref):
        path = f'{CAL}/{m}.json'
        old, new = races(load_old(ref, path)), races(load_new(path))
        added = [new[i] for i in new if i not in old]
        removed = [old[i] for i in old if i not in new]
        changed = [(old[i], new[i]) for i in new if i in old
                   and any(old[i].get(k) != new[i].get(k) for k in WATCH)]
        if not (added or removed or changed):
            continue
        rows.append(f'| {m} | {len(old)} → {len(new)} | +{len(added)} | -{len(removed)} | {len(changed)} |')
        if old and (len(old) - len(new)) / len(old) >= DROP_WARN:
            warns.append(f'{m}: 대회 수가 {len(old)} → {len(new)} 로 크게 줄었습니다 (수집 실패나 사이트 구조 변경 의심)')
        if len(removed) >= REMOVED_WARN:
            warns.append(f'{m}: {len(removed)}개 대회가 빠졌습니다')
        lines = [f'### {m}']
        lines += [f'- ➕ {label(r)}' for r in sorted(added, key=label)]
        lines += [f'- ➖ {label(r)}' for r in sorted(removed, key=label)]
        for o, n in changed:
            diffs = ', '.join(f'{k}: {json.dumps(o.get(k), ensure_ascii=False)} → {json.dumps(n.get(k), ensure_ascii=False)}'
                              for k in WATCH if o.get(k) != n.get(k))
            lines.append(f'- ✏️ {label(n)} ({diffs})')
        sections.append('\n'.join(lines))

    if not rows:
        print('목록 데이터 변경 없음 (대회 상세 파일만 바뀜)')
        return
    # 날짜가 바뀌어 다른 달로 옮겨간 대회는 삭제+추가로 보이지만 같은 id 라 따로 경고하지 않는다.
    out = []
    if warns:
        out.append('> [!WARNING]\n' + '\n'.join(f'> - {w}' for w in warns) + '\n')
    out.append('| 월 | 대회 수 | 추가 | 삭제 | 정보 변경 |\n|---|---|---|---|---|\n' + '\n'.join(rows))
    out += sections
    print('\n\n'.join(out))


if __name__ == '__main__':
    main()
