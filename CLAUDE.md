# GNOME Shell Extension Development Guidelines

## 開発環境
- GNOME 50 / Clutter 18 環境向けの TypeScript 拡張機能開発。
- メインのソースコードやビルド設定は `liquid-glass@thinkingcoding1231.gmail.com/` 配下にあります。
- 基本的には`dev`ブランチで作業してください。コード編集などを行う際は`dev`ブランチにいることを確認してください。

## コマンド実行ルール
- `npm` やビルド関連のコマンドを実行する際は、`liquid-glass@thinkingcoding1231.gmail.com` ディレクトリ内で実行すること。（例: `cd liquid-glass@thinkingcoding1231.gmail.com && npm run build`）
- TSファイルを修正・編集した後は、`npm run build` を実行してビルドエラーが出ないかチェックすること。

## ファイル読み取りの許可
- `memo.md`: 今まで踏んだ地雷や罠、教訓などを示したMarkdownファイル。読み取りや書き込みを自由に許可します。
- ローカルにある、GNOME関連のソースコードなど: バグ原因特定などで必要ならば許可を取らずに自由に読んでください。

## タスクの進め方
1. 原因の分析を行う。
2. 原因が確定した場合: コードを直接編集・修正し、そのまま `npm run build` を実行してビルドを確認する。
3. 原因が仮説段階の場合: テスト用スクリプト作成、または検証用ログを仕込む。
4. 状況が明確でない場合: ユーザーに質問する。
- 作業中に不明点や、ユーザーが決めるべき判断（機能を消すか残すか、対応バージョン、挙動が変わる修正など）が出てきたら、推測で押し通さずに質問すること。

## コメントの書き方
extensions.gnome.org (EGO) のレビューでは「AI 生成らしさ」が却下理由になるため、コード内コメントは次のとおりに書く。
- 英語で書く（`src/`・`extension.js`・`preferences/`・`shaders/`・`stylesheet.css` すべて）。
- 「なぜそうするか」を短く（基本は 1〜3 行）書く。コードを読めばわかる「何をしているか」の逐語訳や、
  構文の説明は書かない。名前で伝わるならコメントを書かない。
- `[FIX]`・`[FIX round 12]`・`[FIX-5]`・`[PERF B1]`・`[DIAG]`・`[NEW]`・`[CHANGED]` などのタグを付けない。
- 変更の経緯（「以前は〜だった」「This used to…」「round N で〜」）は書かない。経緯はコミットメッセージと memo.md に書く。
- `memo.md`・`performance-plan.md`・`追記N`・`地雷N`・`①〜⑤` など、リポジトリに無い資料や内部の番号を参照しない。
- `IMPORTANT:`・`CRITICAL:`・`NOTE:`・`DO NOT …` のような、LLM への指示に見える書き方をしない。強調のための全大文字も避ける。
- 装飾的な区切り線（`// ─── Section ───`・`/* ===== */`）や絵文字を使わない。
- 1 行は 200 文字以内（EGO のベストプラクティス）。

## EGO 提出用コードのルール
- `destroy()`・`disconnect()`・`GLib.Source.remove()` など、通常は例外を投げない API を try-catch で囲まない。
  try-catch は GError を投げる API（ファイル読み込み、D-Bus、JSON.parse など）にだけ使う。
  例外は毎フレーム回るループで、1 つの失敗が他を止めないよう catch して `reportFrameLoopError()`（5 秒に 1 回に間引き）に渡す。
- GNOME 50 に確実に存在する API を `typeof x.foo === 'function'`・`x.foo?.()`・`if (x.foo)` で確認しない。
- `_destroyed`・`_active` のようなライフサイクルのガード用フラグを作らない。後始末はソースの削除とシグナルの切断で完結させる。
- `enable()` で作ったもの（`global` に置いたオブジェクトも含む）は `disable()` で必ず消す。
- `this.getSettings()` は引数なしで呼ぶ（スキーマ ID は `metadata.json` の `settings-schema`）。
- ログは `output-logs` 設定でゲートした logger を通す。無条件の `console.log` は置かない。
- 提出用 zip は `npm run pack`（`liquid-glass@thinkingcoding1231.gmail.com` 内で実行）で作る。TS ソース・`gschemas.compiled`・
  未使用のアイコンは含めない。作ったら `shexli <zip の絶対パス>` で確認する
  （shexli は tree-sitter 0.26 と組み合わせるとセグフォルトするので、`uv tool install --python 3.12 shexli --with 'tree-sitter==0.25.2'` で入れる）。

## Looking Glass スクリプト作成ルール
- `Clutter` や `Cogl` などを明示的にインポートしない。`imports.gi`でインポートもしない。`Clutter`のように、最初からそのまま使う。
- トップレベルのベタ書きスタイルで記述すること。
- **結果は必ず最後に `log()` で出力すること。** 末尾に `<変数名>;` と書くだけでは不可
  （Looking Glass の結果欄には出ても journal には残らず、あとから追えないため）。
  複数行にまとめるときは `log([...].join('\n'))` のように 1 回の `log()` にする。
- **必ず「1行版」も併せて作成すること。** 改行なしでそのまま Looking Glass の
  入力欄に貼れる形。コメント・整形・余分な変数は削り、複数文は `;` で繋ぐ。
  複数行版（読む用）と 1行版（貼る用）の両方を必ず提示する。ファイルとして保存する必要はなく、チャット内で示すこと。

## その他
- ユーザーが示した観察を、その時点でうまく説明することができなくても、それをユーザーの視覚的な誤解として扱わない。
