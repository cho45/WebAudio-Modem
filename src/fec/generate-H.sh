#!/bin/bash

# 正しいLDPC H行列生成スクリプト
# protograph regular_rate_1_2 は 4行8列 (rate=1/2)
# expansion-factor を正しく計算: 目標n値 / 8

PROTOGRAPH_LDPC_PATH=./ProtographLDPC
PROTOGRAPH_FILE=$PROTOGRAPH_LDPC_PATH/sample-protographs/regular_rate_1_2

echo "Generating correct LDPC H matrices..."

# n=128, k=64: expansion-factor = 128/8 = 16
echo "Generating n=128, k=64..."
python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n128_k64_correct.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 16 \
	--n-bits 128 --n-checks 64
node bin/translate-pchk.js ldpc_h_matrix_n128_k64_correct.pchk src/fec/ldpc_h_matrix_n128_k64_correct.json

# n=256, k=128: expansion-factor = 256/8 = 32  
echo "Generating n=256, k=128..."
python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n256_k128_correct.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 32 \
	--n-bits 256 --n-checks 128
node bin/translate-pchk.js ldpc_h_matrix_n256_k128_correct.pchk src/fec/ldpc_h_matrix_n256_k128_correct.json

# n=512, k=256: expansion-factor = 512/8 = 64
echo "Generating n=512, k=256..." 
python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n512_k256_correct.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 64 \
	--n-bits 512 --n-checks 256
node bin/translate-pchk.js ldpc_h_matrix_n512_k256_correct.pchk src/fec/ldpc_h_matrix_n512_k256_correct.json

# n=1024, k=512: expansion-factor = 1024/8 = 128
echo "Generating n=1024, k=512..."
python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n1024_k512_correct.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 128 \
	--n-bits 1024 --n-checks 512
node bin/translate-pchk.js ldpc_h_matrix_n1024_k512_correct.pchk src/fec/ldpc_h_matrix_n1024_k512_correct.json

echo "All correct LDPC H matrices generated!"