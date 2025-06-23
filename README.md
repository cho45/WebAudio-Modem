WebAudio Modem
==============

This modem implementation with WebAudio (written in JavaScript).


Current
=======

 * [FSK]( ./FSK/fsk.js  )

TODO
====

 * DPSK
 * QPSK
 * QAM

# XModem パケット構造と制御キャラクタ一覧

## パケット構造（アスキーアート）

```
+-----+-----+-------+-------+----------+--------+
| SOH | SEQ | ~SEQ  | LEN   | PAYLOAD  | CRC16  |
+-----+-----+-------+-------+----------+--------+
|0x01 |1-255|0-255  |0-255  |0-255byte |2byte   |
+-----+-----+-------+-------+----------+--------+
```
- SOH: Start of Header (0x01)
- SEQ: シーケンス番号（1-255）
- ~SEQ: SEQのビット反転（エラー検出用）
- LEN: ペイロード長（0-255）
- PAYLOAD: データ本体
- CRC16: CRC-16-CCITT チェックサム（2バイト）

## 制御キャラクタ一覧

| 名前   | 16進 | 意味                       |
|--------|------|----------------------------|
| ACK    | 0x06 | Acknowledge（肯定応答）    |
| NAK    | 0x15 | Negative Ack（再送要求）   |
| EOT    | 0x04 | End of Transmission（終了）|
| ENQ    | 0x05 | Enquiry（状態問い合わせ）  |
| CAN    | 0x18 | Cancel（中断/中止）        |

- 制御キャラクタは1バイト単体で送信され、パケット構造は持ちません。

