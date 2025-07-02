
# Using https://github.com/shubhamchandak94/ProtographLDPC
#| LDPC n種別 | LDPC符号長n | BCH符号           | BCH情報ビット長k | 入力バイト数 (k/8, 切り上げ) | BCHパリティ長 | BCH出力長 | パディング | バイト長（n/8） |
#|:----------:|:-----------:|:------------------|:----------------|:----------------------------|:-------------|:----------|:-----------|:---------------|
#| 00         | 128         | BCH(127,120,1)    | 120             | 15                         | 7            | 127       | 1bit       | 16             |
#| 01         | 256         | BCH(255,247,1)    | 247             | 31                         | 8            | 255       | 1bit       | 32             |
#| 10         | 512         | BCH(511,502,1)    | 502            | 63                         | 9            | 511       | 1bit       | 64             |
#| 11         | 1024        | BCH(1023,1013,1)  | 1013            | 127                        | 10           | 1023      | 1bit       | 128            |


PROTOGRAPH_LDPC_PATH=./ProtographLDPC
PROTOGRAPH_FILE=$PROTOGRAPH_LDPC_PATH/sample-protographs/regular_rate_1_2

python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n128_k64.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 32 \
	--n-bits 128 --n-checks 64
node bin/translate-pchk.js ldpc_h_matrix_n128_k64.pchk src/fec/ldpc_h_matrix_n128_k64.json

python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n256_k128.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 64 \
	--n-bits 256 --n-checks 128
node bin/translate-pchk.js ldpc_h_matrix_n256_k128.pchk src/fec/ldpc_h_matrix_n256_k128.json

python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n512_k256.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 128 \
	--n-bits 512 --n-checks 256
node bin/translate-pchk.js ldpc_h_matrix_n512_k256.pchk src/fec/ldpc_h_matrix_n512_k256.json

python $PROTOGRAPH_LDPC_PATH/LDPC-library/make-pchk.py \
	--output-pchk-file ldpc_h_matrix_n1024_k512.pchk \
	--code-type protograph --construction quasi-cyclic --protograph-file $PROTOGRAPH_FILE \
	--expansion-factor 256 \
	--n-bits 1024 --n-checks 512
node bin/translate-pchk.js ldpc_h_matrix_n1024_k512.pchk src/fec/ldpc_h_matrix_n1024_k512.json
