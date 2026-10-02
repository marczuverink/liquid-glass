#!/bin/bash
# 本番セッションで、ガラスの仕事量（1 秒ごと）と GPU 使用率を並べて記録する。
#
# 使い方:
#   1. このスクリプトを起動する:  tools/perf/glass-monitor.sh [保存先ファイル]
#   2. Looking Glass (Alt+F2 → lg) で記録を始める:  global._lgGlass.monitor(0)
#      （数値を渡すとその秒数で自動停止。0 は monitorStop() まで）
#   3. 操作しながら、状況が変わるたびにこの端末でラベルを入力して Enter
#      （例: 「dock のみ 静止」「窓1枚ドラッグ」「動画再生 dock の裏」「メニュー開閉」）。
#      以後の行はそのラベルの区間として集計される。
#   4. 終わったら Looking Glass で  global._lgGlass.monitorStop()  、この端末は Ctrl-C。
#      区間ごとの平均（GPU・フレーム数・全面再描画・ガラスごとのコピー数）を表示する。
#
# 拡張側の 1 行の形式は src/diagnostics/monitor.ts を参照。GPU は amdgpu の
# gpu_busy_percent（100ms ごとの平均）。それ以外の GPU では gpu= が出ない。
set -u

out=${1:-glass-monitor-$(date +%Y%m%d-%H%M%S).log}
: >"$out"
echo "記録先: $out"
echo "Looking Glass で global._lgGlass.monitor(0) を実行してください。ラベルを入力して Enter で区間を切り替えます。"

journalctl --user -f -o cat --since now _COMM=gnome-shell 2>/dev/null |
  grep --line-buffered -F '[Liquid Glass][monitor]' |
  while IFS= read -r line; do
    printf '%s %s\n' "$(date +%T)" "$line" | tee -a "$out"
  done &
follower=$!

summarize() {
  kill "$follower" 2>/dev/null
  wait "$follower" 2>/dev/null
  echo
  echo "== 区間ごとの平均（1 秒あたり） =="
  awk '
    /^# label: / { label = substr($0, 10); next }
    /\[monitor\] t=/ {
      seg = (label == "" ? "(ラベルなし)" : label)
      if (!(seg in n)) order[++nseg] = seg
      n[seg]++
      if (match($0, /gpu=[0-9]+%/)) { gpu[seg] += substr($0, RSTART + 4, RLENGTH - 5); hasgpu[seg] = 1 }
      if (match($0, /frames=[0-9]+/)) frames[seg] += substr($0, RSTART + 7, RLENGTH - 7)
      if (match($0, /full=[0-9]+/)) full[seg] += substr($0, RSTART + 5, RLENGTH - 5)
      # 各ガラスの copies（新方式）と paints（旧方式）
      rest = $0
      while (match(rest, /\| [a-z:-]+(\(capture\))? (copies|paints)=[0-9]+/)) {
        item = substr(rest, RSTART + 2, RLENGTH - 2)
        split(item, kv, " ")
        split(kv[2], v, "=")
        key = seg SUBSEP kv[1] " " v[1]
        if (!(key in glass)) glasses[seg] = glasses[seg] " " kv[1] " " v[1]
        glass[key] += v[2]
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
    END {
      for (i = 1; i <= nseg; i++) {
        s = order[i]
        printf "%-28s %3ds", s, n[s]
        if (hasgpu[s]) printf "  gpu %5.1f%%", gpu[s] / n[s]
        printf "  frames %5.1f  full %4.1f", frames[s] / n[s], full[s] / n[s]
        m = split(glasses[s], g, " ")
        for (j = 1; j + 1 <= m; j += 2) {
          key = s SUBSEP g[j] " " g[j + 1]
          printf "  %s %s %.1f", g[j], g[j + 1], glass[key] / n[s]
        }
        printf "\n"
      }
    }' "$out"
  exit 0
}
trap summarize INT TERM

while IFS= read -r label; do
  [ -z "$label" ] && continue
  printf '# label: %s\n' "$label" | tee -a "$out"
done
summarize
