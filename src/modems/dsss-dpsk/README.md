# DSSS-DPSK モデム同期に関するメモ

このドキュメントは、DSSS-DPSK モデムの実装における同期、特に `findSyncOffset` 関数と DPSK 変調の性質に関する重要な考慮事項をまとめたものです。

## DPSK と「位相同期不要」

DPSK (差動位相偏移変調) は、受信機で「位相同期」を必要としないとよく言われます。これは、データ復調のために、受信機が搬送波信号の絶対位相を追跡する必要がないことを指します。代わりに、情報は現在のシンボルの位相と前のシンボルの位相との「差分」で符号化されます。これにより、DPSK は通信チャネルにおける緩やかな位相ドリフトに対して堅牢になります。なぜなら、絶対位相ではなく位相の「変化」のみが重要だからです。

## `findSyncOffset` の役割

DPSK がデータ復調に絶対位相同期を必要としないという特性を持っているにもかかわらず、`findSyncOffset` 関数は**タイミング同期**、そして暗黙的に**搬送波周波数同期**において重要な役割を果たします。

`findSyncOffset` は、マッチドフィルタのアプローチを使用して以下を行います。
1.  **タイミング同期**: 受信信号内で既知のプリアンブル (同期シーケンス) がどこから始まるか、その正確なサンプルオフセットを特定します。
2.  **搬送波周波数同期**: 受信信号と特定の搬送波周波数で変調された参照信号との相関を取ることで、受信信号が実際に期待される搬送波周波数で変調されていることを暗黙的に検証します。

マッチドフィルタは、受信信号とローカルで生成された参照信号との間の最大相互相関を見つけることで動作します。このプロセスは、送信信号と受信信号の間に任意の定数位相オフセットがある場合でも効果的です。なぜなら、相関はプリアンブルの絶対位相ではなく、その*相対的な*位相パターンに敏感だからです。

## プリアンブル設計と同期戦略

この DSSS-DPSK 実装では、`dsssSpread` 関数はビット `0` を元の M シーケンスにマッピングし、ビット `1` を反転した M シーケンスにマッピングします。その後、`dpskModulate` 関数はこれらのチップに基づいて差動位相シフトを適用します。

同期のための重要な設計上の決定は、プリアンブルの構成です。もし**上位レイヤープロトコルが、プリアンブルが常に `0` ビットのシーケンスで構成されることを保証している** (例: 4 ビットの `0`) ならば、以下のようになります。

*   送信されるプリアンブルのチップシーケンスは、常に元の M シーケンス (各 `0` ビットに対して繰り返される) となります。
*   `findSyncOffset` 関数は、この既知の `0` ビット M シーケンスに基づいて単一の参照信号を効率的に生成し、相関を実行できます。このアプローチは、このような厳密なプロトコル保証の下では、有効かつ計算効率が良いです。

この戦略は、特定のプリアンブル設計を活用して同期プロセスを簡素化します。これにより、プリアンブルが任意のビットで構成される可能性がある場合や、`0` ビットの保証がない場合に必要となる、複数の可能なプリアンブルパターン (例: `0` ビットと `1` ビットの両方) との相関を取る必要がなくなります。

## DSSS-DPSK デモジュレータの状態遷移

以下に、`DsssDpskDemodulator` クラスの状態遷移を示します：

```mermaid
stateDiagram-v2
    [*] --> Idle: 初期化
    
    Idle --> Sync_Search: addSamples()
    note right of Sync_Search
        十分なサンプル数 >= samplesPerBit
        _trySync()実行
    end note
    
    Sync_Search --> Synchronized: findSyncOffset()成功
    note right of Synchronized
        同期検出成功
        - syncState.locked = true
        - sampleOffset設定
        - correlation記録
    end note
    
    Sync_Search --> Sync_Search: findSyncOffset()失敗
    note left of Sync_Search
        サンプル消費して再試行
        samplesPerBit/2 消費
    end note
    
    Synchronized --> Bit_Processing: サンプル >= samplesPerBit
    note right of Bit_Processing
        _processBit()実行
        - キャリア復調
        - DPSK復調  
        - DSSS逆拡散
        - LLR計算
    end note
    
    Bit_Processing --> Quality_Check: LLR計算成功
    note right of Quality_Check
        _updateSyncQuality()実行
        LLR品質評価
    end note
    
    Quality_Check --> Strong_Bit: |LLR| >= WEAK_THRESHOLD
    note right of Strong_Bit
        強いビット検出
        - consecutiveWeakCount = 0
        - resyncCounter++
    end note
    
    Quality_Check --> Weak_Bit: |LLR| < WEAK_THRESHOLD
    note left of Weak_Bit
        弱いビット検出
        consecutiveWeakCount++
    end note
    
    Strong_Bit --> Resync_Attempt: LLR > STRONG_ZERO_THRESHOLD && resyncCounter > RESYNC_TRIGGER_COUNT
    note right of Resync_Attempt
        強い0ビット検出
        _tryResync()実行
        微細な同期調整
    end note
    
    Strong_Bit --> Synchronized: 通常の強いビット
    
    Resync_Attempt --> Synchronized: 再同期成功
    note right of Synchronized
        同期位置微調整
        resyncCounter = 0
    end note
    
    Resync_Attempt --> Synchronized: 再同期失敗
    note left of Synchronized
        現在の同期を維持
    end note
    
    Weak_Bit --> Sync_Loss: consecutiveWeakCount >= CONSECUTIVE_WEAK_LIMIT && 要求ビット処理完了
    note left of Sync_Loss
        連続弱ビット限界
        上位層要求がない場合
    end note
    
    Weak_Bit --> Synchronized: 上位層要求ビット処理中
    note right of Synchronized
        要求ビット数未完了
        同期維持
    end note
    
    Bit_Processing --> Sync_Loss: デモジュレーション失敗
    note left of Sync_Loss
        _loseSyncDueToError()
        - syncState.locked = false
        - サンプル消費
    end note
    
    Sync_Loss --> Idle: 同期喪失
    note left of Idle
        同期状態リセット
        次のgetAvailableBits()で
        再同期開始
    end note
    
    Synchronized --> Synchronized: サンプル不足
    note right of Synchronized
        availableSamples < samplesPerBit
        待機状態
    end note
    
    state Quality_Check {
        [*] --> LLR_Evaluation
        LLR_Evaluation --> Target_Bit_Check: 弱いビット検出
        Target_Bit_Check --> Keep_Sync: targetCount > 0 && processedCount < targetCount
        Target_Bit_Check --> Weak_Bit_Count: 要求ビット処理完了
        Keep_Sync --> [*]: 同期維持
        Weak_Bit_Count --> [*]: 弱ビットカウント更新
    }
```

### 状態の詳細説明

**主要状態:**
- **Idle**: 初期状態、同期未確立
- **Sync_Search**: 同期検索中、マッチドフィルタによる相関検出
- **Synchronized**: 同期確立済み、ビット処理準備完了
- **Bit_Processing**: 1ビット分のデモジュレーション処理中
- **Quality_Check**: LLR品質評価による同期状態更新
- **Strong_Bit**: 強いビット検出、同期品質良好
- **Weak_Bit**: 弱いビット検出、同期品質低下
- **Resync_Attempt**: 微細な再同期試行（強い0ビット検出時）
- **Sync_Loss**: 同期喪失、再同期が必要

**重要なパラメータ:**
- `WEAK_THRESHOLD`: 弱いビット判定閾値（20）
- `CONSECUTIVE_WEAK_LIMIT`: 連続弱ビット限界（3）
- `STRONG_ZERO_THRESHOLD`: 強い0ビット閾値（50）
- `RESYNC_TRIGGER_COUNT`: 再同期トリガー数（8）

この状態遷移図は、DSSS-DPSK デモジュレータの堅牢な同期管理と適応的な品質制御を示しています。
