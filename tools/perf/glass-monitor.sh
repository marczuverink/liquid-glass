#!/bin/bash
# 本番セッションで、ガラスの仕事量と GPU 使用率を 1 秒ごとに記録し、画面の状況ごとに集計する。
#
# 使い方:
#   1. このスクリプトを起動する:  tools/perf/glass-monitor.sh [保存先ファイル]
#   2. Looking Glass (Alt+F2 → lg) で記録を始める:  global._lgGlass.monitor(0)
#      （数値を渡すとその秒数で自動停止。0 は monitorStop() まで）
#   3. ふだんどおり操作する。状況（表示中のガラス・窓の数・動いている窓など）は拡張側が
#      毎秒自動で判定して scene=<...> に書くので、ここで何か入力する必要はない。
#   4. 終わったら Looking Glass で  global._lgGlass.monitorStop()  、この端末は Ctrl-C。
#      状況ごとの平均（GPU・フレーム数・全面再描画・ガラスごとのコピー数）を表示する。
#
# 新方式と旧方式の比較: 記録を止め、Looking Glass で global._lgGlass.backdrop(false) を実行し、
# 拡張機能を OFF→ON してから（OFF で記録も止まる）もう一度 monitor(0) を実行する。
# 同じ状況が stage（新方式）と capture（旧方式）の 2 行に並ぶ。戻すときは backdrop(true) で同様に。
#
# 保存済みの記録を集計し直す:  tools/perf/glass-monitor.sh --summary <ファイル>
#
# scene=<...> の読み方（src/diagnostics/monitor.ts 参照）:
#   stage / capture         UI のガラスの方式（新 / 旧）。mixed は混在
#   dock calendar~ ...      表示中のガラス。~ はその秒に動いた・大きさが変わったもの、(2) は 2 枚
#   3 win: firefox busy@dock  表示中の窓の数と、何かしている窓。busy は 1 秒に 10 回以上描き直し
#                           （動画など）、moving は移動・リサイズ、anim は開閉などのアニメーション。
#                           @dock はその窓が dock のガラスと重なっていること
#   overview, ws-switch, fullscreen, locked  そのときのシェルの状態
set -u

summarize() {
  awk '
    /\[monitor\] t=/ {
      if (!match($0, /scene=<[^>]*>/)) next
      scene = substr($0, RSTART + 7, RLENGTH - 8)
      mode = scene; sub(/;.*/, "", mode)
      rest = scene; sub(/^[^;]*; */, "", rest)
      k = rest SUBSEP mode
      if (!(rest in total)) order[++nscene] = rest
      total[rest]++
      if (!(k in n)) modes[rest] = modes[rest] " " mode
      n[k]++
      if (match($0, /gpu=[0-9]+%/)) { gpu[k] += substr($0, RSTART + 4, RLENGTH - 5); hasgpu[k] = 1 }
      if (match($0, /\(max [0-9]+\)/)) { v = substr($0, RSTART + 5, RLENGTH - 6) + 0; if (v > gmax[k]) gmax[k] = v }
      if (match($0, /frames=[0-9]+/)) frames[k] += substr($0, RSTART + 7, RLENGTH - 7)
      if (match($0, /full=[0-9]+/)) full[k] += substr($0, RSTART + 5, RLENGTH - 5)
      nseg = split($0, seg, / \| /)
      for (i = 2; i <= nseg; i++) {
        m = split(seg[i], f, " ")
        for (j = 2; j <= m; j++) {
          if (f[j] !~ /^(copies|paints)=[0-9]+$/) continue
          split(f[j], kv, "=")
          item = f[1] " " kv[1]
          gk = k SUBSEP item
          if (!(gk in gsum)) items[k] = items[k] "\t" item
          gsum[gk] += kv[2]
        }
      }
    }
    END {
      if (!nscene) { print "（記録なし）"; exit }
      # 長く続いた状況から順に
      for (i = 1; i <= nscene; i++)
        for (j = i + 1; j <= nscene; j++)
          if (total[order[j]] > total[order[i]]) { t = order[i]; order[i] = order[j]; order[j] = t }
      print "== 状況ごとの 1 秒あたりの平均（長く続いた順） =="
      for (i = 1; i <= nscene; i++) {
        s = order[i]
        printf "\n[%s]  計 %ds\n", s, total[s]
        nm = split(modes[s], ms, " ")
        for (j = 1; j <= nm; j++) {
          k = s SUBSEP ms[j]
          printf "  %-8s %4ds", ms[j], n[k]
          if (hasgpu[k]) printf "  gpu %5.1f%% (max %3d)", gpu[k] / n[k], gmax[k]
          printf "  frames %5.1f  full %5.1f", frames[k] / n[k], full[k] / n[k]
          ni = split(items[k], it, "\t")
          for (q = 2; q <= ni; q++) printf "  %s %.1f", it[q], gsum[k SUBSEP it[q]] / n[k]
          printf "\n"
        }
      }
    }' "$1"
}

if [ "${1:-}" = "--summary" ]; then
  [ -f "${2:-}" ] || { echo "使い方: $0 --summary <記録ファイル>" >&2; exit 1; }
  summarize "$2"
  exit 0
fi

out=${1:-glass-monitor-$(date +%Y%m%d-%H%M%S).log}
: >"$out"
echo "記録先: $out"
echo "Looking Glass で global._lgGlass.monitor(0) を実行してください。終わったら monitorStop() のあと、ここで Ctrl-C。"

on_exit() {
  kill "$follower" 2>/dev/null
  wait "$follower" 2>/dev/null
  echo
  summarize "$out"
  echo
  echo "記録: $out（集計し直すには $0 --summary $out）"
  exit 0
}

journalctl --user -f -o cat --since now _COMM=gnome-shell 2>/dev/null |
  grep --line-buffered -F '[Liquid Glass][monitor]' |
  while IFS= read -r line; do
    printf '%s %s\n' "$(date +%T)" "$line" >>"$out"
    printf '%s %s\n' "$(date +%T)" "${line#*\[monitor\] }"
  done &
follower=$!
trap on_exit INT TERM
wait "$follower"
on_exit
