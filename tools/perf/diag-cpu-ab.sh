#!/bin/bash
# gnome-shell メインスレッドの CPU と GPU を、診断系設定 ON/OFF で A/B 比較する。
#   A: 現在の設定のまま     B: output-logs=false, glass-debug-diagnostics=false
# 終了・中断時は必ず元の値に戻す。
# 使い方: tools/perf/diag-cpu-ab.sh [各フェーズ秒数=15]
T=${1:-15}
EXT=$(dirname "$0")/../../liquid-glass@thinkingcoding1231.gmail.com
S=org.gnome.shell.extensions.liquid-glass@thinkingcoding1231.gmail.com
G="gsettings --schemadir $EXT/schemas"
P=$(pgrep -x gnome-shell | head -1); HZ=$(getconf CLK_TCK)
GPU=/sys/class/drm/card1/device/gpu_busy_percent
OL=$($G get $S output-logs); DG=$($G get $S glass-debug-diagnostics)
trap '$G set $S output-logs '"$OL"'; $G set $S glass-debug-diagnostics '"$DG"'; echo "[restore] output-logs='"$OL"' glass-debug-diagnostics='"$DG"'"' EXIT INT TERM

phase() { # $1=label
  local c0 c1 cs=0 n=0 s
  c0=$(awk '{print $14+$15}' /proc/$P/task/$P/stat)
  local end=$(( $(date +%s) + T ))
  while [ "$(date +%s)" -lt "$end" ]; do cs=$((cs + $(cat $GPU))); n=$((n+1)); sleep 0.25; done
  c1=$(awk '{print $14+$15}' /proc/$P/task/$P/stat)
  printf '%-34s main-thread CPU=%5.1f%%  GPU mean=%4.1f%%\n' "$1" \
    "$(echo "scale=2; ($c1-$c0)*100/$HZ/$T" | bc)" "$(echo "scale=2; $cs/$n" | bc)"
}
echo "gnome-shell pid=$P  ${T}s × 2"
phase "A: logs=$OL diag=$DG"
$G set $S output-logs false; $G set $S glass-debug-diagnostics false; sleep 2
phase "B: logs=false diag=false"
