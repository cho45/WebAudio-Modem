# 高度なエラー訂正を持つ復調器・データフレーム伝送の設計メモ（2025/06整理）

## 目的

ノイズ・歪みの多い環境下でも高信頼なデータ伝送を実現するため、
- ソフト判定復調（Soft-Decision Demodulation）
- 前方誤り訂正（FEC）
- データフレーミング（フレーム境界検出・誤り検出・再送制御）
を組み合わせたストリーム指向の設計・実装指針をまとめる。

---

## 設計要求要件（要約）

- ストリーム処理・低遅延（小単位サンプルで逐次処理、即時通知）
- 変調・復調方式の差し替え容易性（FSK/BPSK/QPSK等、1シンボル=1bit/2bit...）
- FEC・フレーマの抽象化と統合
- データフレーム境界検出の堅牢性（プレアンブル/SFD/CRC等）
- エラー通知・再送制御のフック
- パラメータ自動調整（SNR/レート/信号レベル等）
- テスト容易性・ロギング
- ビット列はUint8Array（バイト単位）で効率的に扱い、有効データ長（バイト長）はDataFrameFramerが管理

---

## 推奨アーキテクチャと責務分離（概要）

- 各層は「バイト列（Uint8Array）」を基本単位として受け渡し、端数ビット（パディング）はmodulatorが付加し、demodulatorがそのまま復元する。
- DataFrameFramerはフレームヘッダ等で有効データ長（バイト長）を必ず管理し、パディング分を除去して正しいデータを上位層に渡す。
- 各層の責務は下記インターフェース例のコメントに明記。

---

## データフロー（受信側例）

1. `process(samples)`
2. → SoftDecisionDemodulator.demodulate
3. → FECDecoder.decode
4. → DataFrameFramer.extractFrames
5. → onFrameコールバックで上位層へ通知

- 各段階でbitLengthを明示的に管理・伝播
- 1シンボル=複数ビットのパッキング・アンパッキングやパディング付加はModulator/SoftDecisionDemodulatorの責務。ただし、ビット列は常にUint8Array（バイト単位）で扱い、端数ビット（パディング）はmodulatorが付加し、demodulatorがそのまま復元する。DataFrameFramerはデータフレームのヘッダ等で「有効データ長（バイト長）」を必ず管理し、パディング分を除去して正しいデータを上位層に渡す責務を持つ。
- バッファリング・部分フレーム対応も責務分離

---

## インターフェース例（責務コメント付き・バイト単位設計）

```ts
// 変調器: バイト列を変調方式に応じて信号化。端数ビットはパディングして出力する責務。
// bitsPerSymbolはインスタンス設定プロパティ（API引数ではない）
interface Modulator {
  readonly bitsPerSymbol: number;
  modulate(payload: Uint8Array): Float32Array;
}

// 復調器: 信号からsoft value列（バイト列）を復元するのみ。フレーム境界検出は責務外。
// bitsPerSymbolはインスタンス設定プロパティ（API引数ではない）
interface SoftDecisionDemodulator {
  readonly bitsPerSymbol: number;
  demodulate(samples: Float32Array): Uint8Array;
}

// FrameEncoder: ペイロードをフレーム化し、FEC符号化まで一括で行う（送信側統合層）。
interface FrameEncoder {
  encodeFrame(payload: Uint8Array): Uint8Array;
}

// FrameDecoder: soft value列からフレーム境界検出・FEC復号・フレーム抽出まで一括で行う（受信側統合層）。
// 連続したsoft value列から複数フレームを抽出可能。部分データは内部バッファリング。
interface FrameDecoder {
  /**
   * soft value列を追加投入し、復号済みフレームがあれば返す（なければ空配列）。
   * 内部でフレーム境界検出・FEC復号・フレーム抽出を一括管理。
   */
  process(samples: Float32Array): Uint8Array[];
  /**
   * 内部状態を初期化
   */
  reset(): void;
}
```

---

## 備考・設計指針
- number[]ではなくUint8Array/Float32Arrayで統一
- bitsPerSymbolは変調方式ごとに明示
- FECやフレーマは部分バイト対応・bitLength管理必須
- ストリーム処理はバッファリング・部分フレーム対応を内部で吸収
- 責務分離を徹底し、各層のテスト容易性・交換性を担保

- FECとフレーマ（DataFrameFramer）は、特に受信側で密結合な処理が不可避であり、実装・テストも一体化（FrameDecoder/FrameEncoder等）するのが現実的。
- インターフェース分離は理論上の責務分離や将来の交換性のためだが、実装・テストは統合クラスで行うのが自然。
- テストも「FEC＋フレーマ一体型」の統合テストが主となる。

---

## 同期（プリアンブル検出）の重要性と代表的なアルゴリズム

- FEC復号（特にブロック型やViterbi復号）を正しく機能させるには、まず「ビット/シンボル境界の同期」が不可欠。
- 同期が取れていないと、FEC復号の前提が崩れ、誤り訂正が正しく機能しない。
- ストリーム型FECでも、同期が取れていないと誤りが連鎖しやすくなる。

### 代表的なプリアンブル同期アルゴリズム・戦略

- **相関法（Correlation Method）**
  - 既知のビット列（プリアンブル）と受信信号の相関値を計算し、ピーク位置で同期を取る。
  - ソフト判定値を使うことでSNRの低い環境でも堅牢。

- **自己相関法（Autocorrelation）**
  - プリアンブルが繰り返しパターンの場合、自己相関を利用して周期的なピークで同期。

- **マルチレベルしきい値法**
  - 相関値が複数のしきい値を超えた場合のみ同期成立とみなすことで誤検出を低減。

- **連続一致カウント法**
  - 一定数以上連続してプリアンブル一致が観測された場合のみ同期成立とする。

- **複数候補追跡・再同期戦略**
  - 誤検出や未検出時に複数の同期候補を同時に追跡し、最適なものを選択。
  - データ途中で同期が外れた場合の再同期処理も重要。

- **ソフト判定値の活用**
  - バイナリ一致だけでなく、soft value（信頼度）を加味した相関計算で堅牢性向上。

- **外部クロック同期**
  - 送信側・受信側が共通のクロック源（例：GPS時刻、NTP、専用クロック線）を参照し、
    例えば「毎秒の立ち上がりをビット/フレーム境界」とみなす。
  - 放送・衛星通信・一部の有線通信などで利用。

- **タイムスロット同期（TDMA等）**
  - システム全体で「時刻スロット」を共有し、各スロットの開始をビット/フレーム境界とする。

#### 備考
- クロック同期方式は信号内容に依存せず、高速・確実な同期が可能。
- クロック精度・ジッタ・ドリフトや外部同期信号の配線・配信が課題となる。
- 一般的な無線・インターネット通信では信号内容による同期（プリアンブル等）が主流だが、特定用途では外部クロック同期も有効。

### 備考
- プリアンブルは十分な長さ・ランダム性・自己相関特性を持つパターンが望ましい。
- 同期処理はFEC復号の前段で必ず実施し、同期成立後にFEC復号・フレーム抽出を行う。
- 実装上は「同期→FEC復号→フレーム抽出」の順で処理フローを設計する。

---

## 参考文献・リンク
- [Viterbi Algorithm](https://en.wikipedia.org/wiki/Viterbi_algorithm)
- [LDPC Codes](https://en.wikipedia.org/wiki/Low-density_parity-check_code)
- [Soft-decision decoding](https://en.wikipedia.org/wiki/Soft-decision_decoding)

---

## 代表的なFECアルゴリズムと必要情報

- **ブロック符号**（Reed-Solomon, BCH, Hamming など）
  - 固定長のデータブロックごとに冗長ビットを付加し、誤り訂正を行う。
  - 必要情報: ブロック長（データ長・符号長）、ブロック境界、有効データ長（パディング情報）
  - 例: RS(255,223) はデータ223バイト＋パリティ32バイト＝255バイトで1ブロック

- **畳み込み符号＋Viterbi復号**
  - データをシフトレジスタで逐次符号化し、Viterbiアルゴリズムで復号。
  - 必要情報: 符号化レート、生成多項式、データ開始・終了位置（トレリス終端処理）
  - ストリーム復号可能だが、フレーム単位でリセットやflushが必要な場合あり

- **LDPC符号（Low-Density Parity-Check）**
  - 疎なパリティ検査行列を用いたブロック符号。高い訂正能力。
  - 必要情報: パリティ検査行列（H行列）、符号長・データ長、ブロック境界

- **ターボ符号**
  - 2つ以上の畳み込み符号とインタリーバを組み合わせた高性能FEC。
  - 必要情報: 符号化パラメータ（インタリーバ、レート等）、ブロック境界

- **共通して必要な情報**
  - ブロック/フレーム境界、有効データ長、FECパラメータ（符号長・レート等）、soft value列（ソフト判定復号時）

---

（このメモは今後の設計・実装・議論のたたき台とする）
