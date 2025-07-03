#!/bin/bash

# 正しいLDPC H行列生成スクリプト
# protograph regular_rate_1_2 は 4行8列 (rate=1/2)
# expansion-factor を正しく計算: 目標n値 / 8

PROTOGRAPH_LDPC_PATH=./ProtographLDPC
PROTOGRAPH_FILE=$PROTOGRAPH_LDPC_PATH/sample-protographs/ar4ja_n_0_rate_1_2_sparse
TRANSMITTED_BITS=4

echo "Generating correct LDPC H matrices..."

for n in 128 256 512 1024; do
    expansion_factor=$((n / TRANSMITTED_BITS))
    k=$((n / 2))
    echo "Generating n=${n}, k=${k}... expansion-factor=${expansion_factor}"
    python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
        --output-pchk-file ldpc_h_matrix_n${n}_k${k}.pchk \
        --code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
        --expansion-factor ${expansion_factor}
    node bin/translate-pchk.js ldpc_h_matrix_n${n}_k${k}.pchk src/fec/ldpc_h_matrix_n${n}_k${k}.json

done

echo "All correct LDPC H matrices generated!"
