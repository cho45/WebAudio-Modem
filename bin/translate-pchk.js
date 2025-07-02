import fs from 'fs';
import path from 'path';

/**
 * Pythonのintio_write関数によって書き込まれた4バイトのバイナリデータから整数値を読み込む
 * @param {Buffer} buffer - 読み込むバイナリデータを含むBuffer
 * @param {number} offset - 読み込みを開始するオフセット
 * @returns {{value: number, newOffset: number}} - 読み込んだ整数値と次の読み込み開始オフセット
 */
function readIntioValue(buffer, offset) {
    let value = 0;
    // Pythonのintio_writeはリトルエンディアンで4バイト書き込む
    // 最初の3バイト
    value |= buffer.readUInt8(offset) << 0;
    value |= buffer.readUInt8(offset + 1) << 8;
    value |= buffer.readUInt8(offset + 2) << 16;

    // 4バイト目 (符号拡張を考慮)
    const fourthByte = buffer.readUInt8(offset + 3);
    // Pythonのintio_writeの4バイト目の処理は、valueが負の場合に256を加算しているため、
    // JavaScript側では符号付き32ビット整数として読み込むことで対応できる
    value |= fourthByte << 24;

    // JavaScriptの数値は64ビット浮動小数点数なので、32ビット符号付き整数に変換し直す
    // これにより、Pythonのintio_writeが書き込んだ負の値も正しくデコードされる
    value = value >> 0; // 符号付き32ビット整数に変換

    return { value, newOffset: offset + 4 };
}

/**
 * .pchkファイルを読み込み、H行列の情報を抽出する
 * @param {string} filePath - .pchkファイルのパス
 * @returns {object | null} - H行列の高さ、幅、および接続情報を含むオブジェクト、またはエラーの場合はnull
 */
function parsePchkFile(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        let offset = 0;

        // 1. マジックナンバーの読み込み
        let result = readIntioValue(buffer, offset);
        const magicNumber = result.value;
        offset = result.newOffset;

        // Pythonのwrite_graph_to_fileで書き込まれるマジックナンバーは (ord('P') << 8) + 0x80
        // ord('P') は 80, 80 << 8 = 20480
        // 20480 + 128 = 20608
        if (magicNumber !== 20608) {
            console.error(`Error: Invalid .pchk file format. Magic number mismatch. Expected 20608, got ${magicNumber}.`);
            return null;
        }

        // 2. height (n_checks) の読み込み
        result = readIntioValue(buffer, offset);
        const height = result.value;
        offset = result.newOffset;

        // 3. width (n_bits) の読み込み
        result = readIntioValue(buffer, offset);
        const width = result.value;
        offset = result.newOffset;

        const hMatrixConnections = []; // H行列の接続情報を格納する配列

        // 4. タナーグラフの接続情報の読み込み
        // 0が読み込まれるまでループ
        while (offset < buffer.length) {
            result = readIntioValue(buffer, offset);
            const nodeValue = result.value;
            offset = result.newOffset;

            if (nodeValue === 0) { // 終端マーカー
                break;
            }

            if (nodeValue < 0) { // チェックノードの開始マーカー (Pythonでは -(key + 1) で書き込まれる)
                const checkNodeIndex = -(nodeValue + 1);
                // このチェックノードに接続するビットノードを読み込む
                while (offset < buffer.length) {
                    result = readIntioValue(buffer, offset);
                    const connectedValue = result.value;
                    offset = result.newOffset;

                    if (connectedValue <= 0) { // 次のチェックノードの開始、または終端マーカー
                        offset -= 4; // 読みすぎた分を戻す
                        break;
                    }
                    // ビットノードのインデックス (Pythonでは (value + 1) で書き込まれる)
                    const bitNodeIndex = connectedValue - 1;
                    hMatrixConnections.push({ check: checkNodeIndex, bit: bitNodeIndex });
                }
            } else {
                console.error("Error: Unexpected positive value in Tanner graph section before 0 terminator.");
                return null;
            }
        }

        return {
            height,
            width,
            connections: hMatrixConnections
        };

    } catch (error) {
        console.error("Error reading or parsing .pchk file:", error);
        return null;
    }
}

// コマンドライン引数の処理
const args = process.argv.slice(2);
if (args.length !== 2) {
    console.log("Usage: node bin/translate-pchk.js <input_pchk_file> <output_json_file>");
    process.exit(1);
}

const inputPchkFile = path.resolve(args[0]);
const outputJsonFile = path.resolve(args[1]);

console.log(`Parsing ${inputPchkFile}...`);
const hMatrixData = parsePchkFile(inputPchkFile);

if (hMatrixData) {
    try {
        fs.writeFileSync(outputJsonFile, JSON.stringify(hMatrixData, null, 2));
        console.log(`Successfully converted to ${outputJsonFile}`);
        console.log(`H Matrix: Height=${hMatrixData.height}, Width=${hMatrixData.width}, Connections=${hMatrixData.connections.length}`);
    } catch (error) {
        console.error(`Error writing output JSON file: ${error}`);
        process.exit(1);
    }
} else {
    console.error("Failed to parse .pchk file.");
    process.exit(1);
}
