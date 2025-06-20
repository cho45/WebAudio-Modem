# FSK復調の理論と正しい実装

## FSK（Frequency Shift Keying）の理論

FSKは2つの異なる周波数を使ってデジタル信号を表現する変調方式：
- **Mark周波数** (f₁): ビット"1"を表現（例：1650Hz）
- **Space周波数** (f₂): ビット"0"を表現（例：1850Hz）

## 理論的に正しいFSK復調プロセス

### 1. I/Q復調（複素ベースバンド変換）
入力信号 `s(t)` を中心周波数 `fc = (f₁ + f₂)/2` で復調：

```
I(t) = s(t) × cos(2πfc·t)
Q(t) = s(t) × sin(2πfc·t)
```

これにより複素ベースバンド信号 `z(t) = I(t) + jQ(t)` を生成

### 2. 瞬時位相の計算
複素信号から瞬時位相を求める：

```
φ(t) = atan2(Q(t), I(t))
```

### 3. 瞬時周波数の計算（周波数判別）
隣接サンプル間の位相差が瞬時周波数：

```
Δφ[n] = φ[n] - φ[n-1]
```

位相の折り返し処理：
```
if Δφ > π:  Δφ -= 2π
if Δφ < -π: Δφ += 2π
```

### 4. ビット判定
瞬時周波数の符号でmark/spaceを判別：
- `Δφ > 0`: 周波数上昇 → Space (f₂) → ビット"0" 
- `Δφ < 0`: 周波数下降 → Mark (f₁) → ビット"1"

## 元の実装の構造

元の動作していた実装は以下のクラス構成：

1. **IQDemodulator**: 中心周波数での I/Q復調
2. **PhaseDetector**: 瞬時位相と位相差の計算
3. **I/Qフィルタ**: ローパスフィルタでエイリアシング除去
4. **ポストフィルタ**: 最終的なノイズ除去

## 正しい実装のポイント

### I/Q復調の実装
```typescript
// 中心周波数での I/Q復調
const centerFreq = (markFreq + spaceFreq) / 2;
const omega = 2 * Math.PI * centerFreq / sampleRate;

for (let n = 0; n < samples.length; n++) {
  i[n] = samples[n] * Math.cos(localOscPhase);
  q[n] = samples[n] * Math.sin(localOscPhase);
  localOscPhase += omega;
  if (localOscPhase > 2 * Math.PI) {
    localOscPhase -= 2 * Math.PI;
  }
}
```

### 位相差計算の実装
```typescript
for (let n = 0; n < i.length; n++) {
  // 瞬時位相
  const phase = Math.atan2(q[n], i[n]);
  
  // 位相差（瞬時周波数）
  let phaseDiff = phase - lastPhase;
  
  // 位相折り返し処理
  if (phaseDiff > Math.PI) {
    phaseDiff -= 2 * Math.PI;
  } else if (phaseDiff < -Math.PI) {
    phaseDiff += 2 * Math.PI;
  }
  
  // 周波数判別
  const bit = phaseDiff < 0 ? 1 : 0; // 負=Mark(1), 正=Space(0)
  
  lastPhase = phase;
}
```

## 重要な注意点

1. **位相の連続性**: `localOscPhase` と `lastPhase` の状態管理が重要
2. **フィルタリング**: I/Qデータにローパスフィルタを適用してエイリアシングを除去
3. **ビット同期**: samplesPerBitでの多数決判定
4. **無音検出**: 振幅データを使った無音検出

この理論に基づいて、元の動作していた実装の構造を保持しつつ、サンプル単位処理に変更する。